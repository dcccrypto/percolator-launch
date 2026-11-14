// @vitest-environment node
/** Council round 1 platform/ops/security findings for the bot API (KV outage, deploy guards, limits, streams, cancel race). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Redis } from "@upstash/redis";
import { botRoute } from "@/lib/bot-api/handler";
import { MemoryKv, UpstashKv, KvUnavailableError, BREAKER_MS, __setKvForTest, type Kv } from "@/lib/bot-api/kv";
import { issueKey, verifyKey } from "@/lib/bot-api/keys";
import { AUTH_FAIL_LIMIT } from "@/lib/bot-api/limits";
import { __resetMetricsForTest } from "@/lib/bot-api/metrics";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";

let now = 1_700_000_000_000;
let kv: MemoryKv;
const req = (path: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) =>
  new NextRequest(`http://x${path}`, { method: init.method ?? "GET", body: init.body, headers: { "x-forwarded-for": "1.2.3.4", ...(init.headers ?? {}) } });

beforeEach(() => {
  now = 1_700_000_000_000;
  vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "devnet");
  vi.stubEnv("BOT_API_ENABLED", "1");
  vi.stubEnv("BOT_API_LOG", "0");
  vi.stubEnv("TRUSTED_PROXY_DEPTH", "1");
  __setDevnetV22ForTest(true);
  kv = new MemoryKv(() => now);
  __setKvForTest(kv);
  __resetMetricsForTest();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
  __setDevnetV22ForTest(null);
  __setKvForTest(null);
});

const readRoute = botRoute({ route: "/v1/t", scope: "read", weight: 1 }, async () => ({ body: { ok: true } }));

/** A Redis stand-in whose every call fails, counting how often it is reached. */
function deadRedis() {
  const calls = { n: 0 };
  const fail = async () => {
    calls.n++;
    throw new Error("connect ECONNREFUSED");
  };
  return { calls, redis: { get: fail, set: fail, del: fail, incrby: fail, expire: fail } as unknown as Redis };
}

describe("operator F1: a KV outage is a retryable 503, not a 401", () => {
  it("UpstashKv.getAuthoritative throws instead of answering from the empty fallback, and the breaker skips the store", async () => {
    const { calls, redis } = deadRedis();
    const u = new UpstashKv(redis, new MemoryKv(() => now), () => now);
    await expect(u.getAuthoritative("botapi:key:x")).rejects.toBeInstanceOf(KvUnavailableError);
    expect(u.degraded()).toBe(true);
    const after1 = calls.n;
    await expect(u.getAuthoritative("botapi:key:x")).rejects.toBeInstanceOf(KvUnavailableError);
    expect(await u.get("anything")).toBeNull(); // limits/idempotency still fall back
    expect(await u.incrBy("c", 1, 60)).toBe(1);
    expect(calls.n).toBe(after1); // breaker open: Redis not touched
    now += BREAKER_MS + 1;
    expect(u.degraded()).toBe(false);
    await expect(u.getAuthoritative("botapi:key:x")).rejects.toBeInstanceOf(KvUnavailableError);
    expect(calls.n).toBe(after1 + 1); // half-open probe
  });

  it("verifyKey surfaces a failing lookup as kv_unavailable, not null", async () => {
    const { key } = await issueKey({ scopes: ["read"] }, kv);
    const broken: Kv = Object.assign(Object.create(kv) as MemoryKv, {
      get: async () => {
        throw new Error("boom");
      },
    });
    await expect(verifyKey(key, broken)).rejects.toMatchObject({ code: "kv_unavailable", status: 503, retryable: true });
  });

  it("a valid key during an outage gets 503 kv_unavailable fast, and never counts toward the lockout", async () => {
    const { key } = await issueKey({ scopes: ["read"] }, kv);
    const { redis } = deadRedis();
    const outage = new UpstashKv(redis, new MemoryKv(() => now), () => now);
    __setKvForTest(outage);
    const t0 = Date.now();
    for (let i = 0; i < AUTH_FAIL_LIMIT + 5; i++) {
      const res = await readRoute(req("/api/v1/t", { headers: { authorization: `Bearer ${key}` } }));
      expect(res.status).toBe(503);
      const j = await res.json();
      expect(j.error).toMatchObject({ code: "kv_unavailable", retryable: true });
      expect(res.headers.get("Retry-After")).toBe("2");
    }
    expect(Date.now() - t0).toBeLessThan(2_000);
    // Store back: the same key works at once and the IP is not locked out.
    __setKvForTest(kv);
    const ok = await readRoute(req("/api/v1/t", { headers: { authorization: `Bearer ${key}` } }));
    expect(ok.status).toBe(200);
  });
});
