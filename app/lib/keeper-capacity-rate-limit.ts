import { createUpstashRateLimiter } from "./upstash-rate-limit";

/**
 * Per-IP limit on GET /api/playground/keeper-capacity. One read per wizard visit and one after a
 * registration, so 60 a minute leaves room for several creators behind one NAT while bounding the
 * Privy-session check and the count query behind it. In-memory per instance when Upstash is unset.
 */
const rateLimiter = createUpstashRateLimiter({
  limit: 60,
  windowMs: 60_000,
  prefix: "rl:keeper-capacity",
});

export async function checkKeeperCapacityRateLimit(ip: string): Promise<{ allowed: boolean; retryAfter: number }> {
  const res = await rateLimiter.check(ip);
  return { allowed: res.allowed, retryAfter: res.retryAfterSecs };
}
