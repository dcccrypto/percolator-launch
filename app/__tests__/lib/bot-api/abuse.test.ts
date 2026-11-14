// @vitest-environment node
/** Council round 2 (attacker/operator/skeptic): read-pool split, junk-key cost, history weight, stream deadline, sliding build ceiling, revoke. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NextRequest } from "next/server";
import type { Redis } from "@upstash/redis";
import { Keypair } from "@solana/web3.js";
import { getServerConnection } from "@/lib/server-rpc";
import { botRoute } from "@/lib/bot-api/handler";
import { MemoryKv, UpstashKv, __setKvForTest, type Kv } from "@/lib/bot-api/kv";
import { issueKey, revokeKey, getKeyRecord } from "@/lib/bot-api/keys";
import {
  ANON_READ_POOL,
  AUTH_FAIL_LIMIT,
  GLOBAL_BUILD_BUDGET,
  GLOBAL_READ_BUDGET,
  PRINCIPAL_READ_CAP,
  WINDOW_SEC,
  __resetAuthCachesForTest,
  checkLimit,
  clientBucket,
  peekLimit,
} from "@/lib/bot-api/limits";
import { __resetMetricsForTest } from "@/lib/bot-api/metrics";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { provenance } from "../../../scripts/bot-api/provenance";

vi.mock("@/lib/server-rpc", () => ({ getServerConnection: vi.fn(() => ({})) }));

let now = 1_700_000_010_000; // 10 s into a window
let kv: MemoryKv;
const req = (path: string, headers: Record<string, string> = {}) => new NextRequest(`http://x${path}`, { headers: { "x-forwarded-for": "1.2.3.4", ...headers } });
const key = (id: string, tier: "default" | "mm" = "default") => ({ kind: "key" as const, id, scopes: ["read" as const], tier });
const anon = (ip: string) => ({ kind: "anon" as const, id: `ip:${clientBucket(ip)}`, scopes: ["read" as const], tier: "anon" as const });

/** Counts every store call; the memory map underneath is real. */
class CountingKv extends MemoryKv {
  ops = { get: 0, set: 0, incr: 0 };
  override async get(k: string) {
    this.ops.get++;
    return super.get(k);
  }
  override async set(k: string, v: string, o?: { ttlSec?: number; nx?: boolean }) {
    this.ops.set++;
    return super.set(k, v, o);
  }
  override async incrBy(k: string, by: number, ttl: number) {
    this.ops.incr++;
    return super.incrBy(k, by, ttl);
  }
  async getAuthoritative(k: string) {
    return this.get(k);
  }
  reset() {
    this.ops = { get: 0, set: 0, incr: 0 };
  }
}

beforeEach(() => {
  now = 1_700_000_010_000;
  vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "devnet");
  vi.stubEnv("BOT_API_ENABLED", "1");
  vi.stubEnv("BOT_API_LOG", "0");
  vi.stubEnv("TRUSTED_PROXY_DEPTH", "1");
  __setDevnetV22ForTest(true);
  kv = new MemoryKv(() => now);
  __setKvForTest(kv);
  __resetMetricsForTest();
  __resetAuthCachesForTest();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
  __setDevnetV22ForTest(null);
  __setKvForTest(null);
});

describe("attacker R2-A / operator D: the read ceiling cannot be drained", () => {
  it("an anonymous flood from every /64 of one /56 is one bucket; from many addresses it stops at the anonymous pool and keyed reads stay 200", async () => {
    // 256 /64s inside one /56 are one budget (60), not 256 budgets
    let admitted = 0;
    for (let i = 0; i < 256; i++) {
      const ip = `2001:db8:77:${i.toString(16).padStart(2, "0")}::1`;
      if ((await checkLimit(anon(ip), 60, { kv, nowMs: now })).allowed) admitted += 60;
    }
    expect(admitted).toBe(60);
    // 400 distinct addresses (IPv4) x 60 each would be 24000 weight: the anonymous pool stops it
    let anonAdmitted = 0;
    let lastReason: string | undefined;
    for (let i = 0; i < 400; i++) {
      const r = await checkLimit(anon(`10.${i >> 8}.${i & 255}.9`), 60, { kv, nowMs: now });
      if (r.allowed) anonAdmitted += 60;
      else lastReason = r.reason;
    }
    expect(anonAdmitted + 60).toBeLessThanOrEqual(ANON_READ_POOL);
    expect(lastReason).toBe("anon-pool");
    // keyed bots keep their reads: several keys, each well within its own share, all 200
    for (let i = 0; i < 10; i++) expect((await checkLimit(key(`bot${i}`), 100, { kv, nowMs: now })).allowed).toBe(true);
  });
  it("the same over HTTP: a victim default key reads 200 after the anonymous pool is spent", async () => {
    const { key: k } = await issueKey({ scopes: ["read"] }, kv);
    for (let i = 0; i < 400; i++) await checkLimit(anon(`10.${i >> 8}.${i & 255}.9`), 60, { kv, nowMs: Date.now() });
    const route = botRoute({ route: "/v1/t", scope: "read", weight: 1 }, async () => ({ body: {} }));
    expect((await route(req("/api/v1/t", { authorization: `Bearer ${k}`, "x-forwarded-for": "5.5.5.5" }))).status).toBe(200);
    // while a fresh anonymous caller is refused with the pool reason
    const res = await route(req("/api/v1/t", { "x-forwarded-for": "6.6.6.6" }));
    expect(res.status).toBe(429);
    expect((await res.json()).error.message).toMatch(/anonymous callers/);
  });
  it("a single key cannot drain the pool: it stops at its read share and others still read", async () => {
    const mm = key("mmA", "mm");
    let spent = 0;
    for (; spent < GLOBAL_READ_BUDGET; spent += 100) {
      const r = await checkLimit(mm, 100, { kv, nowMs: now });
      if (!r.allowed) {
        expect(r.reason).toBe("read-share");
        break;
      }
    }
    expect(spent).toBeLessThanOrEqual(PRINCIPAL_READ_CAP);
    expect(PRINCIPAL_READ_CAP).toBeLessThan(GLOBAL_READ_BUDGET);
    // a second and third mm key, and a default key, are all still served
    for (const id of ["mmB", "mmC"]) expect((await checkLimit(key(id, "mm"), 100, { kv, nowMs: now })).allowed).toBe(true);
    expect((await checkLimit(key("d1"), 1, { kv, nowMs: now })).allowed).toBe(true);
  });
  it("anonymous reads that were refused by the pool never touched the global counter", async () => {
    for (let i = 0; i < 400; i++) await checkLimit(anon(`10.${i >> 8}.${i & 255}.9`), 60, { kv, nowMs: now });
    const w = Math.floor(now / 1000 / WINDOW_SEC) * WINDOW_SEC;
    expect(Number(await kv.get(`botapi:rl:all-read:${w}`))).toBeLessThanOrEqual(ANON_READ_POOL);
  });
});

describe("attacker R2-B: what a junk key costs", () => {
  const junk = (n: number) => `pbk_${"Q".repeat(11)}${String.fromCharCode(97 + (n % 26))}_${"b".repeat(42)}${String.fromCharCode(97 + ((n >> 5) % 26))}`;
  const route = botRoute({ route: "/v1/t", scope: "read", weight: 1 }, async () => ({ body: {} }));
  const send = (k: string, ip = "1.2.3.4") => route(req("/api/v1/t", { authorization: `Bearer ${k}`, "x-forwarded-for": ip }));

  it("once an address is locked a junk key costs one store read and no writes; a repeated key id costs none", async () => {
    const c = new CountingKv(() => now);
    __setKvForTest(c);
    for (let i = 0; i < AUTH_FAIL_LIMIT + 1; i++) await send(junk(i));
    c.reset();
    expect((await send(junk(100))).status).toBe(429); // new key id on a locked address
    expect(c.ops).toEqual({ get: 1, set: 0, incr: 0 });
    c.reset();
    expect((await send(junk(100))).status).toBe(429); // the same key id again
    expect(c.ops).toEqual({ get: 0, set: 0, incr: 0 });
  });
  it("before the lock a junk key is the key read, one counter write (no separate counter read) and the read-only header peek", async () => {
    const c = new CountingKv(() => now);
    __setKvForTest(c);
    expect((await send(junk(1))).status).toBe(401);
    expect(c.ops).toEqual({ get: 2, set: 0, incr: 1 }); // was 2 gets + 1 incr + the peek = 3 reads before this change
  });
  it("a locked address still serves a valid key, and a wrong secret on a real key id does not make the real key look missing", async () => {
    const { key: good } = await issueKey({ scopes: ["read"] }, kv);
    for (let i = 0; i < AUTH_FAIL_LIMIT + 3; i++) await send(junk(i));
    expect((await send(good)).status).toBe(200);
    const id = good.split("_")[1];
    const wrongSecret = `pbk_${id}_${"z".repeat(43)}`;
    expect((await send(wrongSecret, "8.8.8.8")).status).toBe(401);
    expect((await send(good, "8.8.8.8")).status).toBe(200); // not poisoned by the failed attempt
  });
  it("a revoked key stays refused (negative cache never resurrects it)", async () => {
    const { key: k, record } = await issueKey({ scopes: ["read"] }, kv);
    expect((await send(k)).status).toBe(200);
    await revokeKey(record.id, kv);
    expect((await send(k)).status).toBe(401);
  });
});

describe("attacker R2-note: history weight tracks the RPC calls", () => {
  it("charges 3 plus 1 per portfolio scanned", async () => {
    const owners = Array.from({ length: 4 }, () => Keypair.generate().publicKey);
    const wallet = Keypair.generate().publicKey.toBase58();
    const calls = { gpa: 0, sigs: 0 };
    vi.mocked(getServerConnection).mockReturnValue({
      getProgramAccounts: async () => {
        calls.gpa++;
        return { context: { slot: 5 }, value: calls.gpa === 1 ? owners.map((pubkey) => ({ pubkey })) : [] };
      },
      getSignaturesForAddress: async () => {
        calls.sigs++;
        return [];
      },
      getSlot: async () => 5,
    } as never);
    const { GET } = await import("@/app/api/v1/accounts/[wallet]/history/route");
    const { key: k } = await issueKey({ scopes: ["read"] }, kv);
    const res = await GET(req(`/api/v1/accounts/${wallet}/history`, { authorization: `Bearer ${k}` }), { params: Promise.resolve({ wallet }) });
    expect(res.status).toBe(200);
    expect(calls.sigs).toBe(4);
    const id = k.split("_")[1];
    // the principal's tier budget was charged 3 (route) + 4 (portfolios)
    const left = await peekLimit({ id, tier: "default" }, { kv });
    expect(left.limit - left.remaining).toBe(7);
  });
});

describe("attacker R2-note: a stream whose prepare outlives the deadline", () => {
  it("answers 503, frees the slot at the deadline and never parks a plan", async () => {
    const { sseRoute, acquireStreamSlot, pendingStreamPlans } = await import("@/lib/bot-api/stream");
    const route = sseRoute({ route: "/v1/stream", scope: "read", weight: 1, deadlineMs: 30 }, async () => {
      await new Promise((r) => setTimeout(r, 120));
      return { read: async () => ({ slot: 1, items: [] }) };
    });
    const r1 = await route(req("/api/v1/stream"));
    expect(r1.status).toBe(503);
    // freed at the deadline, long before prepare returns and before the 70 s TTL
    expect(await acquireStreamSlot({ id: "ip:1.2.3.4", tier: "anon" }, "x", kv)).not.toBeNull();
    await new Promise((r) => setTimeout(r, 200)); // prepare has returned by now
    expect(pendingStreamPlans()).toBe(0);
    // two timed-out requests no longer lock the caller out of streams
    const r2 = await route(req("/api/v1/stream"));
    const r3 = await route(req("/api/v1/stream"));
    expect([r2.status, r3.status]).toEqual([503, 503]);
    await new Promise((r) => setTimeout(r, 200));
    expect(pendingStreamPlans()).toBe(0);
  });
});

describe("skeptic R2-note: the global build ceiling is sliding", () => {
  const b = (i: number) => ({ kind: "key" as const, id: `bk${i}`, scopes: ["build" as const], tier: "mm" as const });
  const fill = async (at: number) => {
    let n = 0;
    for (let i = 0; i < 100; i++) {
      const r = await checkLimit(b(i), 100, { kv, nowMs: at, build: true });
      if (!r.allowed) break;
      n += 100;
    }
    return n;
  };
  it("a full minute at its end leaves no fresh allowance at the start of the next", async () => {
    const w0 = Math.floor(now / 1000 / WINDOW_SEC) * WINDOW_SEC;
    const end = (w0 + WINDOW_SEC - 1) * 1000;
    expect(await fill(end)).toBe(GLOBAL_BUILD_BUDGET);
    const start = (w0 + WINDOW_SEC) * 1000 + 100; // 0.1 s into the next window
    // a fixed window would admit a whole new budget here (up to 2x across the boundary)
    expect((await checkLimit(b(500), 10, { kv, nowMs: start, build: true })).reason).toBe("global");
    // half a window later about half of it has aged out
    const mid = (w0 + WINDOW_SEC + WINDOW_SEC / 2) * 1000;
    expect((await checkLimit(b(501), 10, { kv, nowMs: mid, build: true })).allowed).toBe(true);
    // a window after that it is gone
    const later = (w0 + 3 * WINDOW_SEC) * 1000;
    expect((await checkLimit(b(502), 10, { kv, nowMs: later, build: true })).allowed).toBe(true);
  });
  it("refusals give their weight back, so a flood of refused builds does not poison the next window", async () => {
    const w0 = Math.floor(now / 1000 / WINDOW_SEC) * WINDOW_SEC;
    expect(await fill(w0 * 1000 + 5000)).toBe(GLOBAL_BUILD_BUDGET);
    for (let i = 0; i < 200; i++) await checkLimit(b(900 + i), 100, { kv, nowMs: w0 * 1000 + 6000, build: true });
    expect(Number(await kv.get(`botapi:rl:all-build:${w0}`))).toBe(GLOBAL_BUILD_BUDGET);
  });
});

describe("skeptic R2-note: provenance records a dirty tree", () => {
  it("dirty is false on a clean repo and true after a change", () => {
    const dir = mkdtempSync(join(tmpdir(), "prov-"));
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { cwd: dir, stdio: "ignore" });
    git("init", "-q");
    writeFileSync(join(dir, "a.txt"), "x");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    expect(provenance(["node", "/x/loadtest.ts"], dir).dirty).toBe(false);
    writeFileSync(join(dir, "a.txt"), "y");
    expect(provenance(["node", "/x/loadtest.ts"], dir).dirty).toBe(true);
  });
});

describe("operator R2-low: revoke and issue never report a write that did not land", () => {
  /** A Redis whose reads work and whose writes fail (a read-only token). */
  const readOnlyRedis = (record: unknown) =>
    ({
      get: async () => JSON.stringify(record),
      set: async () => {
        throw new Error("NOPERM");
      },
      del: async () => 0,
      incrby: async () => 1,
      expire: async () => 1,
    }) as unknown as Redis;

  it("revokeKey throws instead of printing success", async () => {
    const { record } = await issueKey({ scopes: ["read"] }, kv);
    const store: Kv = new UpstashKv(readOnlyRedis(record), new MemoryKv(), Date.now);
    await expect(revokeKey(record.id, store)).rejects.toThrow();
  });
  it("issueKey throws when the shared store refuses the write", async () => {
    const store: Kv = new UpstashKv(readOnlyRedis(null), new MemoryKv(), Date.now);
    await expect(issueKey({ scopes: ["read"] }, store)).rejects.toThrow();
  });
  it("revokeKey on a healthy store still works and re-reads revoked:true", async () => {
    const { record } = await issueKey({ scopes: ["read"] }, kv);
    expect(await revokeKey(record.id, kv)).toBe(true);
    expect((await getKeyRecord(record.id, kv))?.revoked).toBe(true);
  });
});

describe("operator R2-low: every non-stream route outlasts the handler deadline", () => {
  it("exports maxDuration above RPC_DEADLINE_MS", async () => {
    const { RPC_DEADLINE_MS } = await import("@/lib/bot-api/handler");
    const root = join(process.cwd(), "app/api/v1");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name));
        else if (e.name === "route.ts" && !d.includes("[...rest]")) files.push(join(d, e.name));
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThanOrEqual(16);
    for (const f of files) {
      const m = /export const maxDuration = (\d+);/.exec(readFileSync(f, "utf8"));
      expect(m, f).not.toBeNull();
      expect(Number(m![1]) * 1000, f).toBeGreaterThan(RPC_DEADLINE_MS);
    }
  });
});
