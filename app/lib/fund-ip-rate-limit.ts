import { createUpstashRateLimiter } from "./upstash-rate-limit";

/**
 * Shared per-IP limit across ALL free-asset ("fund") endpoints — /api/faucet,
 * /api/playground/faucet, /api/auto-fund and /api/devnet-airdrop. Each spends
 * the shared DEVNET_MINT_AUTHORITY_KEYPAIR and gates only on the caller-supplied
 * wallet, so without a per-IP bound one client can drain the shared signer by
 * cycling fresh keypairs (playground-wide DoS). Mirrors the per-IP limit
 * /api/devnet-mirror-mint already applies. Falls back to a per-instance in-memory
 * window when Upstash is unconfigured (see upstash-rate-limit.ts).
 */
const rateLimiter = createUpstashRateLimiter({
  limit: 10,
  windowMs: 60_000,
  prefix: "rl:devnet-fund",
});

export async function checkFundRateLimit(ip: string): Promise<{ allowed: boolean; retryAfter: number }> {
  const res = await rateLimiter.check(ip);
  return { allowed: res.allowed, retryAfter: res.retryAfterSecs };
}
