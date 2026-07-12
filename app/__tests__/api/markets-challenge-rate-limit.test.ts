/**
 * SEC: the market-registration challenge endpoint must be per-IP rate limited.
 * It was unauthenticated and unlimited, and each call does a Blob
 * read-modify-write on the shared nonce store — enabling a per-deployer
 * registration lockout (fill a victim's 10 pending slots) and global
 * store thrash. These tests exercise the route's GET against the in-memory
 * limiter fallback (no Upstash env).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Force the in-memory limiter fallback.
vi.mock("@upstash/redis", () => ({ Redis: vi.fn() }));
vi.mock("@upstash/ratelimit", () => ({ Ratelimit: vi.fn() }));

// Stub the nonce store so allowed requests return 200 without touching Blob.
vi.mock("@/lib/playground-nonce-store", () => ({
  createPlaygroundChallenge: vi.fn(async () => ({
    nonce: "test-nonce-uuid",
    expiresAt: new Date(0),
  })),
}));

const VALID_DEPLOYER = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

async function loadRoute(limit: string) {
  vi.resetModules();
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.MARKETS_CHALLENGE_RATE_LIMIT_PER_WINDOW = limit;
  const { NextRequest } = await import("next/server");
  const mod = await import("@/app/api/markets/challenge/route");
  const call = (ip: string) => {
    const req = new NextRequest(
      `http://localhost/api/markets/challenge?deployer=${VALID_DEPLOYER}`,
      { headers: { "x-forwarded-for": ip } },
    );
    return mod.GET(req);
  };
  return { call };
}

describe("GET /api/markets/challenge rate limit", () => {
  beforeEach(() => vi.clearAllMocks());

  it("allows up to the limit then 429s the next request (same IP)", async () => {
    const { call } = await loadRoute("3");
    const ip = "1.1.1.1, 20.0.0.1"; // depth-1 → rightmost = 20.0.0.1
    for (let i = 0; i < 3; i++) {
      expect((await call(ip)).status).toBe(200);
    }
    const blocked = await call(ip);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
  });

  it("gives different IPs independent budgets", async () => {
    const { call } = await loadRoute("2");
    const a = "1.1.1.1, 20.0.1.1";
    const b = "1.1.1.1, 20.0.1.2";
    await call(a);
    await call(a);
    expect((await call(a)).status).toBe(429); // a exhausted
    expect((await call(b)).status).toBe(200); // b independent
  });

  it("a single IP cannot fill a victim's 10 pending-challenge slots (lockout bound)", async () => {
    // With a per-IP cap below the per-deployer MAX_PENDING (10), one attacker
    // IP is 429'd before it can lock out the victim.
    const { call } = await loadRoute("5");
    const attacker = "1.1.1.1, 66.66.66.66";
    let ok = 0;
    for (let i = 0; i < 10; i++) if ((await call(attacker)).status === 200) ok++;
    expect(ok).toBeLessThan(10);
    expect(ok).toBe(5);
  });
});
