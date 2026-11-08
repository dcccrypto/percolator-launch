/**
 * M7: what a v2.2 fill COST, from the wrapper's FILL event.
 *
 * `price_e6` is the price the position is BOOKED at, which is the asset's `effective_price` (the MARK) at execution, NOT the matcher's
 * execution price (wrapper v16_program.rs handle_trade_cpi: "the position enters/settles at the asset mark, NOT at the caller-supplied
 * exec_price"; docs/v22-fill-events.md). The matcher's spread is charged through the FEE CHANNEL: `fee_atoms` = base fee + the matcher's
 * requested fee (|exec - oracle| / oracle, on the mark-settled notional). So the price the trader EFFECTIVELY paid is
 *
 *     effective = booked +/- (fee_atoms - base_fee_atoms) / |executed_q|        (+ for a buy, - for a sell)
 *
 * built only from trusted fields. `quoted_price_e6` is the matcher's own claim (untrusted); it is returned for labelling only and is
 * never used as a price. Real tx 27o3fM4W (council): booked 89.535739, fee 106,043 on a 20.0088 USDC notional = 53.0 bps = 30 base +
 * 23 spread, effective 89.7416; the matcher quoted 89.741672.
 *
 * Trust: the strict frame walk pinned to the wrapper id, successful transactions only, only FILL records of this market (and asset, and
 * the user's own portfolio when known). Unknown inputs give null, never a mark standing in for a price.
 */
import type { Connection, PublicKey } from "@solana/web3.js";
import { decodeTxEventsV22 } from "@/lib/v22/sdk/v22-fill-events";

export interface ExecFill {
  /** Size-weighted BOOKED price (the mark at execution), e6 (per lot on a lot market). NOT what the trader paid: see effectivePriceE6. */
  bookedPriceE6: bigint;
  /** Signed total executed size (positive = taker long), engine position units. */
  executedQ: bigint;
  /** TOTAL engine trade fee of the records, atoms (base fee + the matcher's requested fee [+ growth busy-side fee on an open]). */
  feeAtoms: bigint;
  /** Sum of |q| x booked price / 1e6: the notional the fee bps apply to, collateral atoms. */
  notionalAtoms: bigint;
  /** The taker portfolio the event names (`account_a`). */
  taker: PublicKey;
  /** The matcher's own quote (UNTRUSTED, display only, always labelled as the matcher's quote). Size-weighted; 0 when none. */
  quotedPriceE6: bigint;
}

const abs = (n: bigint): bigint => (n < 0n ? -n : n);

export function execFillFromLogs(
  logs: readonly string[] | null | undefined,
  wrapper: PublicKey,
  o: { market: PublicKey; assetIndex?: number; succeeded?: boolean; taker?: PublicKey | null },
): ExecFill | null {
  const ev = decodeTxEventsV22(o.succeeded ?? true, logs, wrapper);
  if (ev.status !== "known") return null;
  let sumAbs = 0n;
  let sumPx = 0n;
  let sumQuote = 0n;
  let signed = 0n;
  let fee = 0n;
  let taker: PublicKey | null = null;
  const assets = new Set<number>();
  for (const e of ev.events) {
    if (e.kind !== "fill" || !e.market.equals(o.market)) continue;
    // L-2: only the user's own portfolio's fills (when the caller knows it).
    if (o.taker && !e.taker.equals(o.taker)) continue;
    for (const r of e.records) {
      if (o.assetIndex !== undefined && r.assetIndex !== o.assetIndex) continue;
      const q = abs(r.executedQ);
      if (q === 0n || r.priceE6 === 0n) continue;
      if (taker && !taker.equals(e.taker)) return null; // two takers and none named: no single answer
      taker = e.taker;
      assets.add(r.assetIndex);
      sumAbs += q;
      sumPx += q * r.priceE6;
      sumQuote += q * r.quotedPriceE6;
      signed += r.executedQ;
      fee += r.feeAtoms;
    }
  }
  // Prices of two assets cannot be averaged: with no asset named and more than one filled, there is no single price.
  if (sumAbs === 0n || assets.size !== 1 || !taker) return null;
  return { bookedPriceE6: sumPx / sumAbs, executedQ: signed, feeAtoms: fee, notionalAtoms: sumPx / 1_000_000n, taker, quotedPriceE6: sumQuote / sumAbs };
}

/** The part of the fee that is the matcher's spread: total fee minus the base fee on the notional (never negative). */
export function spreadFeeAtoms(f: ExecFill, baseFeeBps: bigint): bigint {
  const base = (f.notionalAtoms * baseFeeBps) / 10_000n;
  return f.feeAtoms > base ? f.feeAtoms - base : 0n;
}

/**
 * The price the trader effectively paid (e6): booked +/- the spread part of the fee spread over the size. Null when the base fee is
 * unknown (no honest split), never the bare mark.
 */
export function effectivePriceE6(f: ExecFill, baseFeeBps: bigint | null | undefined): bigint | null {
  if (baseFeeBps == null || f.executedQ === 0n) return null;
  const perUnit = (spreadFeeAtoms(f, baseFeeBps) * 1_000_000n) / abs(f.executedQ);
  const p = f.executedQ > 0n ? f.bookedPriceE6 + perUnit : f.bookedPriceE6 - perUnit;
  return p > 0n ? p : null;
}

/** Reads the landed transaction (a few tries: the serving node may be a beat behind the confirmation). Null = unknown. */
export function readExecFill(
  connection: Pick<Connection, "getTransaction">,
  sig: string,
  wrapper: PublicKey,
  o: { market: PublicKey; assetIndex?: number; taker?: PublicKey | null },
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
