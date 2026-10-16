/**
 * Pieces of the share token's image (`GET /api/earn-share/<market>/image`): a safe logo fetch and the raster guards. The logo is
 * CREATOR-SUPPLIED content, so it is fetched only from an allowlisted https host (no redirects, a short timeout, a byte cap), sniffed by its
 * bytes (never by Content-Type), checked for a sane pixel size (a small file can decode to a huge bitmap), and then re-encoded by the PNG
 * renderer: the response never redirects to, nor passes through, a third-party URL.
 */
import { Buffer } from "node:buffer";
import { detectRasterImage } from "@/lib/raster-image-bytes";
import { LOGO_MAX_BYTES, isFetchableLogoUrl } from "./earn-share-meta";

/** Longest side, in pixels, the renderer will decode. */
export const LOGO_MAX_SIDE_PX = 2048;
const FETCH_TIMEOUT_MS = 3_000;

/** Width and height of a PNG or JPEG from its header, or null (not one of those, or truncated). */
export function rasterDimensions(buf: Buffer): { width: number; height: number } | null {
  const fmt = detectRasterImage(buf);
  if (fmt?.ext === "png") {
    if (buf.length < 24 || buf.subarray(12, 16).toString("ascii") !== "IHDR") return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (fmt?.ext === "jpg") {
    let o = 2;
    while (o + 9 < buf.length) {
      if (buf[o] !== 0xff) return null;
      const marker = buf[o + 1]!;
      if (marker === 0xff) { o += 1; continue; }
      const len = buf.readUInt16BE(o + 2);
      // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) };
      }
      o += 2 + len;
    }
    return null;
  }
  return null;
}

/** A logo the renderer may embed: PNG or JPEG (the renderer cannot draw WebP), within the byte and pixel limits. */
export function usableLogo(buf: Buffer): { contentType: "image/png" | "image/jpeg" } | null {
  if (buf.length === 0 || buf.length > LOGO_MAX_BYTES) return null;
  const fmt = detectRasterImage(buf);
  if (!fmt || (fmt.ext !== "png" && fmt.ext !== "jpg")) return null;
  const d = rasterDimensions(buf);
  if (!d || d.width < 1 || d.height < 1 || d.width > LOGO_MAX_SIDE_PX || d.height > LOGO_MAX_SIDE_PX) return null;
  return { contentType: fmt.contentType as "image/png" | "image/jpeg" };
}

/**
 * Fetch a market's logo as a data URL for the renderer, or `null` for ANY problem (host not allowed, redirect, timeout, too big, not a PNG /
 * JPEG, too many pixels). A missing logo is never an error: the image falls back to the Percolator mark.
 */
export async function fetchLogoDataUrl(url: string | null | undefined, extraHosts: readonly string[] = [], fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (!isFetchableLogoUrl(url, extraHosts)) return null;
  try {
    const res = await fetchImpl(url as string, { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { Accept: "image/png,image/jpeg" } });
    if (!res.ok || !res.body) return null;
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > LOGO_MAX_BYTES) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > LOGO_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks);
    const ok = usableLogo(buf);
    return ok ? `data:${ok.contentType};base64,${buf.toString("base64")}` : null;
  } catch {
    return null;
  }
}

/** The project's own Supabase storage host (where uploaded logos live), as an extra allowed host; `[]` when unset. */
export function ownStorageHosts(): string[] {
  try {
    const u = process.env.NEXT_PUBLIC_SUPABASE_URL;
    return u ? [new URL(u).hostname] : [];
  } catch {
    return [];
  }
}
