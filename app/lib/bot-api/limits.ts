/**
 * Weighted rate limits for the bot API (fixed 60 s windows in the bot-API KV).
 *
 * Every endpoint has a weight (a read 1, a quote 2, a build 10: a build is program scans + several simulations on the
 * server's RPC). A caller has a budget of weight per minute by tier; builds also draw on one global ceiling so all keys
 * together cannot spend the RPC quota the app's own pages need. Numbers are published in the OpenAPI spec.
 */
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

export interface LimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window resets. */
  resetSec: number;
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
  if (used > limit) return { allowed: false, limit, remaining: 0, resetSec };
  if (opts.build) {
    const all = await kv.incrBy(`botapi:rl:all-build:${w}`, weight, WINDOW_SEC + 5);
    if (all > GLOBAL_BUILD_BUDGET) return { allowed: false, limit, remaining: Math.max(0, limit - used), resetSec };
  }
  return { allowed: true, limit, remaining: Math.max(0, limit - used), resetSec };
}

/** Auth failures per IP: after this many bad keys in a window, the IP is refused until the window ends. */
export const AUTH_FAIL_LIMIT = 20;
export async function noteAuthFailure(ip: string, kv: Kv = getKv(), nowMs = Date.now()): Promise<void> {
  await kv.incrBy(`botapi:authfail:${ip}:${windowStart(nowMs)}`, 1, WINDOW_SEC + 5);
}
export async function authLocked(ip: string, kv: Kv = getKv(), nowMs = Date.now()): Promise<boolean> {
  const v = await kv.get(`botapi:authfail:${ip}:${windowStart(nowMs)}`);
  return Number(v ?? 0) >= AUTH_FAIL_LIMIT;
}
