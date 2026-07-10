/**
 * Tests for middleware.ts — Upstash Redis distributed rate limiter (GH#1213),
 * off-by-one fix (GH#1245), funding slab blocklist guard (GH#1363), and
 * /markets/:slab → /trade/:slab 308 redirect (GH#1558).
 *
 * KEY NOTE: vi.fn().mockImplementation(() => ...) with an arrow function is
 * NOT usable as a constructor (Vitest 4 enforces this). Ratelimit instances
 * must be created with `new`, so we use a regular `function` implementation.
 *
 * Covers:
 *  - 100 parallel /api/markets requests all return 429 when Redis returns
 *    success:false (the fix for serverless per-instance bypass, GH#1213)
 *  - GH#1245: Upstash success:true + remaining:0 (last allowed req) → 200 not 429
 *  - GH#1245: In-memory off-by-one — request #120 must be ALLOWED, #121 blocked
 *  - In-memory fallback (no Redis env) enforces 120/min per-IP limit
 *  - RPC tier uses a separate 600/min limit bucket
 *  - X-RateLimit-* + Retry-After headers present on 429 responses
 *  - Graceful Redis error fallback → in-memory, no 500s
 *  - GH#1363: Funding slab blocklist guard fires in middleware (pre-rewrite)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

// ── Shared mock state ─────────────────────────────────────────────────────
// vi.mock() is hoisted; factories capture these variables lazily (on first
// import of the mocked module), by which time they are fully initialized.

const mockLimitFn = vi.fn();

// MUST use a regular function (not arrow) — Vitest 4 requires 'function' or
// 'class' for mocks used with `new`. Arrow functions are not constructors and
// cause a TypeError that the try-catch in getUpstashLimiters() swallows.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MockRatelimitCtor = vi.fn(function (this: any) {
  this.limit = mockLimitFn;
});
// Attach static method used in: limiter: Ratelimit.slidingWindow(...)
(MockRatelimitCtor as unknown as Record<string, unknown>).slidingWindow = vi
  .fn()
  .mockReturnValue({ kind: "sliding" });

// MUST use regular functions (not arrow) for any mock used with `new`.
// Arrow functions are not constructors; Vitest 4 enforces this and the
// try-catch in getUpstashLimiters() would otherwise swallow the TypeError.
vi.mock("@upstash/redis", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Redis: vi.fn(function (this: any) { return this; }),
}));
vi.mock("@upstash/ratelimit", () => ({ Ratelimit: MockRatelimitCtor }));

// ── Helpers ────────────────────────────────────────────────────────────────

function makeReq(path = "/api/markets", ip = "1.2.3.4"): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    headers: { "x-forwarded-for": ip },
  });
}

type MiddlewareFn = (req: NextRequest) => Promise<Response>;

/** Returns a freshly imported proxy handler (resets module-level singletons). */
async function freshMiddleware(): Promise<MiddlewareFn> {
  vi.resetModules();
  // middleware.ts was migrated to proxy.ts (Next 16 Node-runtime proxy). The
  // handler is now exported as `proxy` instead of `middleware`.
  const mod = await import("@/middleware");
  return mod.middleware as unknown as MiddlewareFn;
}

// ── Suite 1: Redis path — limit exhausted → all 429 ───────────────────────
describe("middleware — Upstash Redis distributed rate limiter (GH#1213)", () => {
  let middleware: MiddlewareFn;

  beforeEach(async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
    // Every call to limiter.limit() reports the limit is exhausted
    mockLimitFn.mockResolvedValue({
      success: false,
      remaining: 0,
      reset: Date.now() + 60_000,
    });
    middleware = await freshMiddleware();
  });

  afterEach(() => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  it("100 parallel /api/markets requests all return 429 when Redis limit exhausted", async () => {
    const requests = Array.from({ length: 100 }, (_, i) =>
      middleware(makeReq("/api/markets", `1.2.3.${i % 255}`)),
    );
    const responses = await Promise.all(requests);
    for (const res of responses) {
      expect(res.status).toBe(429);
    }
  });

  it("429 response includes X-RateLimit-* and Retry-After headers", async () => {
    const res = await middleware(makeReq("/api/markets"));
    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("120");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(res.headers.get("X-RateLimit-Reset")).toBeTruthy();
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("429 response body is JSON with an error field", async () => {
    const res = await middleware(makeReq("/api/markets"));
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body).toHaveProperty("error");
    expect(typeof body.error).toBe("string");
  });

  it("RPC tier reports limit=600 on 429", async () => {
    const res = await middleware(makeReq("/api/rpc"));
    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("600");
  });

  it("non-API routes are not rate-limited", async () => {
    const res = await middleware(makeReq("/some-page"));
    expect(res.status).not.toBe(429);
  });

  it("GH#1245: Upstash success:true + remaining:0 (last allowed request) → 200 not 429", async () => {
    // Upstash says the request is allowed but the bucket is now exhausted.
    // Previously `remaining <= 0` incorrectly blocked this request.
    mockLimitFn.mockResolvedValueOnce({
      success: true,
      remaining: 0,
      reset: Date.now() + 60_000,
    });
    const res = await middleware(makeReq("/api/markets", "5.6.7.8"));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
  });
});

// ── Suite 2: In-memory fallback (no Upstash env vars) ────────────────────
describe("middleware — in-memory fallback (no Upstash env)", () => {
  let middleware: MiddlewareFn;

  beforeEach(async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    middleware = await freshMiddleware();
  });

  it("GH#1245: allows exactly 120 requests per IP (off-by-one fix)", async () => {
    // The old code blocked request #120 (count == max → remaining == 0 → 429).
    // The fix uses count <= max so request #120 is the LAST allowed request.
    const ip = "10.0.0.1";
    for (let i = 0; i < 120; i++) {
      const res = await middleware(makeReq("/api/markets", ip));
      expect(res.status).not.toBe(429);
    }
  });

  it("returns 429 on request 121 from same IP (in-memory)", async () => {
    const ip = "10.0.0.2";
    for (let i = 0; i < 120; i++) {
      await middleware(makeReq("/api/markets", ip));
    }
    const res = await middleware(makeReq("/api/markets", ip));
    expect(res.status).toBe(429);
  });

  it("different IPs have independent in-memory buckets", async () => {
    for (let i = 0; i < 121; i++) {
      await middleware(makeReq("/api/markets", "10.0.1.1"));
    }
    const res = await middleware(makeReq("/api/markets", "10.0.1.2"));
    expect(res.status).not.toBe(429);
  });
});

// ── Suite 3: Graceful Redis error fallback ────────────────────────────────
describe("middleware — graceful Redis error fallback", () => {
  let middleware: MiddlewareFn;

  beforeEach(async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
    // Simulate Redis transient error on every call to limiter.limit()
    mockLimitFn.mockRejectedValue(new Error("Redis ECONNRESET"));
    middleware = await freshMiddleware();
  });

  afterEach(() => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  it("falls back to in-memory and returns non-500 when Redis.limit() rejects", async () => {
    const res = await middleware(makeReq("/api/markets", "10.0.3.1"));
    expect(res.status).not.toBe(500);
    expect(res.status).not.toBe(429); // fresh IP under in-memory limit
  });
});

// ── Suite 4: Funding slab blocklist guard (GH#1363) ───────────────────────
// next.config.ts rewrites /api/funding/:slab → Railway before route handlers
// run, so the blocklist check in route.ts is dead code for those paths.
// The middleware guard must intercept pre-rewrite and return 404.
describe("middleware — funding slab blocklist guard (GH#1363)", () => {
  let middleware: MiddlewareFn;

  beforeEach(async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.BLOCKED_MARKET_ADDRESSES;
    middleware = await freshMiddleware();
  });

  it("returns 404 for hardcoded blocked slab on /api/funding/:slab", async () => {
    // BxJPaMaCfEGTBsjZ8wfj3Yfzf4wpasmxKAEvqZZRcGPP is in BLOCKED_SLAB_ADDRESSES
    const res = await middleware(
      makeReq("/api/funding/BxJPaMaCfEGTBsjZ8wfj3Yfzf4wpasmxKAEvqZZRcGPP"),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Market not found");
  });

  it("returns 404 for hardcoded blocked slab on /api/funding/:slab/history", async () => {
    const res = await middleware(
      makeReq("/api/funding/HjBePQZnoZVftg9B52gyeuHGjBvt2f8FNCVP4FeoP3YT/history"),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Market not found");
  });

  it("returns 404 for env-var-injected blocked slab", async () => {
    process.env.BLOCKED_MARKET_ADDRESSES = "RuntimeBlockedSlabXXXXXXXXXXXXXXXXXXXXX";
    // Need a fresh middleware so module-level set picks up the new env var
    const mw = await freshMiddleware();
    const res = await mw(
      makeReq("/api/funding/RuntimeBlockedSlabXXXXXXXXXXXXXXXXXXXXX"),
    );
    expect(res.status).toBe(404);
    delete process.env.BLOCKED_MARKET_ADDRESSES;
  });

  it("passes through unblocked slabs (does not return 404)", async () => {
    const res = await middleware(makeReq("/api/funding/ValidSlabAddressXXXXXXXXXXXXXXXX"));
    // Should not be 404 (will be proxied to Railway or pass to rate limiter)
    expect(res.status).not.toBe(404);
  });

  it("does not affect /api/funding/global (not a slab path)", async () => {
    const res = await middleware(makeReq("/api/funding/global"));
    // /api/funding/global is a valid Next.js route, not a slab — should pass through
    // (regex matches single segment after /api/funding/ so 'global' would match,
    // but it's not in the blocklist so it passes through)
    expect(res.status).not.toBe(404);
  });

  it("does not affect non-funding API routes", async () => {
    const res = await middleware(makeReq("/api/markets"));
    expect(res.status).not.toBe(404);
  });
});

// ── Suite 5: Open-interest slab blocklist guard (GH#1390) ─────────────────
// next.config.ts rewrites /api/open-interest/:slab → Railway before route
// handlers run.  The middleware guard must intercept pre-rewrite and 404.
describe("middleware — open-interest slab blocklist guard (GH#1390)", () => {
  let middleware: MiddlewareFn;

  beforeEach(async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.BLOCKED_MARKET_ADDRESSES;
    middleware = await freshMiddleware();
  });

  it("returns 404 for hardcoded blocked slab on /api/open-interest/:slab", async () => {
    const res = await middleware(
      makeReq("/api/open-interest/BxJPaMaCfEGTBsjZ8wfj3Yfzf4wpasmxKAEvqZZRcGPP"),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Market not found");
  });

  it("returns 404 for env-var-injected blocked slab on /api/open-interest/:slab", async () => {
    process.env.BLOCKED_MARKET_ADDRESSES = "RuntimeBlockedSlabXXXXXXXXXXXXXXXXXXXXX";
    const mw = await freshMiddleware();
    const res = await mw(
      makeReq("/api/open-interest/RuntimeBlockedSlabXXXXXXXXXXXXXXXXXXXXX"),
    );
    expect(res.status).toBe(404);
    delete process.env.BLOCKED_MARKET_ADDRESSES;
  });

  it("passes through unblocked slabs on /api/open-interest/:slab", async () => {
    const res = await middleware(makeReq("/api/open-interest/ValidSlabAddressXXXXXXXXXXXXXXXX"));
    expect(res.status).not.toBe(404);
  });

  it("does not affect non-open-interest routes", async () => {
    const res = await middleware(makeReq("/api/markets"));
    expect(res.status).not.toBe(404);
  });
});

// ── Suite 6: Insurance slab blocklist guard (GH#1390) ─────────────────────
// next.config.ts rewrites /api/insurance/:slab → Railway before route
// handlers run.  The middleware guard must intercept pre-rewrite and 404.
describe("middleware — insurance slab blocklist guard (GH#1390)", () => {
  let middleware: MiddlewareFn;

  beforeEach(async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.BLOCKED_MARKET_ADDRESSES;
    middleware = await freshMiddleware();
  });

  it("returns 404 for hardcoded blocked slab on /api/insurance/:slab", async () => {
    const res = await middleware(
      makeReq("/api/insurance/BxJPaMaCfEGTBsjZ8wfj3Yfzf4wpasmxKAEvqZZRcGPP"),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Market not found");
  });

  it("returns 404 for env-var-injected blocked slab on /api/insurance/:slab", async () => {
    process.env.BLOCKED_MARKET_ADDRESSES = "RuntimeBlockedSlabXXXXXXXXXXXXXXXXXXXXX";
    const mw = await freshMiddleware();
    const res = await mw(
      makeReq("/api/insurance/RuntimeBlockedSlabXXXXXXXXXXXXXXXXXXXXX"),
    );
    expect(res.status).toBe(404);
    delete process.env.BLOCKED_MARKET_ADDRESSES;
  });

  it("passes through unblocked slabs on /api/insurance/:slab", async () => {
    const res = await middleware(makeReq("/api/insurance/ValidSlabAddressXXXXXXXXXXXXXXXX"));
    expect(res.status).not.toBe(404);
  });

  it("does not affect non-insurance routes", async () => {
    const res = await middleware(makeReq("/api/markets"));
    expect(res.status).not.toBe(404);
  });
});

// ── Suite 7: /markets/:slab → /trade/:slab 308 redirect (GH#1558) ─────────
// next.config.ts redirects are swallowed by the RSC BAILOUT_TO_CLIENT_SIDE_RENDERING
// error boundary, returning HTTP 200 instead of 308. The middleware redirect fires
// at the Edge before the Next.js router, guaranteeing the correct 308 status code.
describe("middleware — /markets/:slab 308 redirect (GH#1558)", () => {
  let middleware: MiddlewareFn;

  beforeEach(async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.BLOCKED_MARKET_ADDRESSES;
    middleware = await freshMiddleware();
  });

  it("redirects /markets/<slab> with HTTP 308", async () => {
    const slab = "3UJRD9YCtey3YjAD6iVznaWvHgz1bzz6dLzBhQekToqA";
    const res = await middleware(makeReq(`/markets/${slab}`));
    expect(res.status).toBe(308);
  });

  it("redirects to /trade/<slab>", async () => {
    const slab = "3UJRD9YCtey3YjAD6iVznaWvHgz1bzz6dLzBhQekToqA";
    const res = await middleware(makeReq(`/markets/${slab}`));
    expect(res.headers.get("location")).toContain(`/trade/${slab}`);
  });

  it("preserves query string in redirect", async () => {
    const slab = "3UJRD9YCtey3YjAD6iVznaWvHgz1bzz6dLzBhQekToqA";
    const res = await middleware(
      new NextRequest(`http://localhost/markets/${slab}?ref=share`, {
        headers: { "x-forwarded-for": "1.2.3.4" },
      }),
    );
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toContain("?ref=share");
  });

  it("does not redirect /markets (no slab — list page)", async () => {
    const res = await middleware(makeReq("/markets"));
    expect(res.status).not.toBe(308);
  });

  it("does not redirect /trade/<slab>", async () => {
    const slab = "3UJRD9YCtey3YjAD6iVznaWvHgz1bzz6dLzBhQekToqA";
    const res = await middleware(makeReq(`/trade/${slab}`));
    expect(res.status).not.toBe(308);
  });

  it("does not redirect /api/markets routes", async () => {
    const res = await middleware(makeReq("/api/markets"));
    expect(res.status).not.toBe(308);
  });
});
