/**
 * Tests for the shared Upstash rate limiter factory (in-memory fallback path).
 *
 * Upstash Redis is not available in unit tests, so these exercise the
 * local sliding-window fallback exclusively.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createUpstashRateLimiter } from "../../lib/upstash-rate-limit";

const mockLimit = vi.fn();

vi.mock("@upstash/ratelimit", () => {
  const MockRatelimit = vi.fn().mockImplementation(function (this: any) {
    this.limit = mockLimit;
  });
  (MockRatelimit as any).slidingWindow = vi.fn().mockReturnValue({ kind: "sliding" });
  return {
    Ratelimit: MockRatelimit,
  };
});
vi.mock("@upstash/redis", () => ({
  Redis: vi.fn(function (this: any) { return this; }),
}));

// Ensure Upstash env vars are absent so factory always falls back to local
beforeEach(() => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

describe("createUpstashRateLimiter — in-memory fallback", () => {
  it("allows requests under the limit", async () => {
    const limiter = createUpstashRateLimiter({
      limit: 3,
      windowMs: 60_000,
      prefix: "rl:test-allow",
    });

    const r1 = await limiter.check("ip1");
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = await limiter.check("ip1");
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = await limiter.check("ip1");
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);
  });

  it("blocks requests over the limit", async () => {
    const limiter = createUpstashRateLimiter({
      limit: 2,
      windowMs: 60_000,
      prefix: "rl:test-block",
    });

    await limiter.check("ip1");
    await limiter.check("ip1");
    const r3 = await limiter.check("ip1");
    expect(r3.allowed).toBe(false);
    expect(r3.remaining).toBe(0);
  });

  it("isolates keys from each other", async () => {
    const limiter = createUpstashRateLimiter({
      limit: 1,
      windowMs: 60_000,
      prefix: "rl:test-iso",
    });

    const r1 = await limiter.check("ip-a");
    expect(r1.allowed).toBe(true);

    // Different key should still be allowed
    const r2 = await limiter.check("ip-b");
    expect(r2.allowed).toBe(true);

    // Same key now blocked
    const r3 = await limiter.check("ip-a");
    expect(r3.allowed).toBe(false);
  });

  it("resets after the window expires", async () => {
    vi.useFakeTimers();
    try {
      const limiter = createUpstashRateLimiter({
        limit: 1,
        windowMs: 5_000,
        prefix: "rl:test-reset",
      });

      const r1 = await limiter.check("ip1");
      expect(r1.allowed).toBe(true);

      const r2 = await limiter.check("ip1");
      expect(r2.allowed).toBe(false);

      // Advance past window
      vi.advanceTimersByTime(6_000);

      const r3 = await limiter.check("ip1");
      expect(r3.allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns positive retryAfterSecs when blocked", async () => {
    const limiter = createUpstashRateLimiter({
      limit: 1,
      windowMs: 60_000,
      prefix: "rl:test-retry",
    });

    await limiter.check("ip1");
    const r2 = await limiter.check("ip1");
    expect(r2.allowed).toBe(false);
    expect(r2.retryAfterSecs).toBeGreaterThan(0);
    expect(r2.retryAfterSecs).toBeLessThanOrEqual(60);
  });

  it("separate factory instances don't share state", async () => {
    const limiterA = createUpstashRateLimiter({
      limit: 1,
      windowMs: 60_000,
      prefix: "rl:a",
    });
    const limiterB = createUpstashRateLimiter({
      limit: 1,
      windowMs: 60_000,
      prefix: "rl:b",
    });

    await limiterA.check("ip1");
    const rA = await limiterA.check("ip1");
    expect(rA.allowed).toBe(false);

    // Limiter B should be unaffected
    const rB = await limiterB.check("ip1");
    expect(rB.allowed).toBe(true);
  });

  it("falls back to in-memory when Redis throws at runtime", async () => {
    mockLimit.mockRejectedValueOnce(new Error("Redis connection error"));

    // Set env vars so the factory tries to create a real Upstash limiter
    process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";

    const limiter = createUpstashRateLimiter({
      limit: 5,
      windowMs: 60_000,
      prefix: "rl:test-redis-error",
    });

    // First call will try Redis and fail (fake URL) — should fall back gracefully
    const r1 = await limiter.check("ip1");
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(4);
    expect(r1.retryAfterSecs).toBeGreaterThanOrEqual(0);
  });
});
