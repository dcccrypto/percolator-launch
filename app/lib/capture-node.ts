/**
 * Dependency-free DOM→PNG capture for the PnL share card.
 *
 * The card (components/share/PnlShareCard) is authored with INLINE styles and
 * concrete colours (no CSS vars / color-mix), so it serialises cleanly inside an
 * SVG <foreignObject>; we inline the background scene and the logo as data URIs
 * (same-origin bg in public/, logo via the same-origin /api/token-logo proxy) so
 * the canvas is never tainted, then rasterise to a PNG blob.
 *
 * Fonts: the SVG render falls back to the card's monospace fallback stack (the
 * app CSS var can't resolve in the sandboxed image), so the export is best-effort
 * on typography — everything else is pixel-accurate. Every function fails soft.
 */

async function toDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { mode: "cors", cache: "force-cache" });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string | null>((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(typeof r.result === "string" ? r.result : null);
      r.onerror = () => resolve(null);
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/** Rasterise a card node to a PNG blob at `scale`× for crispness. Throws on failure. */
export async function captureCardToBlob(node: HTMLElement, scale = 2): Promise<Blob> {
  // offsetWidth/Height are the card's own layout size (560), unaffected by any
  // parent `transform: scale()` the modal applies for display — unlike
  // getBoundingClientRect(), which would return the scaled-down size.
  const w = node.offsetWidth || Math.round(node.getBoundingClientRect().width);
  const h = node.offsetHeight || Math.round(node.getBoundingClientRect().height);

  const clone = node.cloneNode(true) as HTMLElement;
  clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");

  // Inline the background-image url(...) → data URI (else fall back to a gradient).
  const m = clone.style.backgroundImage && clone.style.backgroundImage.match(/url\(["']?(.*?)["']?\)/);
  if (m && m[1] && !m[1].startsWith("data:")) {
    const d = await toDataUrl(m[1]);
    clone.style.backgroundImage = d
      ? `url("${d}")`
      : "radial-gradient(120% 120% at 100% 0%, #3b1d6e 0%, #140a2e 55%, #060410 100%)";
  }

  // Inline every <img> src → data URI; drop any that can't be fetched.
  await Promise.all(
    Array.from(clone.querySelectorAll("img")).map(async (img) => {
      const src = img.getAttribute("src");
      if (src && !src.startsWith("data:")) {
        const d = await toDataUrl(src);
        if (d) img.setAttribute("src", d);
        else img.remove();
      }
    }),
  );

  const xml = new XMLSerializer().serializeToString(clone);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<foreignObject width="100%" height="100%">${xml}</foreignObject></svg>`;
  const svgUrl = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);

  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Could not render the card image"));
    img.src = svgUrl;
  });

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, w * scale);
  canvas.height = Math.max(1, h * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not available");
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0, w, h);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not encode the image"))), "image/png");
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export async function copyBlobToClipboard(blob: Blob): Promise<boolean> {
  try {
    const CI = (window as unknown as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
    if (!CI || !navigator.clipboard?.write) return false;
    await navigator.clipboard.write([new CI({ [blob.type]: blob })]);
    return true;
  } catch {
    return false;
  }
}
