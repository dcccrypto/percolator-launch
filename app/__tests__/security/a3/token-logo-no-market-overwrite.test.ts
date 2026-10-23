// @vitest-environment node
/**
 * S3-C9 (fix-all 2026-10-18): POST /api/tokens/[mint]/logo must not write markets.logo_url.
 * It used to update every market sharing the mint; market logos are set per slab by the creator
 * (/api/markets/[slab]/logo).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const fromTables: string[] = [];
const upload = vi.fn(async () => ({ error: null }));

vi.mock("@/lib/supabase", () => ({
  getServiceClient: () => ({
    storage: {
      from: () => ({
        upload,
        getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.example/${p}` } }),
        list: async () => ({ data: [] }),
      }),
    },
    from: (t: string) => {
      fromTables.push(t);
      const b = { update: () => b, eq: async () => ({ error: null }) };
      return b;
    },
  }),
}));

// 1x1 PNG
const PNG = Buffer.from(
  "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D4944415478DA6364F8CF00000301010018DD8DB40000000049454E44AE426082",
  "hex",
);
const MINT = "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC";

describe("S3-C9 token logo POST is scoped to the token file", () => {
  const saved = process.env.INDEXER_API_KEY;
  beforeEach(() => {
    process.env.INDEXER_API_KEY = "test-key";
    fromTables.length = 0;
    upload.mockClear();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.INDEXER_API_KEY;
    else process.env.INDEXER_API_KEY = saved;
  });

  it("stores the token logo but never updates any markets row", async () => {
    const { POST } = await import("@/app/api/tokens/[mint]/logo/route");
    const fd = new FormData();
    fd.append("logo", new File([PNG], "a.png", { type: "image/png" }));
    const req = new NextRequest(`http://localhost/api/tokens/${MINT}/logo`, {
      method: "POST",
      headers: { "x-api-key": "test-key" },
      body: fd,
    });
    const res = await POST(req, { params: Promise.resolve({ mint: MINT }) });
    expect(res.status).toBe(200);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(fromTables).not.toContain("markets");
  });

  it("CONTROL: still requires the API key", async () => {
    const { POST } = await import("@/app/api/tokens/[mint]/logo/route");
    const req = new NextRequest(`http://localhost/api/tokens/${MINT}/logo`, { method: "POST", body: new FormData() });
    const res = await POST(req, { params: Promise.resolve({ mint: MINT }) });
    expect(res.status).toBe(401);
  });
});
