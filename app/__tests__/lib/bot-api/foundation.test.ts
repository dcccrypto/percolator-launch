// @vitest-environment node
/** Bot API foundation: KV, keys, weighted limits, idempotency, error catalog. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryKv } from "@/lib/bot-api/kv";
import { issueKey, verifyKey, revokeKey, parseKey, keyFromHeaders, getKeyRecord } from "@/lib/bot-api/keys";
import { checkLimit, TIER_BUDGET, GLOBAL_BUILD_BUDGET, noteAuthFailure, authLocked, AUTH_FAIL_LIMIT } from "@/lib/bot-api/limits";
import { beginIdempotent, finishIdempotent, cancelIdempotent, validIdempotencyKey, TTL_SEC } from "@/lib/bot-api/idempotency";
import { ApiError, onchainErrorName, apiCodeForOnchain, customCodeOf, ERROR_CATALOG } from "@/lib/bot-api/errors";

let now = 1_700_000_000_000;
let kv: MemoryKv;
beforeEach(() => {
  now = 1_700_000_000_000;
  kv = new MemoryKv(() => now);
});
afterEach(() => {
  delete process.env.BOT_API_KEY_PEPPER;
});

describe("MemoryKv", () => {
  it("expires, honours nx, counts", async () => {
    expect(await kv.set("a", "1", { ttlSec: 2 })).toBe(true);
    expect(await kv.set("a", "2", { nx: true })).toBe(false);
    now += 2_001;
    expect(await kv.get("a")).toBeNull();
    expect(await kv.set("a", "3", { nx: true })).toBe(true);
    expect(await kv.incrBy("c", 5, 60)).toBe(5);
    expect(await kv.incrBy("c", 2, 60)).toBe(7);
    now += 61_000;
    expect(await kv.incrBy("c", 1, 60)).toBe(1);
  });
  it("stays under its cap", async () => {
    const small = new MemoryKv(() => now, 10);
    for (let i = 0; i < 50; i++) await small.set(`k${i}`, "v");
    expect(await small.get("k49")).toBe("v");
    expect(await small.get("k0")).toBeNull();
  });
});

describe("keys", () => {
  it("issues a key that verifies, stores only a hash, and revokes", async () => {
    const { key, record } = await issueKey({ scopes: ["read", "build"], label: "t" }, kv);
    expect(key).toMatch(/^pbk_[A-Za-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
    const secret = parseKey(key)!.secret;
    const stored = await getKeyRecord(record.id, kv);
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect((await verifyKey(key, kv))?.id).toBe(record.id);
    expect(await revokeKey(record.id, kv)).toBe(true);
    expect(await verifyKey(key, kv)).toBeNull();
  });
  it("refuses a wrong secret, a malformed key and an unknown id", async () => {
    const { key } = await issueKey({ scopes: ["read"] }, kv);
    const p = parseKey(key)!;
    const flipped = `pbk_${p.id}_${(p.secret[0] === "A" ? "B" : "A") + p.secret.slice(1)}`;
    expect(await verifyKey(flipped, kv)).toBeNull();
    expect(await verifyKey("pbk_short_x", kv)).toBeNull();
    expect(await verifyKey(`pbk_ZZZZZZZZZZZZ_${p.secret}`, kv)).toBeNull();
  });
  it("a key issued under one pepper does not verify under another", async () => {
    process.env.BOT_API_KEY_PEPPER = "a".repeat(32);
    const { key } = await issueKey({ scopes: ["read"] }, kv);
    process.env.BOT_API_KEY_PEPPER = "b".repeat(32);
    expect(await verifyKey(key, kv)).toBeNull();
  });
  it("reads Bearer and X-API-Key", () => {
    expect(keyFromHeaders(new Headers({ authorization: "Bearer pbk_x" }))).toBe("pbk_x");
    expect(keyFromHeaders(new Headers({ "x-api-key": "pbk_y" }))).toBe("pbk_y");
    expect(keyFromHeaders(new Headers())).toBeNull();
  });
});

describe("weighted limits", () => {
  const p = { kind: "key" as const, id: "k1", scopes: ["read" as const], tier: "default" as const };
  it("spends weight and refuses past the tier budget, then resets with the window", async () => {
    const budget = TIER_BUDGET.default;
    let r = await checkLimit(p, budget - 10, { kv, nowMs: now });
    expect(r).toMatchObject({ allowed: true, remaining: 10, limit: budget });
    r = await checkLimit(p, 10, { kv, nowMs: now });
    expect(r.allowed).toBe(true);
    r = await checkLimit(p, 1, { kv, nowMs: now });
    expect(r.allowed).toBe(false);
    expect(r.resetSec).toBeGreaterThan(0);
    now += 60_000;
    expect((await checkLimit(p, 1, { kv, nowMs: now })).allowed).toBe(true);
  });
  it("anonymous callers get the small budget", async () => {
    const a = { kind: "anon" as const, id: "ip:1.2.3.4", scopes: ["read" as const], tier: "anon" as const };
    expect((await checkLimit(a, TIER_BUDGET.anon, { kv, nowMs: now })).allowed).toBe(true);
    expect((await checkLimit(a, 1, { kv, nowMs: now })).allowed).toBe(false);
  });
  it("builds from all keys share one global ceiling", async () => {
    const mm = (i: number) => ({ kind: "key" as const, id: `mm${i}`, scopes: ["build" as const], tier: "mm" as const });
    let spent = 0;
    let i = 0;
    while (spent + 1000 <= GLOBAL_BUILD_BUDGET) {
      expect((await checkLimit(mm(i++), 1000, { kv, nowMs: now, build: true })).allowed).toBe(true);
      spent += 1000;
    }
    expect((await checkLimit(mm(i++), 1000, { kv, nowMs: now, build: true })).allowed).toBe(false);
  });
  it("locks an IP after repeated bad keys", async () => {
    for (let i = 0; i < AUTH_FAIL_LIMIT - 1; i++) await noteAuthFailure("9.9.9.9", kv, now);
    expect(await authLocked("9.9.9.9", kv, now)).toBe(false);
    await noteAuthFailure("9.9.9.9", kv, now);
    expect(await authLocked("9.9.9.9", kv, now)).toBe(true);
  });
});

describe("idempotency", () => {
  it("new -> in_progress -> replay with the same body; conflict with another", async () => {
    expect(await beginIdempotent("k", "abcdefgh", "h1", kv)).toEqual({ kind: "new" });
    expect(await beginIdempotent("k", "abcdefgh", "h1", kv)).toEqual({ kind: "in_progress" });
    await finishIdempotent("k", "abcdefgh", "h1", { status: 200, body: { tx: "AAA" } }, kv);
    expect(await beginIdempotent("k", "abcdefgh", "h1", kv)).toEqual({ kind: "replay", res: { status: 200, body: { tx: "AAA" } } });
    expect(await beginIdempotent("k", "abcdefgh", "h2", kv)).toEqual({ kind: "conflict" });
    // Another principal with the same header value is a different key.
    expect(await beginIdempotent("other", "abcdefgh", "h2", kv)).toEqual({ kind: "new" });
  });
  it("an error frees the key; the entry expires after the TTL", async () => {
    await beginIdempotent("k", "key-0001", "h", kv);
    await finishIdempotent("k", "key-0001", "h", { status: 503, body: null }, kv);
    expect(await beginIdempotent("k", "key-0001", "h", kv)).toEqual({ kind: "new" });
    await finishIdempotent("k", "key-0001", "h", { status: 200, body: 1 }, kv);
    now += TTL_SEC * 1000 + 1;
    expect(await beginIdempotent("k", "key-0001", "h", kv)).toEqual({ kind: "new" });
  });
  it("cancel blocks any replay and reports lastValidBlockHeight", async () => {
    await beginIdempotent("k", "key-0002", "h", kv);
    await finishIdempotent("k", "key-0002", "h", { status: 200, body: { lastValidBlockHeight: 4242 } }, kv);
    expect(await cancelIdempotent("k", "key-0002", kv)).toEqual({ found: true, alreadyCancelled: false, lastValidBlockHeight: 4242 });
    expect(await beginIdempotent("k", "key-0002", "h", kv)).toEqual({ kind: "cancelled" });
    expect(await cancelIdempotent("k", "key-0002", kv)).toEqual({ found: true, alreadyCancelled: true, lastValidBlockHeight: 4242 });
    expect(await cancelIdempotent("k", "nope-0000", kv)).toEqual({ found: false });
  });
  it("validates the header", () => {
    expect(validIdempotencyKey("short")).toBe(false);
    expect(validIdempotencyKey("ok-key_01:2.3")).toBe(true);
    expect(validIdempotencyKey("x".repeat(129))).toBe(false);
    expect(validIdempotencyKey("has space1")).toBe(false);
  });
});

describe("errors", () => {
  it("names the on-chain codes bots hit and maps the actionable ones", () => {
    expect(onchainErrorName(49)).toBe("EngineInsufficientInitialMargin");
    expect(onchainErrorName(27)).toBe("OracleStale");
    expect(onchainErrorName(21)).toBe("EngineLockActive");
    expect(onchainErrorName(98)).toBe("GrowthUtilisationFeeNotCovered");
    expect(onchainErrorName(121)).toBe("EngineLossStale");
    expect(onchainErrorName(133)).toBe("LevGuardRefused");
    expect(apiCodeForOnchain(49)).toBe("insufficient_margin");
    expect(apiCodeForOnchain(27)).toBe("market_stale");
    expect(apiCodeForOnchain(133)).toBe("leverage_cap_exceeded");
    expect(apiCodeForOnchain(21)).toBe("simulation_failed");
    expect(apiCodeForOnchain(99999)).toBe("simulation_failed");
  });
  it("pulls Custom(n) out of an error or a message", () => {
    expect(customCodeOf({ InstructionError: [3, { Custom: 49 }] })).toBe(49);
    expect(customCodeOf('Transaction simulation failed: {"InstructionError":[1,{"Custom":27}]}')).toBe(27);
    expect(customCodeOf("nope")).toBeNull();
  });
  it("builds the envelope from the catalog", () => {
    const e = new ApiError("insufficient_margin", undefined, { onchain: { code: 49, name: "EngineInsufficientInitialMargin" }, logs: ["l"] });
    expect(e.status).toBe(422);
    expect(e.body()).toEqual({ error: { code: "insufficient_margin", message: ERROR_CATALOG.insufficient_margin.message, retryable: false, onchain: { code: 49, name: "EngineInsufficientInitialMargin" }, logs: ["l"] } });
  });
});
