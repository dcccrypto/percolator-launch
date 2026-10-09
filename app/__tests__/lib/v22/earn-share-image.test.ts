// @vitest-environment node
/** The share image's logo handling: creator-supplied content, fetched through guards and re-encoded; never redirected to. */
import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { fetchLogoDataUrl, rasterDimensions, usableLogo, LOGO_MAX_SIDE_PX } from "@/lib/v22/earn-share-image";
import { LOGO_HOST_ALLOWLIST, LOGO_MAX_BYTES, isFetchableLogoUrl } from "@/lib/v22/earn-share-meta";

// 16 x 16 solid red PNG (python zlib + crc).
const PNG16 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGM4oaFBEmIY1TCqYfhqAAB8MxgQ+Pjr0gAAAABJRU5ErkJggg==", "base64");
const pngHeader = (w: number, h: number) => {
  const b = Buffer.from(PNG16);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
// minimal JPEG header: SOI, APP0, SOF0 (precision 8, height 0x0020, width 0x0030), EOI
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x20, 0x00, 0x30, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(20)]);
const GIF = Buffer.from("GIF89a\x10\x00\x10\x00", "latin1");

const okFetch = (body: Buffer, init: { status?: number; headers?: Record<string, string> } = {}) =>
  vi.fn(async (_u: unknown, _i?: RequestInit) => new Response(new Uint8Array(body), { status: init.status ?? 200, headers: init.headers }));

describe("rasterDimensions / usableLogo", () => {
  it("reads PNG and JPEG sizes from the header", () => {
    expect(rasterDimensions(PNG16)).toEqual({ width: 16, height: 16 });
    expect(rasterDimensions(JPEG)).toEqual({ width: 48, height: 32 });
    expect(rasterDimensions(WEBP)).toBeNull();
    expect(rasterDimensions(Buffer.from("not an image"))).toBeNull();
  });
  it("accepts PNG / JPEG within the limits only", () => {
    expect(usableLogo(PNG16)).toEqual({ contentType: "image/png" });
    expect(usableLogo(JPEG)).toEqual({ contentType: "image/jpeg" });
  });
  it("NEGATIVE CONTROLS: WebP, GIF, text, empty, an image that decodes to a huge bitmap, one over the byte cap", () => {
    expect(usableLogo(WEBP)).toBeNull();
    expect(usableLogo(GIF)).toBeNull();
    expect(usableLogo(Buffer.from("<svg onload=alert(1)>"))).toBeNull();
    expect(usableLogo(Buffer.alloc(0))).toBeNull();
    expect(usableLogo(pngHeader(LOGO_MAX_SIDE_PX + 1, 16))).toBeNull();
    expect(usableLogo(pngHeader(30_000, 30_000))).toBeNull(); // a decompression bomb: a tiny file, a 900 MP bitmap
    expect(usableLogo(pngHeader(0, 16))).toBeNull();
    expect(usableLogo(Buffer.concat([PNG16, Buffer.alloc(LOGO_MAX_BYTES)]))).toBeNull();
  });
});

describe("isFetchableLogoUrl (SSRF guard)", () => {
  it("https on an allowlisted host, or the project's own storage host", () => {
    expect(isFetchableLogoUrl("https://coin-images.coingecko.com/coins/images/1/large/x.png")).toBe(true);
    expect(isFetchableLogoUrl("https://abc.supabase.co/storage/v1/object/public/logos/x.png", ["abc.supabase.co"])).toBe(true);
    for (const h of LOGO_HOST_ALLOWLIST) expect(isFetchableLogoUrl(`https://${h}/x.png`)).toBe(true);
  });
  it("NEGATIVE CONTROLS: everything else is refused", () => {
    for (const u of [
      "http://assets.coingecko.com/x.png", // not https
      "https://evil.example/x.png", // not allowlisted
      "https://assets.coingecko.com.evil.example/x.png", // suffix trick
      "https://evilassets.coingecko.com/x.png",
      "https://user:pw@assets.coingecko.com/x.png", // credentials
      "https://assets.coingecko.com:8443/x.png", // port
      "https://localhost/x.png", "https://127.0.0.1/x.png", "https://169.254.169.254/latest/meta-data", "https://[::1]/x.png", "https://10.0.0.1/x.png",
      "file:///etc/passwd", "data:image/png;base64,AAAA", "javascript:alert(1)", "//assets.coingecko.com/x.png", "", "not a url",
      "https://assets.coingecko.com/" + "a".repeat(600),
    ]) expect(isFetchableLogoUrl(u), u.slice(0, 60)).toBe(false);
    expect(isFetchableLogoUrl(null)).toBe(false);
    expect(isFetchableLogoUrl(undefined)).toBe(false);
    // an extra host is matched exactly, not by suffix
    expect(isFetchableLogoUrl("https://x.abc.supabase.co/a.png", ["abc.supabase.co"])).toBe(false);
  });
});

describe("fetchLogoDataUrl", () => {
  const URL_OK = "https://assets.coingecko.com/coins/images/1/large/x.png";
  it("a good PNG becomes a data URL; the request refuses redirects and has a timeout signal", async () => {
    const f = okFetch(PNG16);
    const out = await fetchLogoDataUrl(URL_OK, [], f as unknown as typeof fetch);
    expect(out).toBe(`data:image/png;base64,${PNG16.toString("base64")}`);
    const init = f.mock.calls[0]![1] as RequestInit;
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it("a host that is not allowed is never contacted", async () => {
    const f = okFetch(PNG16);
    expect(await fetchLogoDataUrl("https://evil.example/x.png", [], f as unknown as typeof fetch)).toBeNull();
    expect(await fetchLogoDataUrl("http://assets.coingecko.com/x.png", [], f as unknown as typeof fetch)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
  it("every failure is null, never a throw: HTTP error, redirect error, timeout, wrong bytes, WebP, huge bitmap, declared or streamed oversize", async () => {
    const cases: Array<typeof fetch> = [
      okFetch(PNG16, { status: 404 }) as unknown as typeof fetch,
      (async () => { throw new TypeError("redirect mode is set to error"); }) as unknown as typeof fetch,
      (async () => { throw new DOMException("timeout", "TimeoutError"); }) as unknown as typeof fetch,
      okFetch(Buffer.from("<html>")) as unknown as typeof fetch,
      okFetch(WEBP) as unknown as typeof fetch,
      okFetch(pngHeader(30_000, 30_000)) as unknown as typeof fetch,
      okFetch(PNG16, { headers: { "content-length": String(LOGO_MAX_BYTES + 1) } }) as unknown as typeof fetch,
      okFetch(Buffer.concat([PNG16, Buffer.alloc(LOGO_MAX_BYTES)])) as unknown as typeof fetch, // no content-length: caught while streaming
    ];
    for (const [i, f] of cases.entries()) expect(await fetchLogoDataUrl(URL_OK, [], f), `case ${i}`).toBeNull();
  });
});
