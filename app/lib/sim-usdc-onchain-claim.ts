/**
 * Credential-free daily-claim check for the Sim-USDC faucet, read from chain history.
 *
 * R3 M8: with no durable database the route's only limiter was a process-local Map, which every serverless cold
 * start or second warm instance resets, so one wallet claimed 10,000 twice in a minute. The chain is the one store
 * every instance shares.
 *
 * A FAUCET claim is identified by its CONTENT, not its fee payer: a successful tx on the wallet's Sim-USDC ATA that
 * contains a parsed spl-token mintTo / mintToChecked to THAT ATA of exactly FAUCET_MINT_RAW, paid by the mint
 * authority. Fee payer alone is not enough: /api/auto-fund mints 1,000 on wallet connect with the same authority as
 * fee payer (and anyone can call it for another wallet), and that must not count as a claim.
 * Amounts: /api/faucet and /api/playground/faucet both mint 10,000 x 10^6; /api/auto-fund mints 1,000 x 10^6.
 *
 * Fail-closed: any unreadable answer throws. A page of history that is full and still inside the window (failed
 * txs included: a wallet can push a real claim out of view with its own failing txs) is paged through with
 * `before:` up to MAX_PAGES, then refused if still undecidable.
 */
import type { Connection, PublicKey } from "@solana/web3.js";
import { SIM_USDC_CLAIM_WINDOW_MS } from "@/lib/sim-usdc-claim";

/** What both faucet routes mint per claim: 10,000 Sim-USDC at 6 decimals, as the parsed (string) raw amount. */
export const FAUCET_MINT_RAW = "10000000000";

const PAGE_LIMIT = 40;
const MAX_PAGES = 3;

export type OnchainClaimFailureReason = "unreadable" | "busy";

export class OnchainClaimUnverifiableError extends Error {
  readonly reason: OnchainClaimFailureReason;
  constructor(message: string, reason: OnchainClaimFailureReason = "unreadable") {
    super(message);
    this.name = "OnchainClaimUnverifiableError";
    this.reason = reason;
  }
}

/** The honest 503 body for a failed check: only "unreadable" clears on a retry. */
export function onchainClaimCheckFailure(err: unknown): { error: string; retryable: boolean } {
  if (err instanceof OnchainClaimUnverifiableError && err.reason === "busy") {
    return {
      error:
        "This wallet has too much recent activity for the faucet to confirm your daily claim, so nothing was sent. It can take up to 24 hours to clear.",
      retryable: false,
    };
  }
  return {
    error: "The faucet can't check your daily claim right now, so nothing was sent. Try again in a moment.",
    retryable: true,
  };
}

type ParsedIx = {
  program?: string;
  parsed?: { type?: string; info?: Record<string, unknown> };
};

function isFaucetMintTo(ix: ParsedIx, ata: string): boolean {
  if (ix.program !== "spl-token") return false;
  const p = ix.parsed;
  if (!p || (p.type !== "mintTo" && p.type !== "mintToChecked")) return false;
  const info = p.info ?? {};
  if (info.account !== ata) return false;
  const amount =
    p.type === "mintToChecked"
      ? (info.tokenAmount as { amount?: unknown } | undefined)?.amount
      : info.amount;
  return String(amount) === FAUCET_MINT_RAW;
}

/** The next-claim time if `ata` got a faucet mint inside the window, else null. Throws when it cannot be known. */
export async function findRecentOnchainClaim(
  connection: Pick<Connection, "getSignaturesForAddress" | "getParsedTransactions">,
  ata: PublicKey,
  mintAuthority: string,
  now: number = Date.now(),
): Promise<string | null> {
  const windowStartSec = (now - SIM_USDC_CLAIM_WINDOW_MS) / 1000;
  const ataB58 = ata.toBase58();
  let before: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const sigs = await connection.getSignaturesForAddress(
      ata,
      before ? { limit: PAGE_LIMIT, before } : { limit: PAGE_LIMIT },
      "confirmed",
    );
    // Failed txs moved nothing. A null blockTime is treated as recent (conservative).
    const recent = sigs.filter((s) => !s.err && (s.blockTime == null || s.blockTime >= windowStartSec));
    if (recent.length > 0) {
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
        if (!(tx.transaction.message.instructions as unknown as ParsedIx[]).some((ix) => isFaucetMintTo(ix, ataB58))) {
          continue;
        }
        const ms = recent[i].blockTime != null ? recent[i].blockTime! * 1000 : now;
        if (newestMs === null || ms > newestMs) newestMs = ms;
      }
      if (newestMs !== null) return new Date(newestMs + SIM_USDC_CLAIM_WINDOW_MS).toISOString();
    }

    // Decided "clear" only when the history provably reaches back past the window: a short page, or an OLDEST
    // entry (failed or not) older than the window. Otherwise older entries could still hide a claim.
    const oldest = sigs[sigs.length - 1];
    if (sigs.length < PAGE_LIMIT) return null;
    if (oldest.blockTime != null && oldest.blockTime < windowStartSec) return null;
    before = oldest.signature;
  }
  throw new OnchainClaimUnverifiableError("ATA history too busy to prove no recent claim", "busy");
}
