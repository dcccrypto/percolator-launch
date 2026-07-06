import { createUpstashRateLimiter } from "./upstash-rate-limit";

const rateLimiter = createUpstashRateLimiter({
  limit: 10,
  windowMs: 60_000,
  prefix: "rl:devnet-mirror-mint",
});

export async function checkMintRateLimit(ip: string): Promise<{ allowed: boolean; retryAfter: number }> {
  const res = await rateLimiter.check(ip);
  return {
    allowed: res.allowed,
    retryAfter: res.retryAfterSecs,
  };
}
