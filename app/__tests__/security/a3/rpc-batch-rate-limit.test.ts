/**
 * S3-C4 (fix-all 2026-10-18): /api/rpc's per-IP limit must count JSON-RPC calls,
 * not HTTP requests — a batch of N entries consumes N units — and an oversized
 * batch is refused before it is charged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

type PostFn = (req: NextRequest) => Promise<Response>;

let seq = 0;
function batch(n: number, ip: string): NextRequest {
  const body = Array.from({ length: n }, () => {
    seq += 1;
    return { jsonrpc: "2.0", id: seq, method: "getSlot", params: [{ commitment: `c${seq}` }] };
  });
  return new NextRequest("http://localhost/api/rpc", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

describe("S3-C4 /api/rpc counts batched calls", () => {
  const originalFetch = global.fetch;
  const savedLimit = process.env.RPC_RATE_LIMIT_PER_WINDOW;
  const savedUrl = process.env.UPSTASH_REDIS_REST_URL;
  let POST: PostFn;

  beforeEach(async () => {
    vi.resetModules();
    process.env.RPC_RATE_LIMIT_PER_WINDOW = "10";
    delete process.env.UPSTASH_REDIS_REST_URL;
    global.fetch = vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: 1 }),
    })) as unknown as typeof fetch;
    ({ POST } = (await import("../../../app/api/rpc/route")) as unknown as { POST: PostFn });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (savedLimit === undefined) delete process.env.RPC_RATE_LIMIT_PER_WINDOW;
    else process.env.RPC_RATE_LIMIT_PER_WINDOW = savedLimit;
    if (savedUrl !== undefined) process.env.UPSTASH_REDIS_REST_URL = savedUrl;
  });

  it("charges a batch one unit per entry (2 x 8 calls > 10/window -> second is 429)", async () => {
    const first = await POST(batch(8, "203.0.113.7"));
    expect(first.status).toBe(200);
    const second = await POST(batch(8, "203.0.113.7"));
    expect(second.status).toBe(429);
  });

  it("refuses a batch over the cap with 400 without charging the limiter", async () => {
    const tooBig = await POST(batch(41, "203.0.113.8"));
    expect(tooBig.status).toBe(400);
    // Budget untouched: a 10-call batch still fits.
    const ok = await POST(batch(10, "203.0.113.8"));
    expect(ok.status).toBe(200);
  });

  it("a single call still costs 1", async () => {
    const { rpcCallCost } = await import("../../../lib/rpc-call-cost");
    expect(rpcCallCost({ method: "getSlot" })).toBe(1);
    expect(rpcCallCost([])).toBe(1);
    expect(rpcCallCost([{}, {}, {}])).toBe(3);
  });
});

describe("shared limiter weighted cost (in-memory fallback)", () => {
  it("check(key, n) consumes n units", async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    const { createUpstashRateLimiter } = await import("../../../lib/upstash-rate-limit");
    const l = createUpstashRateLimiter({ limit: 5, windowMs: 60_000, prefix: "rl:test-cost" });
    expect((await l.check("k", 4)).allowed).toBe(true);
    expect((await l.check("k", 2)).allowed).toBe(false);
    // A bogus cost is treated as 1, never 0.
    const l2 = createUpstashRateLimiter({ limit: 1, windowMs: 60_000, prefix: "rl:test-cost2" });
    expect((await l2.check("k", 0)).allowed).toBe(true);
    expect((await l2.check("k", 0)).allowed).toBe(false);
  });
});
