/**
 * PoC — rate limiters fail OPEN when Upstash is unconfigured.
 *
 * createUpstashRateLimiter falls back to a per-instance in-memory sliding window
 * when UPSTASH_REDIS_REST_URL/TOKEN are absent. On a horizontally-scaled deploy
 * each serverless instance has its own window, so one IP's effective limit is
 * (configured limit) × (number of warm instances). The unconfigured case is also
 * silent — nothing logs that global rate limiting is degraded.
 *
 * This models two instances as two limiter instances (each has its own closure /
 * localMap) and shows one IP exceeding the configured limit.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createUpstashRateLimiter } from "@/lib/upstash-rate-limit";

describe("PoC: limiters fail open (per-instance) without Upstash", () => {
  beforeEach(() => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  it("one IP exceeds the configured limit across separate instances", async () => {
    const LIMIT = 5;
    // Two independent limiter instances model two serverless workers.
    const instanceA = createUpstashRateLimiter({ limit: LIMIT, windowMs: 60_000, prefix: "rl:failopen-poc" });
    const instanceB = createUpstashRateLimiter({ limit: LIMIT, windowMs: 60_000, prefix: "rl:failopen-poc" });

    const ip = "203.0.113.9";
    let allowed = 0;
    for (let i = 0; i < LIMIT; i++) if ((await instanceA.check(ip)).allowed) allowed++;
    for (let i = 0; i < LIMIT; i++) if ((await instanceB.check(ip)).allowed) allowed++;

    // Same IP, limit=5, but 10 requests were allowed — the per-instance window
    // does not bound a client spread across instances.
    expect(allowed).toBe(LIMIT * 2);
  });

  it("a single instance DOES bound (the fallback works locally — it just isn't global)", async () => {
    const LIMIT = 5;
    const one = createUpstashRateLimiter({ limit: LIMIT, windowMs: 60_000, prefix: "rl:failopen-poc2" });
    let allowed = 0;
    for (let i = 0; i < 20; i++) if ((await one.check("198.51.100.5")).allowed) allowed++;
    expect(allowed).toBe(LIMIT); // correct within one instance
  });
});
