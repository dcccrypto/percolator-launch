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
import { requestedFeeBps } from "@/lib/limits/fee-channel";

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
  /** Number of FILL records (legs) summed in. */
  legs: number;
  /** The slot the transaction landed in (set by readExecFill; undefined from raw logs). */
  slot?: number;
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
  let legs = 0;
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
      legs++;
    }
  }
  // Prices of two assets cannot be averaged: with no asset named and more than one filled, there is no single price.
  if (sumAbs === 0n || assets.size !== 1 || !taker) return null;
  return { bookedPriceE6: sumPx / sumAbs, executedQ: signed, feeAtoms: fee, notionalAtoms: sumPx / 1_000_000n, taker, quotedPriceE6: sumQuote / sumAbs, legs };
}

/** The part of the fee above the base fee: the matcher's spread, and also any growth busy-side fee or dynamic base-fee excess in it: total fee minus the base fee on the notional (never negative). */
export function spreadFeeAtoms(f: ExecFill, baseFeeBps: bigint): bigint {
  const base = (f.notionalAtoms * baseFeeBps) / 10_000n;
  return f.feeAtoms > base ? f.feeAtoms - base : 0n;
}

/**
 * Owner decision 2026-11-12 (item 3): the growth BUSY-SIDE (utilisation) fee is NOT part of the Entry. It is a separate fee the engine
 * charges on an OPEN only (growth_v19.rs util_fee_on_fill_bps; wrapper handle_trade_cpi), as a rate on the whole fill, on top of the base
 * fee and the matcher's request, and it is inside the FILL record's `fee_atoms`. The FILL event does NOT carry it separately, so it is
 * taken from the rate the ticket quoted for THIS order (`busyFeeBps`: the same pure growth formula, on the same notional, that the signed
 * fee cap was built from). Atoms = notional x bps / 1e4, floored.
 */
export function busyFeeAtoms(f: ExecFill, busyFeeBps: bigint | null | undefined): bigint {
  return busyFeeBps != null && busyFeeBps > 0n ? (f.notionalAtoms * busyFeeBps) / 10_000n : 0n;
}

/**
 * The price the trader effectively paid (e6): booked +/- the matcher's SPREAD part of the fee spread over the size. Null when the base fee
 * is unknown (no honest split), never the bare mark.
 *
 * `busyFeeBps` (omitted / 0 = none, the old behaviour): the busy-side rate the order was quoted with. Its atoms are taken out of the
 * per-unit adjustment so the Entry stays the actual fill price and the fee is shown on its own line. The quote is the ticket's read of
 * the state the engine prices from, so it is exact when the side's utilisation has not moved between the quote and the landing. If it
 * moved, the residual (fee - base - busy) no longer fits what the matcher could have charged (it would be negative, or above the quoted
 * spread by more than a bps), and the Entry is treated as UNKNOWN (null) rather than folding the difference into a price.
 */
export function effectivePriceE6(f: ExecFill, baseFeeBps: bigint | null | undefined, busyFeeBps?: bigint | null): bigint | null {
  if (baseFeeBps == null || f.executedQ === 0n) return null;
  let spread = spreadFeeAtoms(f, baseFeeBps);
  const busy = busyFeeAtoms(f, busyFeeBps);
  if (busy > 0n) {
    const oneBp = f.notionalAtoms / 10_000n;
    const tol = oneBp + 3n; // whole-atom rounding of the engine's fee and of the notional
    const rest = spread - busy;
    // The most the matcher's spread can be: its own quote in the event (ceil bps, like the matcher's request), none when it quoted nothing.
    const maxSpread = f.quotedPriceE6 > 0n ? (f.notionalAtoms * requestedFeeBps(f.bookedPriceE6, f.quotedPriceE6)) / 10_000n : 0n;
    if (rest < -tol || rest > maxSpread + tol) return null;
    spread = rest > 0n ? rest : 0n;
  }
  const perUnit = (spread * 1_000_000n) / abs(f.executedQ);
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
        if (tx?.meta) {
          const f = execFillFromLogs(tx.meta.logMessages, wrapper, { ...o, succeeded: tx.meta.err === null });
          return f ? { ...f, slot: tx.slot } : null;
        }
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
