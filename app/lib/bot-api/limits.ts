/**
 * Weighted rate limits for the bot API (fixed 60 s windows in the bot-API KV).
 *
 * Every endpoint has a weight (a read 1, a quote 2, a build 10: a build is program scans + several simulations on the
 * server's RPC). A caller has a budget of weight per minute by tier; builds also draw on one global ceiling so all keys
 * together cannot spend the RPC quota the app's own pages need. Numbers are published in the OpenAPI spec.
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

export interface LimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window resets. */
  resetSec: number;
  /** Why it was refused: the caller's own budget, its share of the build budget, or the global ceiling. */
  reason?: "principal" | "build-share" | "global";
}

/**
 * The key an anonymous caller is budgeted under. IPv4 as is; IPv6 by its /64 (one subscriber gets a whole /64, so rotating
 * addresses inside it must not mint new budgets); IPv4-mapped IPv6 as the IPv4. Anything else is returned unchanged.
 */
export function clientBucket(ip: string): string {
  if (isIPv4(ip) || !isIPv6(ip)) return ip;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped && isIPv4(mapped[1])) return mapped[1];
  const [head, tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = ip.includes("::") ? (tail ? tail.split(":") : []) : [];
  const groups = ip.includes("::") ? [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return `${groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(":")}::/64`;
}

function windowStart(nowMs: number) {
  return Math.floor(nowMs / 1000 / WINDOW_SEC) * WINDOW_SEC;
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
    const all = await kv.incrBy(`botapi:rl:all-build:${w}`, weight, WINDOW_SEC + 5);
    if (all > GLOBAL_BUILD_BUDGET) return { allowed: false, limit, remaining, resetSec, reason: "global" };
  } else {
    const all = await kv.incrBy(`botapi:rl:all-read:${w}`, weight, WINDOW_SEC + 5);
    if (all > GLOBAL_READ_BUDGET) return { allowed: false, limit, remaining, resetSec, reason: "global" };
  }
  return { allowed: true, limit, remaining, resetSec };
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
 */
export const AUTH_FAIL_LIMIT = 20;
export async function noteAuthFailure(ip: string, kv: Kv = getKv(), nowMs = Date.now()): Promise<void> {
  await kv.incrBy(`botapi:authfail:${ip}:${windowStart(nowMs)}`, 1, WINDOW_SEC + 5);
}
export async function authLocked(ip: string, kv: Kv = getKv(), nowMs = Date.now()): Promise<boolean> {
  const v = await kv.get(`botapi:authfail:${ip}:${windowStart(nowMs)}`);
  return Number(v ?? 0) >= AUTH_FAIL_LIMIT;
}
