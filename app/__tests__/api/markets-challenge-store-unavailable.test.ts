// @vitest-environment node
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
const KEYS = ["BLOB_READ_WRITE_TOKEN", "VERCEL_OIDC_TOKEN", "BLOB_STORE_ID"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

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
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("returns a 503 JSON reason (no stack, no env names) when the Blob token is missing", async () => {
    for (const k of KEYS) delete process.env[k];
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

  it("OIDC credentials (no read-write token) are a credential: the write runs and a nonce comes back", async () => {
    for (const k of KEYS) delete process.env[k];
    process.env.VERCEL_OIDC_TOKEN = "oidc";
    process.env.BLOB_STORE_ID = "store_1";
    const res = await call("1.1.1.1, 30.0.0.4");
    expect(res.status).toBe(200);
    expect(putMock).toHaveBeenCalled();
  });

  it("returns a nonce when the store works", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "x";
    const res = await call("1.1.1.1, 30.0.0.3");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.nonce).toBe("string");
  });
});
