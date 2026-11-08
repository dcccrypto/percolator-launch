/**
 * M7: the price a v2.2 fill EXECUTED at. The wrapper's FILL event (`price_e6`) is "the price the position was BOOKED at"
 * (v22-fill-events.ts): the matcher's execution price, spread and price impact included. The oracle / mark the ticket
 * showed is only the reference the matcher priced off, so it is never a fill price.
 *
 * Trust: same as clipped-fill.ts: the strict frame walk pinned to the wrapper id, successful transactions only, only the
 * record(s) for this market (and asset). `priceE6` and `executedQ` are the wrapper's own statements; `quotedPriceE6` and
 * `requestedQ` are not and are never read here. A read that cannot be trusted or does not arrive is `null` = UNKNOWN: the
 * caller shows no price rather than a mark standing in for one.
 */
import type { Connection, PublicKey } from "@solana/web3.js";
import { decodeTxEventsV22 } from "@/lib/v22/sdk/v22-fill-events";

export interface ExecFill {
  /** Size-weighted booked price over the fill records (e6, per lot on a lot market). */
  priceE6: bigint;
  /** Signed total executed size (positive = taker long), engine position units. */
  executedQ: bigint;
  /** TOTAL engine trade fee of the records (both portfolios), atoms. Informational. */
  feeAtoms: bigint;
}

const abs = (n: bigint): bigint => (n < 0n ? -n : n);

export function execFillFromLogs(
  logs: readonly string[] | null | undefined,
  wrapper: PublicKey,
  o: { market: PublicKey; assetIndex?: number; succeeded?: boolean },
): ExecFill | null {
  const ev = decodeTxEventsV22(o.succeeded ?? true, logs, wrapper);
  if (ev.status !== "known") return null;
  let sumAbs = 0n;
  let sumPx = 0n;
  let signed = 0n;
  let fee = 0n;
  const assets = new Set<number>();
  for (const e of ev.events) {
    if (e.kind !== "fill" || !e.market.equals(o.market)) continue;
    for (const r of e.records) {
      if (o.assetIndex !== undefined && r.assetIndex !== o.assetIndex) continue;
      const q = abs(r.executedQ);
      if (q === 0n || r.priceE6 === 0n) continue;
      assets.add(r.assetIndex);
      sumAbs += q;
      sumPx += q * r.priceE6;
      signed += r.executedQ;
      fee += r.feeAtoms;
    }
  }
  // Prices of two assets cannot be averaged: with no asset named and more than one filled, there is no single price.
  if (sumAbs === 0n || assets.size !== 1) return null;
  return { priceE6: sumPx / sumAbs, executedQ: signed, feeAtoms: fee };
}

/** Reads the landed transaction (a few tries: the serving node may be a beat behind the confirmation). Null = unknown. */
export function readExecFill(
  connection: Pick<Connection, "getTransaction">,
  sig: string,
  wrapper: PublicKey,
  o: { market: PublicKey; assetIndex?: number },
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  tries = 4,
): Promise<ExecFill | null> {
  return (async (): Promise<ExecFill | null> => {
    for (let i = 0; i < tries; i++) {
      try {
        const tx = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        if (tx?.meta) return execFillFromLogs(tx.meta.logMessages, wrapper, { ...o, succeeded: tx.meta.err === null });
      } catch { /* retry */ }
      if (i < tries - 1) await sleep(700);
    }
    return null;
  })();
}

/**
 * Cost of the execution against a reference price, in whole bps, positive = worse for the trader (a buy above, or a sell
 * below, the reference). Null when there is no reference. Truncated toward zero.
 */
export function slippageVsReferenceBps(execE6: bigint, referenceE6: bigint, takerBuys: boolean): number | null {
  if (referenceE6 <= 0n || execE6 <= 0n) return null;
  const diff = takerBuys ? execE6 - referenceE6 : referenceE6 - execE6;
  return Number((diff * 10_000n) / referenceE6);
}
