/**
 * Regression — GH#2487: the public read endpoints must rate-limit through the
 * DISTRIBUTED limiter, not a per-process Map.
 *
 * `/api/trader/[wallet]/trades`, `/api/trader/[wallet]/stats` and `/api/stats`
 * used `createMemoryRateLimiter`, whose state is a Map in one process. On
 * serverless that makes the effective limit `configured × instance count`: a
 * client spread across warm instances is not bounded by the number on the tin.
 *
 * `createUpstashRateLimiter` shares the window through Redis when configured and
 * degrades to the same in-memory behaviour when it is not, so dev and CI are
 * unchanged.
 *
 * The per-instance property is what the bug was about, so that is what is
 * asserted: two independently-constructed limiters sharing a prefix must NOT
 * each hand out a full budget once a shared store is in play. That cannot be
 * observed without Redis, so the binding assertion here is the wiring — each
 * route constructs the distributed limiter and no longer imports the
 * per-process one. A test of the limiter alone would stay green with the routes
 * reverted, which is exactly how this shipped.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createUpstashRateLimiter } from "@/lib/upstash-rate-limit";

const ROUTES = [
  ["trader trades", "app/api/trader/[wallet]/trades/route.ts", "rl:trader-trades"],
  ["trader stats", "app/api/trader/[wallet]/stats/route.ts", "rl:trader-stats"],
  ["protocol stats", "app/api/stats/route.ts", "rl:stats"],
] as const;

const read = (rel: string) => readFileSync(resolve(__dirname, "../..", rel), "utf8");

describe("public read endpoints use the distributed rate limiter", () => {
  it.each(ROUTES)("%s constructs createUpstashRateLimiter", (_label, rel) => {
    const src = read(rel);
    expect(src).toContain("createUpstashRateLimiter(");
    expect(src).toContain('from "@/lib/upstash-rate-limit"');
  });

  it.each(ROUTES)("%s no longer uses the per-process limiter", (_label, rel) => {
    const src = read(rel);
    expect(src).not.toMatch(/createMemoryRateLimiter\s*\(/);
    expect(src).not.toContain('from "@/lib/memory-rate-limit"');
  });

  it.each(ROUTES)("%s uses a distinct Redis prefix", (_label, rel, prefix) => {
    expect(read(rel)).toContain(`prefix: "${prefix}"`);
  });

  it("the three prefixes are distinct (one endpoint cannot spend another's budget)", () => {
    const prefixes = ROUTES.map(([, , p]) => p);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it.each(ROUTES)("%s still derives the key via getClientIp", (_label, rel) => {
    // Proxy-depth handling is the reason this helper exists; swapping limiters
    // must not quietly reintroduce a raw x-forwarded-for read.
    const src = read(rel);
    expect(src).toContain('from "@/lib/get-client-ip"');
    expect(src).not.toMatch(/x-forwarded-for"\)\?\.split\(","\)\[0\]/);
  });

  it.each(ROUTES)("%s awaits the check (the API is async — a bare call is truthy)", (_label, rel) => {
    // `if (rateLimiter.check(ip))` would be a Promise: always truthy, limit
    // silently dead. Assert the awaited form is what's there.
    expect(read(rel)).toMatch(/await\s+rateLimiter\.check\(/);
  });
});

describe("the distributed limiter still bounds a single instance", () => {
  it("caps at the configured limit and reports a retry hint", async () => {
    const limiter = createUpstashRateLimiter({
      limit: 5,
      windowMs: 60_000,
      prefix: "rl:test-trader-2487",
    });
    let allowed = 0;
    for (let i = 0; i < 20; i++) {
      if ((await limiter.check("203.0.113.42")).allowed) allowed++;
    }
    expect(allowed).toBe(5);
    const after = await limiter.check("203.0.113.42");
    expect(after.allowed).toBe(false);
    expect(after.retryAfterSecs).toBeGreaterThan(0);
  });

  it("keeps separate budgets per client IP", async () => {
    const limiter = createUpstashRateLimiter({
      limit: 3,
      windowMs: 60_000,
      prefix: "rl:test-trader-2487b",
    });
    for (let i = 0; i < 3; i++) await limiter.check("198.51.100.1");
    expect((await limiter.check("198.51.100.2")).allowed).toBe(true);
  });
});
