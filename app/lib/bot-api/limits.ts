/**
 * Weighted rate limits for the bot API (in the bot-API KV).
 *
 * Every endpoint has a weight (a read 1, a quote 2, a build 10: a build is program scans + several simulations on the
 * server's RPC). A caller has a budget of weight per minute by tier; builds also draw on one global ceiling so all keys
 * together cannot spend the RPC quota the app's own pages need. Numbers are published in the OpenAPI spec.
 *
 * Window semantics (also in the OpenAPI limits text): the per-caller budgets and the read ceilings are FIXED clock minutes,
 * so a caller can spend up to 2x its budget across a minute boundary (the end of one window plus the start of the next).
 * The global BUILD ceiling, which protects the RPC quota, is a sliding estimate (two-window): the previous minute's total,
 * weighted by how much of it still overlaps the last 60 s, plus this minute's total. It cannot be doubled across a boundary.
 *
 * Reads are split so a flood cannot blind every bot: anonymous callers as a group draw on their own pool (a fixed share of
 * the read ceiling) and never touch the keyed headroom; no single principal may take more than its share of the read
 * ceiling. Builds keep their own per-principal share (PRINCIPAL_BUILD_SHARE).
 */
import { isIPv4, isIPv6 } from "node:net";
import { getKv, type Kv } from "./kv";
import type { Principal } from "./keys";

export const WINDOW_SEC = 60;
export const TIER_BUDGET: Record<Principal["tier"], number> = {
  anon: 60,
  default: 600,
  mm: 3000,
};
/** Weight of builds from all callers together per window. */
export const GLOBAL_BUILD_BUDGET = 3000;
/**
 * No one principal may take more than this share of GLOBAL_BUILD_BUDGET in a window (750 weight = 75 builds/min), so one
 * `mm` key (tier budget 3000) or five default keys cannot starve every other builder. The tier budget still bounds reads.
 */
export const PRINCIPAL_BUILD_SHARE = 0.25;
export const PRINCIPAL_BUILD_CAP = Math.floor(GLOBAL_BUILD_BUDGET * PRINCIPAL_BUILD_SHARE);
/** Weight of everything that is not a build (reads, quotes, stream admissions and ticks) from all callers together per window. */
export const GLOBAL_READ_BUDGET = 6000;
/**
 * Anonymous callers TOGETHER may use at most this share of GLOBAL_READ_BUDGET per window (1500 weight). Anonymous reads are
 * counted in their own pool and are refused when it is full without touching the global counter, so however many addresses
 * an attacker has, keyed bots keep at least (1 - share) of the read ceiling.
 */
export const ANON_READ_SHARE = 0.25;
export const ANON_READ_POOL = Math.floor(GLOBAL_READ_BUDGET * ANON_READ_SHARE);
/** No single principal (key or anonymous bucket) may take more than this share of GLOBAL_READ_BUDGET per window (1500 weight). */
export const PRINCIPAL_READ_SHARE = 0.25;
export const PRINCIPAL_READ_CAP = Math.floor(GLOBAL_READ_BUDGET * PRINCIPAL_READ_SHARE);

export interface LimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window resets. */
  resetSec: number;
  /** Why it was refused: the caller's own budget, its share of the build budget, or the global ceiling. */
  reason?: "principal" | "build-share" | "read-share" | "anon-pool" | "global";
}

/**
 * The key an anonymous caller is budgeted under. IPv4 as is; IPv6 by its /56 (a residential or cloud customer is commonly
 * delegated a /56, i.e. 256 /64s, so rotating inside it must not mint new budgets; a /64 bucket let one /56 mint 256);
 * IPv4-mapped IPv6 as the IPv4. Anything else is returned unchanged. Trade-off: unrelated subscribers who share a /56
 * (rare: it is one customer's delegation) share one anonymous budget; they can take a key to get their own.
 */
export function clientBucket(ip: string): string {
  if (isIPv4(ip) || !isIPv6(ip)) return ip;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped && isIPv4(mapped[1])) return mapped[1];
  const [head, tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = ip.includes("::") ? (tail ? tail.split(":") : []) : [];
  const groups = ip.includes("::") ? [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  const g = groups.slice(0, 4).map((x) => parseInt(x, 16) || 0);
  g[3] &= 0xff00; // keep the top 8 bits of the 4th group: 48 + 8 = 56 bits
  return `${g.map((x) => x.toString(16)).join(":")}::/56`;
}

function windowStart(nowMs: number) {
  return Math.floor(nowMs / 1000 / WINDOW_SEC) * WINDOW_SEC;
}

/** Two-window estimate of weight used in the last WINDOW_SEC: this window's total plus the overlapping share of the last. */
export function slidingEstimate(current: number, previous: number, nowMs: number): number {
  const elapsed = (nowMs / 1000 - windowStart(nowMs)) / WINDOW_SEC;
  return current + Math.floor(previous * (1 - elapsed));
}

export async function checkLimit(
  p: Principal,
  weight: number,
  opts: { build?: boolean; kv?: Kv; nowMs?: number } = {},
): Promise<LimitResult> {
  const kv = opts.kv ?? getKv();
  const now = opts.nowMs ?? Date.now();
  const w = windowStart(now);
  const resetSec = Math.max(1, w + WINDOW_SEC - Math.floor(now / 1000));
  const limit = TIER_BUDGET[p.tier];
  const used = await kv.incrBy(`botapi:rl:${p.id}:${w}`, weight, WINDOW_SEC + 5);
  const remaining = Math.max(0, limit - used);
  if (used > limit) return { allowed: false, limit, remaining: 0, resetSec, reason: "principal" };
  if (opts.build) {
    // Own share first: a principal over its share is refused before it touches (and drains) the global counter.
    const mine = await kv.incrBy(`botapi:rl:build:${p.id}:${w}`, weight, WINDOW_SEC + 5);
    if (mine > PRINCIPAL_BUILD_CAP) return { allowed: false, limit, remaining, resetSec, reason: "build-share" };
    // Sliding: keep the counter two windows so the next window can see this one. A refused request gives its weight back,
    // so a flood of refusals does not inflate what the next window sees.
    const key = `botapi:rl:all-build:${w}`;
    const all = await kv.incrBy(key, weight, 2 * WINDOW_SEC + 5);
    const prev = Number((await kv.get(`botapi:rl:all-build:${w - WINDOW_SEC}`)) ?? 0);
    if (slidingEstimate(all, prev, now) > GLOBAL_BUILD_BUDGET) {
      await kv.incrBy(key, -weight, 2 * WINDOW_SEC + 5);
      return { allowed: false, limit, remaining, resetSec, reason: "global" };
    }
  } else {
    // Own share of the read ceiling first, then the anonymous pool (anonymous only) and the global counter.
    const mine = await kv.incrBy(`botapi:rl:read:${p.id}:${w}`, weight, WINDOW_SEC + 5);
    if (mine > PRINCIPAL_READ_CAP) return { allowed: false, limit, remaining, resetSec, reason: "read-share" };
    if (p.tier === "anon") {
      const pool = await kv.incrBy(`botapi:rl:anon-read:${w}`, weight, WINDOW_SEC + 5);
      if (pool > ANON_READ_POOL) return { allowed: false, limit, remaining, resetSec, reason: "anon-pool" };
    }
    // Anonymous traffic (capped above) is counted here too, so keyed callers never get more than the rest of the ceiling.
    const all = await kv.incrBy(`botapi:rl:all-read:${w}`, weight, WINDOW_SEC + 5);
    if (all > GLOBAL_READ_BUDGET) return { allowed: false, limit, remaining, resetSec, reason: "global" };
  }
  return { allowed: true, limit, remaining, resetSec };
}

/**
 * Charge extra weight after the work turned out to cost more than the route's flat weight (history scans one RPC call per
 * portfolio). Never refuses the request that already did the work; the spend counts against the next ones.
 */
export async function chargeExtra(p: Principal, weight: number, opts: { kv?: Kv; nowMs?: number } = {}): Promise<void> {
  if (weight > 0) await checkLimit(p, weight, opts);
}

/** What a caller has left in this window, without spending anything (for headers on 401/403). */
export async function peekLimit(p: Pick<Principal, "id" | "tier">, opts: { kv?: Kv; nowMs?: number } = {}): Promise<LimitResult> {
  const kv = opts.kv ?? getKv();
  const now = opts.nowMs ?? Date.now();
  const w = windowStart(now);
  const limit = TIER_BUDGET[p.tier];
  const used = Number((await kv.get(`botapi:rl:${p.id}:${w}`)) ?? 0);
  return { allowed: true, limit, remaining: Math.max(0, limit - used), resetSec: Math.max(1, w + WINDOW_SEC - Math.floor(now / 1000)) };
}

/**
 * Auth failures per client address (see clientBucket). Only a key that FAILED verification counts, and the check runs after
 * verification: a valid key is never refused because someone else on the same address sent junk. After this many bad keys in a
 * window, further bad keys from the address get 429 until the window ends.
 *
 * Cost of a junk key: one key GET, and (until this instance knows the address is locked) one INCR whose result is the lockout
 * test, so there is no separate read of the counter. A key id just found missing is not looked up again for NEG_CACHE_MS. A
 * locked address still gets its key looked up (one GET), because refusing without looking would refuse a valid key.
 */
export const AUTH_FAIL_LIMIT = 20;
/** How long this instance remembers that a key id does not exist (or is revoked). Issue and revoke are rare; 5 s is the staleness. */
export const NEG_CACHE_MS = 5_000;
const NEG_CACHE_MAX = 5_000;
const negCache = new Map<string, number>();
const lockedLocal = new Map<string, number>();

export function keyKnownMissing(keyId: string, nowMs = Date.now()): boolean {
  const exp = negCache.get(keyId);
  if (exp === undefined) return false;
  if (exp <= nowMs) {
    negCache.delete(keyId);
    return false;
  }
  return true;
}
export function rememberMissingKey(keyId: string, nowMs = Date.now()): void {
  if (negCache.size >= NEG_CACHE_MAX) negCache.delete(negCache.keys().next().value as string);
  negCache.set(keyId, nowMs + NEG_CACHE_MS);
}
export function __resetAuthCachesForTest(): void {
  negCache.clear();
  lockedLocal.clear();
}

/** Counts a failure; true when the address is over the limit (the 21st and later failures in a window). */
export async function noteAuthFailure(ip: string, kv: Kv = getKv(), nowMs = Date.now()): Promise<boolean> {
  const w = windowStart(nowMs);
  if (lockedLocal.get(ip) === w) return true;
  const n = await kv.incrBy(`botapi:authfail:${ip}:${w}`, 1, WINDOW_SEC + 5);
  if (n <= AUTH_FAIL_LIMIT) return false;
  if (lockedLocal.size >= NEG_CACHE_MAX) lockedLocal.delete(lockedLocal.keys().next().value as string);
  lockedLocal.set(ip, w);
  return true;
}
/** Whether the address is over the failure limit right now (read only; the request path uses noteAuthFailure's answer instead). */
export async function authLocked(ip: string, kv: Kv = getKv(), nowMs = Date.now()): Promise<boolean> {
  const v = await kv.get(`botapi:authfail:${ip}:${windowStart(nowMs)}`);
  return Number(v ?? 0) >= AUTH_FAIL_LIMIT; // the next failure from this address is refused
}
