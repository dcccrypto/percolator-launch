/**
 * memory-rate-limit.ts
 *
 * Reusable in-memory rate limiter factory for Next.js API routes.
 * Creates a per-process fixed-window limiter keyed by client IP.
 *
 * Suitable for single-instance or serverless deployments (short-lived functions
 * bound memory growth). For multi-instance horizontal scaling, use the
 * Upstash-backed limiters (see upstash-rate-limit.ts).
 *
 * Usage:
 *   const limiter = createMemoryRateLimiter({ limit: 60, windowMs: 60_000 });
 *   if (limiter.isLimited(ip)) return NextResponse.json({ error: "Rate limited" }, { status: 429 });
 */

export interface MemoryRateLimiterOptions {
  /** Max requests allowed per window. */
  limit: number;
  /** Window duration in milliseconds. */
  windowMs: number;
  /** Max entries before forced eviction sweep (default: 500). */
  evictionThreshold?: number;
}

export interface MemoryRateLimiter {
  /**
   * Check if the given key (typically client IP) has exceeded the rate limit.
   * Automatically increments the counter; returns true if over the limit.
   */
  isLimited(key: string): boolean;
  /**
   * Remaining requests in the current window for the given key.
   */
  remaining(key: string): number;
}

export function createMemoryRateLimiter(
  options: MemoryRateLimiterOptions
): MemoryRateLimiter {
  const { limit, windowMs, evictionThreshold = 500 } = options;
  const map = new Map<string, { count: number; resetAt: number }>();

  function pruneExpired(): void {
    const now = Date.now();
    for (const [k, v] of map.entries()) {
      if (now > v.resetAt) map.delete(k);
    }
  }

  function getOrCreate(key: string): { count: number; resetAt: number } {
    const now = Date.now();

    // Evict stale entries when map grows large
    if (map.size > evictionThreshold) pruneExpired();

    const entry = map.get(key);
    if (!entry || now > entry.resetAt) {
      const fresh = { count: 0, resetAt: now + windowMs };
      map.set(key, fresh);
      return fresh;
    }
    return entry;
  }

  return {
    isLimited(key: string): boolean {
      const entry = getOrCreate(key);
      entry.count++;
      return entry.count > limit;
    },
    remaining(key: string): number {
      const entry = map.get(key);
      if (!entry || Date.now() > entry.resetAt) return limit;
      return Math.max(0, limit - entry.count);
    },
  };
}
