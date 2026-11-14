/**
 * The RPC connection every /api/v1 route uses. web3.js retries an HTTP 429 with 500/1000/2000 ms back-off inside the
 * request, which turned one rate-limited call into 8 s of held function time before a 503. Bot routes fail fast instead:
 * after at most two short retries (250 + 750 ms, enough for a per-method limit on the public devnet RPC to clear) the 429
 * surfaces, the wrapper maps it to a retryable `rpc_unavailable` with Retry-After, and the client backs off.
 */
import type { Commitment, Connection } from "@solana/web3.js";
import { getServerConnection } from "@/lib/server-rpc";

export const BOT_RPC_429_RETRY_MS = [250, 750] as const;

export function getBotConnection(commitment: Commitment = "confirmed"): Connection {
  return getServerConnection(commitment, { disableRetryOnRateLimit: true, rateLimitRetryMs: BOT_RPC_429_RETRY_MS });
}
