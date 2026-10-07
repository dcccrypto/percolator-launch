import { createUpstashRateLimiter } from "./upstash-rate-limit";

/**
 * Per-IP limit on POST /api/playground/keeper-register (proof path). Every request costs a slab read,
 * a getTransaction and (past auth) a mainnet pool read, and the creation tx it replays is public, so
 * without a bound one client could drive hundreds of RPC calls a minute through it. A launch's own
 * retry loop sends about 15 requests in its first minute; 40 leaves room for several markets behind
 * one NAT. A 429 here is retryable on the client. In-memory per instance when Upstash is unset.
 */
const rateLimiter = createUpstashRateLimiter({
  limit: 40,
  windowMs: 60_000,
  prefix: "rl:keeper-register",
});

export async function checkKeeperRegisterRateLimit(ip: string): Promise<{ allowed: boolean; retryAfter: number }> {
  const res = await rateLimiter.check(ip);
  return { allowed: res.allowed, retryAfter: res.retryAfterSecs };
}
