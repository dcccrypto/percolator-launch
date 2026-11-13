/**
 * GET /api/markets/challenge must never be a bare 500 when the nonce store
 * (Vercel Blob) can't run. R9 found it 500ing on the preview, where the Blob
 * token is not set. It returns a nonce when it can, else a clear 503 JSON.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@upstash/redis", () => ({ Redis: vi.fn() }));
vi.mock("@upstash/ratelimit", () => ({ Ratelimit: vi.fn() }));

const putMock = vi.fn();
const listMock = vi.fn();
vi.mock("@vercel/blob", () => ({
  put: (...a: unknown[]) => putMock(...a),
  list: (...a: unknown[]) => listMock(...a),
}));

const DEPLOYER = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const saved = process.env.BLOB_READ_WRITE_TOKEN;

async function call(ip: string) {
  vi.resetModules();
  const { NextRequest } = await import("next/server");
  const mod = await import("@/app/api/markets/challenge/route");
  return mod.GET(
    new NextRequest(`http://localhost/api/markets/challenge?deployer=${DEPLOYER}`, {
      headers: { "x-forwarded-for": ip },
    }),
  );
}

describe("GET /api/markets/challenge when the store is unavailable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue({ blobs: [] });
    putMock.mockResolvedValue({});
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = saved;
  });

  it("returns a 503 JSON reason (no stack, no env names) when the Blob token is missing", async () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    const res = await call("1.1.1.1, 30.0.0.1");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/not available/i);
    expect(JSON.stringify(body)).not.toMatch(/BLOB|token|stack/i);
    expect(putMock).not.toHaveBeenCalled();
  });

  it("returns a 503 JSON reason when the Blob write throws", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "x";
    putMock.mockRejectedValue(new Error("secret internal detail"));
    const res = await call("1.1.1.1, 30.0.0.2");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toMatch(/secret internal detail/);
  });

  it("returns a nonce when the store works", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "x";
    const res = await call("1.1.1.1, 30.0.0.3");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.nonce).toBe("string");
  });
});
