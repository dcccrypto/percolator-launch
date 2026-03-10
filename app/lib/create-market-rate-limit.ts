/**
 * Distributed sliding-window rate limiter for POST /api/mobile/create-market.
 *
 * Primary: Upstash Redis + @upstash/ratelimit (UPSTASH_REDIS_REST_URL /
 *          UPSTASH_REDIS_REST_TOKEN env vars must be set).
 * Fallback: in-memory sliding window (dev / CI / when Redis is unconfigured).
 *           Per-serverless-instance — not suitable for horizontal mainnet scaling.
 *
 * Limit: CREATE_MARKET_RATE_LIMIT requests per CREATE_MARKET_RATE_WINDOW_MS.
 */

import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";

export const CREATE_MARKET_RATE_LIMIT = 5;
export const CREATE_MARKET_RATE_WINDOW_MS = 60_000;

// ── Upstash Redis sliding-window limiter (preferred) ───────────────────────
let _ratelimit: Ratelimit | null = null;

function getRatelimiter(): Ratelimit | null {
  if (_ratelimit !== null) return _ratelimit;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const redis = new Redis({ url, token });
    _ratelimit = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(
        CREATE_MARKET_RATE_LIMIT,
        `${CREATE_MARKET_RATE_WINDOW_MS / 1000} s`,
      ),
      prefix: "rl:create-market",
      analytics: false,
    });
    return _ratelimit;
  } catch {
    return null;
  }
}

// ── In-memory sliding-window fallback ─────────────────────────────────────
const _localMap = new Map<string, number[]>();

function checkLocalRateLimit(ip: string): {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
} {
  const now = Date.now();
  const windowStart = now - CREATE_MARKET_RATE_WINDOW_MS;

  // Prune expired timestamps for this IP
  let timestamps = (_localMap.get(ip) ?? []).filter((t) => t > windowStart);
  timestamps.push(now);
  _localMap.set(ip, timestamps);

  // Periodic full cleanup (~0.1% of requests)
  if (Math.random() < 0.001) {
    for (const [key, ts] of _localMap) {
      const pruned = ts.filter((t) => t > windowStart);
      if (pruned.length === 0) _localMap.delete(key);
      else _localMap.set(key, pruned);
    }
  }

  const count = timestamps.length;
  const allowed = count <= CREATE_MARKET_RATE_LIMIT;
  const remaining = Math.max(0, CREATE_MARKET_RATE_LIMIT - count);
  // retryAfter: how long until the oldest in-window request ages out
  const oldest = timestamps[0];
  const retryAfterMs = oldest
    ? Math.max(0, oldest + CREATE_MARKET_RATE_WINDOW_MS - now)
    : 0;
  return { allowed, remaining, retryAfterMs };
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface RateLimitResult {
  allowed: boolean;
  /** Requests remaining in current window. */
  remaining: number;
  /** Seconds until rate-limit resets (for Retry-After / X-RateLimit-Reset). */
  retryAfterSecs: number;
}

export async function checkCreateMarketRateLimit(ip: string): Promise<RateLimitResult> {
  const limiter = getRatelimiter();

  if (limiter) {
    const result = await limiter.limit(ip);
    return {
      allowed: result.success,
      remaining: result.remaining,
      retryAfterSecs: result.success
        ? Math.ceil((result.reset - Date.now()) / 1000)
        : Math.ceil((result.reset - Date.now()) / 1000),
    };
  }

  // In-memory fallback
  const local = checkLocalRateLimit(ip);
  return {
    allowed: local.allowed,
    remaining: local.remaining,
    retryAfterSecs: Math.ceil(local.retryAfterMs / 1000),
  };
}
