/**
 * Credential-free daily-claim check for the Sim-USDC faucet, read from chain history.
 *
 * R3 M8: with no durable database the route's only limiter was a process-local Map, which every serverless cold
 * start or second warm instance resets, so one wallet claimed 10,000 twice in a minute. Every faucet mint is
 * fee-paid by the mint authority and touches the recipient's Sim-USDC ATA, so a successful, recent tx on that ATA
 * whose fee payer is the mint authority IS a claim. The chain is the one store every instance shares.
 *
 * Fail-closed: any unreadable answer throws, and so does a history too busy to scan, so the caller refuses
 * instead of minting.
 */
import type { Connection, PublicKey } from "@solana/web3.js";
import { SIM_USDC_CLAIM_WINDOW_MS } from "@/lib/sim-usdc-claim";

/** Newest ATA transactions inspected. A full page still inside the window cannot be proven clear. */
const SCAN_LIMIT = 40;

export class OnchainClaimUnverifiableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnchainClaimUnverifiableError";
  }
}

/** The next-claim time if `ata` got a faucet mint inside the window, else null. Throws when it cannot be known. */
export async function findRecentOnchainClaim(
  connection: Pick<Connection, "getSignaturesForAddress" | "getParsedTransactions">,
  ata: PublicKey,
  mintAuthority: string,
  now: number = Date.now(),
): Promise<string | null> {
  const sigs = await connection.getSignaturesForAddress(ata, { limit: SCAN_LIMIT }, "confirmed");
  const windowStartSec = (now - SIM_USDC_CLAIM_WINDOW_MS) / 1000;
  // Failed txs moved nothing. A null blockTime is treated as recent (conservative).
  const recent = sigs.filter((s) => !s.err && (s.blockTime == null || s.blockTime >= windowStartSec));
  if (recent.length === 0) return null;

  const txs = await connection.getParsedTransactions(
    recent.map((s) => s.signature),
    { commitment: "confirmed", maxSupportedTransactionVersion: 0 },
  );
  let newestMs: number | null = null;
  for (let i = 0; i < recent.length; i++) {
    const tx = txs[i];
    if (!tx) throw new OnchainClaimUnverifiableError(`transaction ${recent[i].signature} unreadable`);
    const payer = tx.transaction.message.accountKeys[0]?.pubkey.toBase58();
    if (payer !== mintAuthority) continue;
    const ms = recent[i].blockTime != null ? recent[i].blockTime! * 1000 : now;
    if (newestMs === null || ms > newestMs) newestMs = ms;
  }
  if (newestMs !== null) return new Date(newestMs + SIM_USDC_CLAIM_WINDOW_MS).toISOString();
  if (sigs.length >= SCAN_LIMIT && recent.length === sigs.length) {
    throw new OnchainClaimUnverifiableError("ATA history too busy to prove no recent claim");
  }
  return null;
}
