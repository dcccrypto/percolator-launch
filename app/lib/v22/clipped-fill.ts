/**
 * v2.2 QA (partial fill): the program clips an over-size order to the vault LP's room and still returns Ok. The FILL event of the
 * landed transaction says so (record flag CLIPPED, wrapper fill_events_v22.rs FLAG_CLIPPED) and carries the requested and the
 * executed size, so the ticket can say "Partially filled: X of Y" from the chain's own statement instead of inferring it.
 *
 * Trust: the events are read with the strict frame walk of the SDK port (v22-fill-events.ts) pinned to the wrapper id the market
 * belongs to, only from a successful transaction, and only the record for this market and asset. `requestedQ` is instruction data
 * (display only); `executedQ` is the wrapper's own statement.
 */
import type { Connection, PublicKey } from "@solana/web3.js";
import { TICKET_COPY } from "@/lib/limits/copy";
import { sizeLots, sizeTokens } from "@/lib/v22/growth-room";
import { decodeTxEventsV22, FILL_FLAG_V22, type FillRecordV22 } from "@/lib/v22/sdk/v22-fill-events";

export interface ClippedFill {
  /** |requested| and |executed| in position units (what the ticket's size formatter takes). */
  requestedQ: bigint;
  executedQ: bigint;
  /** executed is 0: nothing filled (the ticket's zero-fill path already words this). */
  zero: boolean;
}

const abs = (n: bigint): bigint => (n < 0n ? -n : n);

export function clippedFillFromLogs(
  logs: readonly string[] | null | undefined,
  wrapper: PublicKey,
  o: { market: PublicKey; assetIndex?: number; succeeded?: boolean },
): ClippedFill | null {
  const ev = decodeTxEventsV22(o.succeeded ?? true, logs, wrapper);
  if (ev.status !== "known") return null;
  let hit: FillRecordV22 | null = null;
  for (const e of ev.events) {
    if (e.kind !== "fill" || !e.market.equals(o.market)) continue;
    for (const r of e.records) {
      if (o.assetIndex !== undefined && r.assetIndex !== o.assetIndex) continue;
      if ((r.flags & FILL_FLAG_V22.CLIPPED) !== 0) hit = r;
    }
  }
  if (!hit) return null;
  const executedQ = abs(hit.executedQ);
  const requestedQ = abs(hit.requestedQ);
  // A clipped record always means executed < requested; anything else is not a statement worth showing.
  if (executedQ >= requestedQ) return null;
  return { requestedQ, executedQ, zero: executedQ === 0n };
}

/** Reads the landed transaction (a few tries: the node serving the read may be a beat behind the confirmation). Null = not clipped / unknown. */
export async function readClippedFill(
  connection: Pick<Connection, "getTransaction">,
  sig: string,
  wrapper: PublicKey,
  o: { market: PublicKey; assetIndex?: number },
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  tries = 4,
): Promise<ClippedFill | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const tx = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (tx?.meta) return clippedFillFromLogs(tx.meta.logMessages, wrapper, { ...o, succeeded: tx.meta.err === null });
    } catch { /* retry */ }
    if (i < tries - 1) await sleep(700);
  }
  return null;
}

/**
 * "Partially filled: X of Y JUP (x of y lots)". Sizes are TOKENS like everywhere on the ticket (q is in lots, POS_SCALE 1e6 per lot,
 * a token size is `q / 1e6 * 10^lotExp`); on a lot market the lot count is added so the two units cannot be mistaken for each other
 * (JUP lot_exp 2: 3.130361 lots = 313.0361 JUP).
 */
export function clippedFillBody(cf: ClippedFill, lotExp: number, ticker: string): string {
  return TICKET_COPY.result.clipped(
    sizeTokens(cf.executedQ, lotExp),
    sizeTokens(cf.requestedQ, lotExp),
    ticker,
    lotExp > 0 ? { filled: sizeLots(cf.executedQ), requested: sizeLots(cf.requestedQ) } : undefined,
  );
}
