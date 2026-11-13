// @vitest-environment node
import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import { detectRasterImage } from "@/lib/raster-image-bytes";

describe("detectRasterImage", () => {
  it("detects PNG signature", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect(detectRasterImage(buf)).toEqual({ ext: "png", contentType: "image/png" });
  });

  it("detects JPEG signature", () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(detectRasterImage(buf)).toEqual({ ext: "jpg", contentType: "image/jpeg" });
  });

  it("detects WebP (RIFF…WEBP)", () => {
    const buf = Buffer.alloc(12);
    buf.write("RIFF", 0, "ascii");
    buf.write("WEBP", 8, "ascii");
    expect(detectRasterImage(buf)).toEqual({ ext: "webp", contentType: "image/webp" });
  });

  it("rejects random bytes", () => {
    expect(detectRasterImage(Buffer.from("not an image"))).toBeNull();
  });

  it("rejects too-short buffer", () => {
    expect(detectRasterImage(Buffer.from([0xff, 0xd8]))).toBeNull();
  });
});
