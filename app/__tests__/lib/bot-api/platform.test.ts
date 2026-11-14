// @vitest-environment node
/** Council round 1 platform/ops/security findings for the bot API (KV outage, deploy guards, limits, streams, cancel race). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Redis } from "@upstash/redis";
import { getServerConnection } from "@/lib/server-rpc";
import { botRoute } from "@/lib/bot-api/handler";
import { MemoryKv, UpstashKv, KvUnavailableError, BREAKER_MS, __setKvForTest, type Kv } from "@/lib/bot-api/kv";
import { issueKey, verifyKey } from "@/lib/bot-api/keys";
import { AUTH_FAIL_LIMIT } from "@/lib/bot-api/limits";
import { __resetMetricsForTest } from "@/lib/bot-api/metrics";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";

vi.mock("@/lib/server-rpc", () => ({ getServerConnection: vi.fn(() => ({})) }));

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
    const spy = vi.mocked(getServerConnection);
    const { getBotConnection } = await import("@/lib/bot-api/rpc");
    getBotConnection();
    expect(spy).toHaveBeenCalledWith("confirmed", { disableRetryOnRateLimit: true, rateLimitRetryMs: [250, 750] });
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

describe("attacker F3: the lockout never refuses a valid key", () => {
  const bad = (n: number) => `pbk_${"Z".repeat(12)}_${"a".repeat(43)}${n}`.slice(0, 4 + 12 + 1 + 43);
  it("a victim's valid key still works on an address that has 20+ failures", async () => {
    const { key } = await issueKey({ scopes: ["read"] }, kv);
    for (let i = 0; i < AUTH_FAIL_LIMIT + 3; i++) await readRoute(req("/api/v1/t", { headers: { authorization: `Bearer ${bad(i)}` } }));
    const bogus = await readRoute(req("/api/v1/t", { headers: { authorization: `Bearer ${bad(0)}` } }));
    expect(bogus.status).toBe(429); // junk keys from that address are still throttled
    const ok = await readRoute(req("/api/v1/t", { headers: { authorization: `Bearer ${key}` } }));
    expect(ok.status).toBe(200);
  });
  it("only failures count: valid calls never lock the address", async () => {
    const { key } = await issueKey({ scopes: ["read"] }, kv);
    for (let i = 0; i < AUTH_FAIL_LIMIT + 3; i++) expect((await readRoute(req("/api/v1/t", { headers: { authorization: `Bearer ${key}` } }))).status).toBe(200);
    expect((await readRoute(req("/api/v1/t", { headers: { authorization: `Bearer ${bad(1)}` } }))).status).toBe(401);
  });
  it("deployed build with an unresolvable address: anonymous refused with 503 client_ip_unknown, keyed callers unaffected and not merged", async () => {
    vi.stubEnv("BOT_API_KEY_PEPPER", "p".repeat(40));
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.invalid");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "t");
    vi.stubEnv("TRUSTED_PROXY_DEPTH", "0");
    const { key } = await issueKey({ scopes: ["read"] }, kv);
    const anon = await readRoute(req("/api/v1/t"));
    expect(anon.status).toBe(503);
    expect((await anon.json()).error.code).toBe("client_ip_unknown");
    // junk keys from "unknown" are not counted into one shared bucket, so they never lock out the keyed bot
    for (let i = 0; i < AUTH_FAIL_LIMIT + 5; i++) expect((await readRoute(req("/api/v1/t", { headers: { authorization: `Bearer ${bad(i)}` } }))).status).toBe(401);
    expect((await readRoute(req("/api/v1/t", { headers: { authorization: `Bearer ${key}` } }))).status).toBe(200);
  });
  it("local (no VERCEL) with no proxy depth keeps working anonymously", async () => {
    vi.stubEnv("TRUSTED_PROXY_DEPTH", "0");
    expect((await readRoute(req("/api/v1/t"))).status).toBe(200);
  });
});

describe("attacker F1: anonymous IPv6 callers are budgeted by /64", () => {
  it("clientBucket collapses a /64 and leaves IPv4 alone", async () => {
    const { clientBucket } = await import("@/lib/bot-api/limits");
    expect(clientBucket("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(clientBucket("2001:db8:1:2::1"));
    expect(clientBucket("2001:db8:1:2::1")).not.toBe(clientBucket("2001:db8:1:3::1"));
    expect(clientBucket("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(clientBucket("1.2.3.4")).toBe("1.2.3.4");
    expect(clientBucket("::1")).toBe("0:0:0:0::/64");
  });
  it("rotating addresses inside one /64 share one anonymous budget", async () => {
    const { TIER_BUDGET } = await import("@/lib/bot-api/limits");
    const heavy = botRoute({ route: "/v1/t", scope: "read", weight: TIER_BUDGET.anon }, async () => ({ body: {} }));
    expect((await heavy(req("/api/v1/t", { headers: { "x-forwarded-for": "2001:db8:9:9::1" } }))).status).toBe(200);
    expect((await heavy(req("/api/v1/t", { headers: { "x-forwarded-for": "2001:db8:9:9:1:2:3:4" } }))).status).toBe(429);
  });
});

describe("attacker F4 + operator F6: shared ceilings", () => {
  it("one principal cannot take more than its share of the global build budget", async () => {
    const { checkLimit, GLOBAL_BUILD_BUDGET, PRINCIPAL_BUILD_CAP } = await import("@/lib/bot-api/limits");
    expect(PRINCIPAL_BUILD_CAP).toBeLessThanOrEqual(GLOBAL_BUILD_BUDGET / 4);
    const mm = { kind: "key" as const, id: "mmX", scopes: ["build" as const], tier: "mm" as const };
    expect((await checkLimit(mm, PRINCIPAL_BUILD_CAP, { kv, nowMs: now, build: true })).allowed).toBe(true);
    const over = await checkLimit(mm, 10, { kv, nowMs: now, build: true });
    expect(over.allowed).toBe(false);
    expect(over.reason).toBe("build-share");
    const other = { kind: "key" as const, id: "other", scopes: ["build" as const], tier: "default" as const };
    expect((await checkLimit(other, 10, { kv, nowMs: now, build: true })).allowed).toBe(true);
  });
  it("reads and streams hit a global ceiling too", async () => {
    const { checkLimit, GLOBAL_READ_BUDGET } = await import("@/lib/bot-api/limits");
    const mk = (i: number) => ({ kind: "key" as const, id: `r${i}`, scopes: ["read" as const], tier: "mm" as const });
    let i = 0;
    for (let spent = 0; spent + 3000 <= GLOBAL_READ_BUDGET; spent += 3000) expect((await checkLimit(mk(i++), 3000, { kv, nowMs: now })).allowed).toBe(true);
    const r = await checkLimit(mk(i++), 10, { kv, nowMs: now });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("global");
  });
});

describe("attacker note: body cap enforced while streaming", () => {
  it("stops pulling a chunked upload at the cap", async () => {
    const { readBodyCapped } = await import("@/lib/bot-api/handler");
    const { MAX_BODY_BYTES } = await import("@/lib/bot-api/config");
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(1024));
        if (pulled > 1000) c.close();
      },
    });
    const r = new Request("http://x/", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    await expect(readBodyCapped(r, MAX_BODY_BYTES)).rejects.toMatchObject({ code: "payload_too_large" });
    expect(pulled).toBeLessThan(20);
  });
  it("accepts a body under the cap", async () => {
    const { readBodyCapped } = await import("@/lib/bot-api/handler");
    expect(await readBodyCapped(new Request("http://x/", { method: "POST", body: '{"a":1}' }), 4096)).toBe('{"a":1}');
  });
});

describe("skeptic F5: pinned constants", () => {
  it("TTL_SEC outlives a blockhash and is the documented 120; body and ceilings are pinned", async () => {
    const { TTL_SEC } = await import("@/lib/bot-api/idempotency");
    const { MAX_BODY_BYTES } = await import("@/lib/bot-api/config");
    const l = await import("@/lib/bot-api/limits");
    expect(TTL_SEC).toBeGreaterThanOrEqual(90);
    expect(TTL_SEC).toBe(120);
    expect(MAX_BODY_BYTES).toBe(4096);
    expect(l.GLOBAL_BUILD_BUDGET).toBe(3000);
    expect(l.GLOBAL_READ_BUDGET).toBe(6000);
    expect(l.PRINCIPAL_BUILD_CAP).toBe(750);
    expect(l.TIER_BUDGET).toEqual({ anon: 60, default: 600, mm: 3000 });
  });
});

describe("first-timer: 401/403 carry X-RateLimit headers", () => {
  it("401 and 403 answers tell the caller its budget", async () => {
    const u = await readRoute(req("/api/v1/t", { headers: { authorization: `Bearer pbk_${"Z".repeat(12)}_${"a".repeat(43)}` } }));
    expect(u.status).toBe(401);
    expect(u.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(u.headers.get("X-RateLimit-Remaining")).toBeTruthy();
    expect(u.headers.get("X-RateLimit-Reset")).toBeTruthy();
    const { key } = await issueKey({ scopes: ["read"] }, kv);
    const buildRoute = botRoute({ route: "/v1/b", scope: "build", weight: 1 }, async () => ({ body: {} }));
    const f = await buildRoute(req("/api/v1/b", { headers: { authorization: `Bearer ${key}` } }));
    expect(f.status).toBe(403);
    expect(f.headers.get("X-RateLimit-Limit")).toBe("600");
  });
});

describe("attacker F2 / skeptic F1: cancel during an in-flight build is not lost", () => {
  it("cancel answers 409 idempotency_in_progress while the build runs, and the build still completes normally", async () => {
    const { POST: cancel } = await import("@/app/api/v1/orders/cancel/route");
    const { key } = await issueKey({ scopes: ["read", "build"] }, kv);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const build = botRoute({ route: "/v1/orders", scope: "build", weight: 10, build: true, body: true, idempotent: true }, async () => {
      await gate;
      return { body: { transaction: "BYTES", lastValidBlockHeight: 99 } };
    });
    const h = { authorization: `Bearer ${key}`, "idempotency-key": "order-0001", "content-type": "application/json" };
    const body = JSON.stringify({ a: 1 });
    const first = build(req("/api/v1/orders", { method: "POST", body, headers: h }));
    await new Promise((r) => setTimeout(r, 20));
    const c = await cancel(req("/api/v1/orders/cancel", { method: "POST", body: JSON.stringify({ idempotencyKey: "order-0001" }), headers: { authorization: `Bearer ${key}` } }));
    expect(c.status).toBe(409);
    const cj = await c.json();
    expect(cj.error).toMatchObject({ code: "idempotency_in_progress", retryable: true });
    expect(cj.cancelled).toBeUndefined();
    release();
    expect((await first).status).toBe(200);
    // Now that the build is done, cancel works and blocks the replay.
    const c2 = await cancel(req("/api/v1/orders/cancel", { method: "POST", body: JSON.stringify({ idempotencyKey: "order-0001" }), headers: { authorization: `Bearer ${key}` } }));
    expect(c2.status).toBe(200);
    const replay = await build(req("/api/v1/orders", { method: "POST", body, headers: h }));
    expect(replay.status).toBe(409);
    expect((await replay.json()).error.code).toBe("order_cancelled");
  });
  it("finishIdempotent never overwrites a cancelled entry (skeptic RACE)", async () => {
    const { beginIdempotent, finishIdempotent } = await import("@/lib/bot-api/idempotency");
    await beginIdempotent("p", "key-race-1", "h", kv);
    // A cancel that landed through some other path (older instance, manual write) before finish runs:
    await kv.set("botapi:idem:p:key-race-1", JSON.stringify({ h: "h", state: "cancelled", lastValidBlockHeight: null }), { ttlSec: 120 });
    await finishIdempotent("p", "key-race-1", "h", { status: 200, body: { transaction: "BYTES" } }, kv);
    expect(await beginIdempotent("p", "key-race-1", "h", kv)).toEqual({ kind: "cancelled" });
  });
  it("cancelIdempotent reports a running build as in progress and leaves it running", async () => {
    const { beginIdempotent, cancelIdempotent, finishIdempotent } = await import("@/lib/bot-api/idempotency");
    await beginIdempotent("p", "key-race-2", "h", kv);
    expect(await cancelIdempotent("p", "key-race-2", kv)).toEqual({ found: true, inProgress: true });
    await finishIdempotent("p", "key-race-2", "h", { status: 200, body: {} }, kv);
    expect((await beginIdempotent("p", "key-race-2", "h", kv)).kind).toBe("replay");
  });
});

describe("attacker F1 / operator F6: stream concurrency and metering", () => {
  const mkRoute = (maxMs = 60_000) =>
    // a long-lived stream plan whose read is trivial
    import("@/lib/bot-api/stream").then(({ sseRoute }) => sseRoute({ route: "/v1/stream", scope: "read", weight: 5 }, async () => ({ read: async () => ({ slot: 1, items: [] }), maxMs })));
  const anonReq = () => req("/api/v1/stream?markets=x");

  it("an anonymous caller may hold 2 streams; the third is 429 until one closes", async () => {
    const route = await mkRoute();
    const a = await route(anonReq());
    const b = await route(anonReq());
    expect([a.status, b.status]).toEqual([200, 200]);
    const c = await route(anonReq());
    expect(c.status).toBe(429);
    expect((await c.json()).error.message).toMatch(/open streams/);
    expect(c.headers.get("Retry-After")).toBe("5");
    await (a as Response).body!.cancel();
    await new Promise((r) => setTimeout(r, 5));
    expect((await route(anonReq())).status).toBe(200);
    await (b as Response).body!.cancel();
  });
  it("a key may hold 5 streams, not 6; slots are per principal", async () => {
    const route = await mkRoute();
    const { key } = await issueKey({ scopes: ["read"] }, kv);
    const open: Response[] = [];
    for (let i = 0; i < 5; i++) {
      const r = (await route(req("/api/v1/stream", { headers: { authorization: `Bearer ${key}` } }))) as Response;
      expect(r.status).toBe(200);
      open.push(r);
    }
    expect((await route(req("/api/v1/stream", { headers: { authorization: `Bearer ${key}` } }))).status).toBe(429);
    expect((await route(anonReq())).status).toBe(200); // someone else is unaffected
    await Promise.all(open.map((r) => r.body!.cancel()));
  });
  it("a rejected prepare frees the slot", async () => {
    const { sseRoute, acquireStreamSlot, MAX_OPEN_STREAMS } = await import("@/lib/bot-api/stream");
    const { ApiError } = await import("@/lib/bot-api/errors");
    const bad = sseRoute({ route: "/v1/stream", scope: "read", weight: 1 }, async () => {
      throw new ApiError("market_not_found");
    });
    for (let i = 0; i < MAX_OPEN_STREAMS.anon + 2; i++) expect((await bad(anonReq())).status).toBe(404);
    expect(await acquireStreamSlot({ id: "ip:1.2.3.4", tier: "anon" }, "x", kv)).not.toBeNull();
  });
  it("slots expire on their own (a dead instance never frees them)", async () => {
    const { acquireStreamSlot, STREAM_SLOT_TTL_SEC, MAX_OPEN_STREAMS } = await import("@/lib/bot-api/stream");
    const p = { id: "ip:9.9.9.9", tier: "anon" as const };
    for (let i = 0; i < MAX_OPEN_STREAMS.anon; i++) expect(await acquireStreamSlot(p, `o${i}`, kv)).not.toBeNull();
    expect(await acquireStreamSlot(p, "late", kv)).toBeNull();
    now += (STREAM_SLOT_TTL_SEC + 1) * 1000;
    expect(await acquireStreamSlot(p, "later", kv)).not.toBeNull();
  });
  it("each tick after the first is charged; when the budget is gone the stream ends with reason rate-limited", async () => {
    vi.useFakeTimers();
    const { marketEventStream } = await import("@/lib/bot-api/stream");
    let reads = 0;
    let allowed = 3;
    let closed = 0;
    const s = marketEventStream({ read: async () => ({ slot: ++reads, items: [] }), charge: async () => allowed-- > 0, onClose: () => closed++ });
    const r = s.getReader();
    const dec = new TextDecoder();
    let text = "";
    const pump = (async () => {
      for (;;) {
        const x = await r.read();
        if (x.done) break;
        text += dec.decode(x.value);
      }
    })();
    await vi.advanceTimersByTimeAsync(30_000);
    await pump;
    expect(reads).toBe(4); // first read free + 3 charged ticks, then refused
    expect(text).toContain('"reason":"rate-limited"');
    expect(closed).toBe(1);
  });
  it("the default charge draws on the principal's budget: a stream cannot outlive a spent anonymous budget", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const { TIER_BUDGET } = await import("@/lib/bot-api/limits");
    const route = await mkRoute();
    // Leave 3 weight after the admission (5): ticks 2..4 pass, tick 5 is refused.
    await kv.incrBy(`botapi:rl:ip:1.2.3.4:${Math.floor(Date.now() / 1000 / 60) * 60}`, TIER_BUDGET.anon - 5 - 3, 65);
    const res = (await route(anonReq())) as Response;
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    const pump = (async () => {
      for (;;) {
        const x = await reader.read();
        if (x.done) break;
        text += dec.decode(x.value);
      }
    })();
    await vi.advanceTimersByTimeAsync(30_000);
    await pump;
    expect(text).toContain("rate-limited");
  });
});

describe("operator F4: health reports degraded", () => {
  const conn = { getSlot: async () => 123, getBlockHeight: async () => 99 };
  beforeEach(() => {
    vi.mocked(getServerConnection).mockReturnValue(conn as never);
  });
  const health = async () => (await import("@/app/api/v1/health/route")).GET(req("/api/v1/health"));

  it("ok on a healthy store", async () => {
    const res = await health();
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toMatchObject({ status: "ok", slot: 123, kv: { backend: "memory", degraded: false, memoryOnDeployedBuild: false }, clientIp: { resolved: true } });
  });
  it("degraded and 503 while the KV is failing", async () => {
    const { redis } = deadRedis();
    __setKvForTest(new UpstashKv(redis, new MemoryKv(() => now), () => now));
    const res = await health();
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.status).toBe("degraded");
    expect(j.kv.degraded).toBe(true);
  });
  it("degraded and 503 when a deployed build runs on the memory backend", async () => {
    // config refuses first when UPSTASH_* is unset, so set it and keep the injected memory store: the state health must flag.
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("BOT_API_KEY_PEPPER", "p".repeat(40));
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.invalid");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "t");
    const res = await health();
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j).toMatchObject({ status: "degraded", kv: { backend: "memory", memoryOnDeployedBuild: true } });
  });
  it("flags an unresolved client address on a deployed build (keyed caller)", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("BOT_API_KEY_PEPPER", "p".repeat(40));
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.invalid");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "t");
    vi.stubEnv("TRUSTED_PROXY_DEPTH", "0");
    const { key } = await issueKey({ scopes: ["read"] }, kv);
    const { GET } = await import("@/app/api/v1/health/route");
    // memory-on-deployed also trips here, so assert the clientIp field rather than the status alone
    const j = await (await GET(req("/api/v1/health", { headers: { authorization: `Bearer ${key}` } }))).json();
    expect(j.clientIp).toEqual({ resolved: false, trustedProxyDepth: 0 });
    expect(j.status).toBe("degraded");
  });
});

describe("first-timer: unknown /api/v1 paths answer the JSON not_found envelope", () => {
  it("every method gets the envelope, not an HTML 404", async () => {
    const m = await import("@/app/api/v1/[...rest]/route");
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
      const res = await m[method](req("/api/v1/nope/at/all", { method }));
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toMatch(/json/);
      expect((await res.json()).error).toMatchObject({ code: "not_found", retryable: false });
    }
  });
  it("answers disabled when the API is off", async () => {
    vi.stubEnv("BOT_API_ENABLED", "");
    const { GET } = await import("@/app/api/v1/[...rest]/route");
    const res = await GET(req("/api/v1/nope"));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("disabled");
  });
});
