/**
 * Rate limit for the v1 branch of POST /api/playground/keeper-cosign (L-3, security review 2026-10-05).
 *
 * The route is an unauthenticated signing oracle: each v1 request costs the app 2-7 RPC reads (slab, slot,
 * blockhash validity, rent) and one Ed25519 signature with the keeper key. A launch needs ONE v1 request
 * (plus, on fallback, one legacy co-sign that is not counted here), so the limits below are far above any
 * honest use and far below what a scripted caller would want.
 *
 * Same in-memory fixed-window limiter the other app routes use (lib/memory-rate-limit.ts, keyed like
 * app/api/markets/health); per serverless instance, which is the documented trade-off of that helper.
 */
import { createMemoryRateLimiter, type MemoryRateLimiter } from "@/lib/memory-rate-limit";

/** v1 co-sign requests per client IP per minute. */
export const COSIGN_V1_LIMIT_PER_IP = 20;
/** v1 co-sign requests per deployer wallet per minute. */
export const COSIGN_V1_LIMIT_PER_DEPLOYER = 6;
const WINDOW_MS = 60_000;

let perIp: MemoryRateLimiter = createMemoryRateLimiter({ limit: COSIGN_V1_LIMIT_PER_IP, windowMs: WINDOW_MS });
let perDeployer: MemoryRateLimiter = createMemoryRateLimiter({ limit: COSIGN_V1_LIMIT_PER_DEPLOYER, windowMs: WINDOW_MS });

/**
 * Count one v1 co-sign request. Both counters always advance (an IP rotating deployers and a deployer
 * rotating IPs are both bounded).
 *
 * @returns null when allowed, else which limit was hit.
 */
export function cosignV1RateLimited(ip: string, deployer: string): "ip" | "deployer" | null {
  const ipHit = perIp.isLimited(`ip:${ip}`);
  const deployerHit = perDeployer.isLimited(`deployer:${deployer}`);
  if (ipHit) return "ip";
  if (deployerHit) return "deployer";
  return null;
}

/** Tests only: fresh windows. */
export function resetCosignV1RateLimits(): void {
  perIp = createMemoryRateLimiter({ limit: COSIGN_V1_LIMIT_PER_IP, windowMs: WINDOW_MS });
  perDeployer = createMemoryRateLimiter({ limit: COSIGN_V1_LIMIT_PER_DEPLOYER, windowMs: WINDOW_MS });
}
