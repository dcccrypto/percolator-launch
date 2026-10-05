import { describe, it, expect, afterEach } from "vitest";
import { tvPopupOpen, tvIframeDocument, watchTvPopups } from "@/lib/tv/tvPopup";

function docWith(html: string): Document {
  const d = document.implementation.createHTMLDocument("t");
  d.body.innerHTML = html;
  return d;
}

describe("tvPopupOpen", () => {
  it("is false for an idle chart (empty overlap root, toolbar only)", () => {
    expect(tvPopupOpen(docWith('<div id="overlap-manager-root"></div><div data-name="legend"></div>'))).toBe(false);
  });
  it("is true when the Indicators dialog is portaled into the overlap root", () => {
    expect(tvPopupOpen(docWith('<div id="overlap-manager-root"><div data-name="indicators-dialog"></div></div>'))).toBe(true);
  });
  it("is true for a role=dialog or role=menu outside the overlap root", () => {
    expect(tvPopupOpen(docWith('<div role="dialog"></div>'))).toBe(true);
    expect(tvPopupOpen(docWith('<div role="menu"></div>'))).toBe(true);
  });
  it("is false with no document (iframe not mounted / cross-origin)", () => {
    expect(tvPopupOpen(null)).toBe(false);
    expect(tvIframeDocument(null)).toBeNull();
  });
});

describe("watchTvPopups", () => {
  afterEach(() => { document.body.innerHTML = ""; });
  it("reports open then closed as the iframe content changes", async () => {
    const container = document.createElement("div");
    const iframe = document.createElement("iframe");
    container.appendChild(iframe);
    document.body.appendChild(container);
    const idoc = iframe.contentDocument!;
    idoc.body.innerHTML = '<div id="overlap-manager-root"></div>';
    const seen: boolean[] = [];
    const stop = watchTvPopups(container, (o) => seen.push(o));
    expect(seen).toEqual([false]);
    idoc.getElementById("overlap-manager-root")!.innerHTML = '<div role="dialog"></div>';
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual([false, true]);
    idoc.getElementById("overlap-manager-root")!.innerHTML = "";
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual([false, true, false]);
    stop();
  });
});
