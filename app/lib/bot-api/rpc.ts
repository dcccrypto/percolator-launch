/**
 * The RPC connection every /api/v1 route uses. web3.js retries an HTTP 429 with 500/1000/2000 ms back-off inside the
 * request, which turned one rate-limited call into 8 s of held function time before a 503. Bot routes fail fast instead:
 * the 429 surfaces at once, the wrapper maps it to a retryable `rpc_unavailable` with Retry-After, and the client backs off.
 */
import type { Commitment, Connection } from "@solana/web3.js";
import { getServerConnection } from "@/lib/server-rpc";

export function getBotConnection(commitment: Commitment = "confirmed"): Connection {
  return getServerConnection(commitment, { disableRetryOnRateLimit: true });
}
