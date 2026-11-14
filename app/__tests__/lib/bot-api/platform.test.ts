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

describe("operator F2: refuse to enable on a deployed build without the shared KV", () => {
  it("VERCEL set and no UPSTASH_* -> disabled with a reason; with both set -> allowed", async () => {
    const { botApiDisabledReason } = await import("@/lib/bot-api/config");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    expect(botApiDisabledReason()).toMatch(/shared key store/);
    const res = await readRoute(req("/api/v1/t"));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("disabled");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.invalid");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "t");
    expect(botApiDisabledReason()).toBeNull();
  });
  it("local (no VERCEL) still works on the memory map", async () => {
    const { botApiDisabledReason } = await import("@/lib/bot-api/config");
    vi.stubEnv("VERCEL", "");
    expect(botApiDisabledReason()).toBeNull();
  });
});

describe("operator F3: bot routes fail fast on RPC 429", () => {
  it("getBotConnection disables web3.js 429 retries", async () => {
    vi.resetModules();
    const spy = vi.fn(() => ({}));
    vi.doMock("@/lib/server-rpc", () => ({ getServerConnection: spy }));
    const { getBotConnection } = await import("@/lib/bot-api/rpc");
    getBotConnection();
    expect(spy).toHaveBeenCalledWith("confirmed", { disableRetryOnRateLimit: true });
    vi.doUnmock("@/lib/server-rpc");
  });
  it("no /api/v1 route or bot-api lib calls getServerConnection directly", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
    const files = [...walk(join(process.cwd(), "app/api/v1")), ...walk(join(process.cwd(), "lib/bot-api"))].filter((f) => f.endsWith(".ts") && !f.endsWith("bot-api/rpc.ts"));
    const bad = files.filter((f) => /getServerConnection\(/.test(readFileSync(f, "utf8")));
    expect(bad).toEqual([]);
  });
  it("an upstream 429 thrown by a handler is a retryable 503 rpc_unavailable with Retry-After, not a 500", async () => {
    const r = botRoute({ route: "/v1/t", scope: "read", weight: 1 }, async () => {
      throw new Error("Server responded with 429 Too Many Requests.  https://rpc.example/?api-key=SECRET");
    });
    const res = await r(req("/api/v1/t"));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatchObject({ code: "rpc_unavailable", retryable: true });
    expect(res.headers.get("Retry-After")).toBe("2");
  });
  it("a handler that outlives the deadline answers rpc_unavailable", async () => {
    const r = botRoute({ route: "/v1/t", scope: "read", weight: 1, deadlineMs: 30 }, () => new Promise(() => {}));
    const res = await r(req("/api/v1/t"));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("rpc_unavailable");
  });
  it("log redaction strips URLs and query strings", async () => {
    const { redactUrls } = await import("@/lib/bot-api/errors");
    expect(redactUrls("fetch failed https://devnet.helius-rpc.com/?api-key=abc123 timeout")).toBe("fetch failed <url> timeout");
  });
});
