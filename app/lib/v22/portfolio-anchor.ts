/**
 * M7 (N-4): the chain anchor of the trade book: the portfolio's matcher sequence, which the wrapper advances on every matcher trade
 * (and deposit / withdraw CAS) of that portfolio. Read AFTER a fill with `minContextSlot` = the fill's slot, so a node that is behind
 * the confirmation can never answer with the pre-trade account; owner-checked against the wrapper program. Null = unknown (the book
 * then refuses to claim a result later; it never guesses).
 */
import type { Connection, PublicKey } from "@solana/web3.js";
import { parsePortfolio } from "@/lib/v22/layout";

export async function readMatcherSequence(
  connection: Pick<Connection, "getAccountInfo">,
  portfolio: PublicKey,
  programId: PublicKey,
  minContextSlot: number | undefined,
): Promise<bigint | null> {
  try {
    if (minContextSlot === undefined) return null;
    const info = await connection.getAccountInfo(portfolio, { commitment: "confirmed", minContextSlot });
    if (!info || !info.owner.equals(programId)) return null;
    const seq = (parsePortfolio(info.data) as { matcherSequence?: unknown }).matcherSequence;
    return typeof seq === "bigint" ? seq : null;
  } catch {
    return null;
  }
}
