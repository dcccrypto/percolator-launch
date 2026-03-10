/**
 * Tests for the create-market rate limiter (PERC-577).
 *
 * Covers:
 * - In-memory sliding window logic (no Redis env set)
 * - Trusted-proxy-aware getClientIp extraction
 * - X-RateLimit-Reset returns seconds-until-reset (not epoch)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Isolate in-memory store between tests ─────────────────────────────────
// We import the module after resetting to ensure a fresh _localMap each suite.
vi.mock("@upstash/redis", () => ({ Redis: vi.fn() }));
vi.mock("@upstash/ratelimit", () => ({ Ratelimit: vi.fn() }));

// ── get-client-ip ──────────────────────────────────────────────────────────
describe("getClientIp", () => {
  let getClientIp: (req: Request) => string;

  beforeEach(async () => {
    vi.resetModules();
    // Default TRUSTED_PROXY_DEPTH = 1
    delete process.env.TRUSTED_PROXY_DEPTH;
    const mod = await import("@/lib/get-client-ip");
    getClientIp = mod.getClientIp as unknown as (req: Request) => string;
  });

  it("extracts rightmost hop with depth 1 (anti-spoofing)", () => {
    const req = new Request("http://localhost/", {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
    });
    // depth=1: rightmost hop → ips[1] = 5.6.7.8
    expect(getClientIp(req as never)).toBe("5.6.7.8");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", () => {
    const req = new Request("http://localhost/", {
      headers: { "x-real-ip": "9.9.9.9" },
    });
    expect(getClientIp(req as never)).toBe("9.9.9.9");
  });

  it('returns "unknown" when no IP headers present', () => {
    const req = new Request("http://localhost/");
    expect(getClientIp(req as never)).toBe("unknown");
  });
});

// ── In-memory sliding-window rate limiter ─────────────────────────────────
describe("checkCreateMarketRateLimit (in-memory fallback)", () => {
  let checkCreateMarketRateLimit: (ip: string) => Promise<{
    allowed: boolean;
    remaining: number;
    retryAfterSecs: number;
  }>;
  let CREATE_MARKET_RATE_LIMIT: number;

  beforeEach(async () => {
    vi.resetModules();
    // Ensure no Redis env vars — forces in-memory path
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const mod = await import("@/lib/create-market-rate-limit");
    checkCreateMarketRateLimit = mod.checkCreateMarketRateLimit;
    CREATE_MARKET_RATE_LIMIT = mod.CREATE_MARKET_RATE_LIMIT;
  });

  it("allows requests up to the limit", async () => {
    const ip = "10.0.0.1";
    for (let i = 0; i < CREATE_MARKET_RATE_LIMIT; i++) {
      const r = await checkCreateMarketRateLimit(ip);
      expect(r.allowed).toBe(true);
    }
  });

  it("blocks the request that exceeds the limit", async () => {
    const ip = "10.0.0.2";
    for (let i = 0; i < CREATE_MARKET_RATE_LIMIT; i++) {
      await checkCreateMarketRateLimit(ip);
    }
    const r = await checkCreateMarketRateLimit(ip);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
  });

  it("retryAfterSecs is > 0 and < window when blocked", async () => {
    const ip = "10.0.0.3";
    for (let i = 0; i <= CREATE_MARKET_RATE_LIMIT; i++) {
      await checkCreateMarketRateLimit(ip);
    }
    const r = await checkCreateMarketRateLimit(ip);
    expect(r.retryAfterSecs).toBeGreaterThan(0);
    expect(r.retryAfterSecs).toBeLessThanOrEqual(60);
  });

  it("different IPs get independent buckets", async () => {
    const ip1 = "10.0.1.1";
    const ip2 = "10.0.1.2";
    // Exhaust ip1
    for (let i = 0; i <= CREATE_MARKET_RATE_LIMIT; i++) {
      await checkCreateMarketRateLimit(ip1);
    }
    const r1 = await checkCreateMarketRateLimit(ip1);
    const r2 = await checkCreateMarketRateLimit(ip2);
    expect(r1.allowed).toBe(false);
    expect(r2.allowed).toBe(true);
  });
});

// ── X-RateLimit-Reset header convention ───────────────────────────────────
describe("X-RateLimit-Reset header", () => {
  it("is seconds-until-reset (≤ 60), not an epoch timestamp", async () => {
    vi.resetModules();
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const { checkCreateMarketRateLimit, CREATE_MARKET_RATE_LIMIT } =
      await import("@/lib/create-market-rate-limit");
    const ip = "10.0.2.1";
    for (let i = 0; i <= CREATE_MARKET_RATE_LIMIT; i++) {
      await checkCreateMarketRateLimit(ip);
    }
    const r = await checkCreateMarketRateLimit(ip);
    // Must be seconds-until-reset, never an epoch (which would be ~1.7B+)
    expect(r.retryAfterSecs).toBeLessThanOrEqual(60);
    expect(r.retryAfterSecs).toBeGreaterThanOrEqual(0);
  });
});
