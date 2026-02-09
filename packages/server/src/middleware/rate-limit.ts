import type { Context, Next } from "hono";

/**
 * H1: Simple in-memory rate limiter.
 * Read endpoints: 60 req/min per IP.
 * Write endpoints: 10 req/min per IP.
 */

interface RateBucket {
  count: number;
  resetAt: number;
}

const readBuckets = new Map<string, RateBucket>();
const writeBuckets = new Map<string, RateBucket>();

const WINDOW_MS = 60_000;
const READ_LIMIT = 60;
const WRITE_LIMIT = 10;

// Cleanup stale buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of readBuckets) if (v.resetAt <= now) readBuckets.delete(k);
  for (const [k, v] of writeBuckets) if (v.resetAt <= now) writeBuckets.delete(k);
}, 5 * 60_000);

function getClientIp(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

function checkLimit(buckets: Map<string, RateBucket>, ip: string, limit: number): boolean {
  const now = Date.now();
  let bucket = buckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(ip, bucket);
  }
  bucket.count++;
  return bucket.count <= limit;
}

export function readRateLimit() {
  return async (c: Context, next: Next) => {
    const ip = getClientIp(c);
    if (!checkLimit(readBuckets, ip, READ_LIMIT)) {
      return c.json({ error: "Rate limit exceeded" }, 429);
    }
    return next();
  };
}

export function writeRateLimit() {
  return async (c: Context, next: Next) => {
    const ip = getClientIp(c);
    if (!checkLimit(writeBuckets, ip, WRITE_LIMIT)) {
      return c.json({ error: "Rate limit exceeded" }, 429);
    }
    return next();
  };
}
