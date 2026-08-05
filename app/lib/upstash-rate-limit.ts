/**
 * upstash-rate-limit.ts
 *
 * Shared Upstash Redis + in-memory fallback rate limiter factory.
 *
 * Primary: Upstash Redis + @upstash/ratelimit (UPSTASH_REDIS_REST_URL /
 *          UPSTASH_REDIS_REST_TOKEN env vars must be set).
 * Fallback: in-memory sliding window (dev / CI / when Redis is unconfigured).
 *           Per-serverless-instance — not suitable for horizontal mainnet scaling.
 *
 * Replaces duplicated code in advance-phase-rate-limit.ts and create-market-rate-limit.ts.
 *
 * Usage:
 *   const limiter = createUpstashRateLimiter({ limit: 60, windowMs: 60_000, prefix: "rl:my-route" });
 *   const result = await limiter.check("127.0.0.1");
 *   if (!result.allowed) return NextResponse.json({ error: "Rate limited" }, { status: 429 });
 */

import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";
import * as Sentry from "@sentry/nextjs";

// ── Types ──────────────────────────────────────────────────────────────────

export interface UpstashRateLimiterOptions {
  /** Max requests allowed per window. */
  limit: number;
  /** Window duration in milliseconds. */
  windowMs: number;
  /** Redis key prefix (e.g. "rl:advance-phase"). Must be unique per limiter. */
  prefix: string;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Requests remaining in current window. */
  remaining: number;
  /** Seconds until rate-limit resets (for Retry-After / X-RateLimit-Reset). */
  retryAfterSecs: number;
}

export interface UpstashRateLimiter {
  check(key: string): Promise<RateLimitResult>;
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createUpstashRateLimiter(
  options: UpstashRateLimiterOptions
): UpstashRateLimiter {
  const { limit, windowMs, prefix } = options;

  // Lazy-init Upstash limiter (singleton per factory call)
  let _ratelimit: Ratelimit | null | undefined;

  function getUpstashLimiter(): Ratelimit | null {
    if (_ratelimit !== undefined) return _ratelimit;
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) {
      _ratelimit = null;
      return null;
    }
    try {
      const redis = new Redis({ url, token });
      _ratelimit = new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(limit, `${windowMs / 1000} s`),
        prefix,
        analytics: false,
      });
      return _ratelimit;
    } catch {
      _ratelimit = null;
      return null;
    }
  }

  // In-memory sliding-window fallback
  const localMap = new Map<string, number[]>();
  // Cap map size to prevent unbounded growth under distributed attacks.
  // Similar to memory-rate-limit.ts evictionThreshold (500).
  const MAP_SIZE_CAP = 500;

  function checkLocal(rateKey: string): RateLimitResult {
    const now = Date.now();
    const windowStart = now - windowMs;

    let timestamps = (localMap.get(rateKey) ?? []).filter((t) => t > windowStart);
    timestamps.push(now);
    localMap.set(rateKey, timestamps);

    // Deterministic cleanup when map exceeds size cap (prevents memory exhaustion)
    if (localMap.size > MAP_SIZE_CAP) {
      for (const [key, ts] of localMap) {
        const pruned = ts.filter((t) => t > windowStart);
        if (pruned.length === 0) localMap.delete(key);
        else localMap.set(key, pruned);
      }
    }

    const count = timestamps.length;
    const allowed = count <= limit;
    const remaining = Math.max(0, limit - count);
    const oldest = timestamps[0];
    const retryAfterMs = oldest
      ? Math.max(0, oldest + windowMs - now)
      : 0;

    return {
      allowed,
      remaining,
      retryAfterSecs: Math.ceil(retryAfterMs / 1000),
    };
  }

  // Alert once per process (production only) when this limiter degrades to the
  // per-instance in-memory fallback. Previously this happened SILENTLY when
  // Upstash was unconfigured, so a misconfigured deploy lost GLOBAL rate limiting
  // with no signal (limits still apply per-instance, but not across the fleet).
  // Making it loud means a degraded deploy can no longer ship unnoticed.
  let _degradedAlerted = false;
  function alertDegradedOnce(reason: string): void {
    if (_degradedAlerted || process.env.NODE_ENV !== "production") return;
    _degradedAlerted = true;
    const msg =
      `[rate-limit] ${prefix}: DEGRADED to per-instance in-memory limiting (${reason}). ` +
      `Rate limits are NOT enforced globally across serverless instances until Upstash ` +
      `(UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN) is configured.`;
    console.error(msg);
    try { Sentry.captureMessage(msg, "error"); } catch { /* best-effort */ }
  }

  return {
    async check(key: string): Promise<RateLimitResult> {
      const limiter = getUpstashLimiter();

      if (limiter) {
        try {
          const result = await limiter.limit(key);
          return {
            allowed: result.success,
            remaining: result.remaining,
            retryAfterSecs: Math.max(
              0,
              Math.ceil((result.reset - Date.now()) / 1000)
            ),
          };
        } catch (err) {
          // Redis/network error — fall through to per-instance in-memory fallback.
          console.warn(
            `[rate-limit] ${prefix}: Redis error, falling back to in-memory limiter (per-instance only).`,
            err instanceof Error ? err.message : err,
          );
          alertDegradedOnce("Redis unreachable");
          return checkLocal(key);
        }
      }

      // limiter === null → Upstash is not configured.
      alertDegradedOnce("Upstash not configured");
      return checkLocal(key);
    },
  };
}
