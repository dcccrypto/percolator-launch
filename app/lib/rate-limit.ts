/**
 * Shared rate-limiter — Upstash Redis when configured, in-memory fallback.
 *
 * Upstash env vars:
 *   UPSTASH_REDIS_REST_URL — Upstash Redis REST endpoint
 *   UPSTASH_REDIS_REST_TOKEN — Upstash Redis REST token
 *
 * When both are set, uses Upstash Ratelimit (sliding window, works across
 * serverless instances). Otherwise falls back to an in-memory Map (fine for
 * single-instance dev/devnet, not for horizontally-scaled mainnet).
 */
import { NextRequest, NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Upstash (lazy-loaded to avoid import errors when env vars are missing)
// ---------------------------------------------------------------------------
let _upstashLimiter: Map<string, RatelimitInstance> | null = null;

interface RatelimitInstance {
  limit: (key: string) => Promise<{
    success: boolean;
    remaining: number;
    reset: number; // epoch ms
    limit: number;
  }>;
}

function getUpstashLimiter(
  prefix: string,
  maxRequests: number,
  windowSec: number,
): RatelimitInstance | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  if (!_upstashLimiter) _upstashLimiter = new Map();
  const key = `${prefix}:${maxRequests}:${windowSec}`;
  if (_upstashLimiter.has(key)) return _upstashLimiter.get(key)!;

  try {
    // Dynamic import avoids bundling errors when deps aren't installed
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Ratelimit } = require("@upstash/ratelimit") as typeof import("@upstash/ratelimit");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Redis } = require("@upstash/redis") as typeof import("@upstash/redis");

    const redis = new Redis({ url, token });
    const limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(maxRequests, `${windowSec} s`),
      prefix: `rl:${prefix}`,
      analytics: false,
    });
    _upstashLimiter.set(key, limiter);
    return limiter;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// In-memory fallback
// ---------------------------------------------------------------------------
const _memMaps = new Map<string, Map<string, { count: number; resetAt: number }>>();

function getMemMap(prefix: string): Map<string, { count: number; resetAt: number }> {
  let m = _memMaps.get(prefix);
  if (!m) {
    m = new Map();
    _memMaps.set(prefix, m);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RateLimitConfig {
  /** Unique prefix for this limiter (e.g. "create-market"). */
  prefix: string;
  /** Max requests allowed in the window. */
  maxRequests: number;
  /** Window duration in seconds. */
  windowSec: number;
}

/**
 * Extract client IP from request. Uses x-real-ip (set by Vercel/Railway
 * infra, harder to spoof than x-forwarded-for) with x-forwarded-for fallback.
 */
export function getClientIp(req: NextRequest): string {
  return (
    req.headers.get("x-real-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

/**
 * Check rate limit. Returns null if allowed, or a 429 NextResponse if exceeded.
 */
export async function checkRateLimit(
  req: NextRequest,
  config: RateLimitConfig,
): Promise<NextResponse | null> {
  const ip = getClientIp(req);
  const { prefix, maxRequests, windowSec } = config;

  // Try Upstash first
  const upstash = getUpstashLimiter(prefix, maxRequests, windowSec);
  if (upstash) {
    const result = await upstash.limit(ip);
    if (!result.success) {
      const retryAfter = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
      return NextResponse.json(
        { error: `Rate limit exceeded — max ${maxRequests} requests per ${windowSec}s` },
        {
          status: 429,
          headers: {
            "Retry-After": String(retryAfter),
            "X-RateLimit-Limit": String(result.limit),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(retryAfter),
          },
        },
      );
    }
    return null;
  }

  // In-memory fallback
  const windowMs = windowSec * 1000;
  const map = getMemMap(prefix);
  const now = Date.now();
  let entry = map.get(ip);

  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs };
    map.set(ip, entry);
  }

  entry.count++;

  // Periodic cleanup (~0.1% of requests)
  if (Math.random() < 0.001) {
    for (const [key, val] of map) {
      if (now > val.resetAt) map.delete(key);
    }
  }

  if (entry.count > maxRequests) {
    const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    return NextResponse.json(
      { error: `Rate limit exceeded — max ${maxRequests} requests per ${windowSec}s` },
      {
        status: 429,
        headers: {
          "Retry-After": String(retryAfter),
          "X-RateLimit-Limit": String(maxRequests),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(retryAfter),
        },
      },
    );
  }

  return null;
}
