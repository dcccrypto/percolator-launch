/**
 * M7: the cost of crossing the matcher's spread / price impact, as the ticket and the close dialog can know it BEFORE the trade.
 *
 * The booked price of a v2.2 fill is the asset MARK (wrapper effective_price), NOT the matcher's execution price. The matcher's
 * quote (oracle +/- total bps, lib/limits/matcher-quote.ts) is CHARGED ONLY through the fee channel (fee_bps = base + requested),
 * so the spread is part of the trading fee where the channel is on (`inFee`) and costs nothing extra anywhere else (channel off:
 * the wrapper refuses a requested fee and books at the mark). This module turns the matcher's own context into the honest pre-trade
 * figure, for information; it NEVER yields an extra cost to add to the fee row or a balance preview:
 *   - "quote": the adaptive matcher's quote for this exact size (same integer math as the program, on the leg the wrapper sends: the LP's real
 *     position, the capital-derived depth and skew cap, the volatility step). The spread GROWS WITH SIZE (impact = k*n/(D-n) on that depth), so
 *     it is asked per order size and per side. Still an ESTIMATE: the LP's capital and inventory, the volatility term and the oracle move
 *     between the read and the fill.
 *   - "range": a legacy / unquoted matcher. We know the floor (base spread) and the ceiling (max_total); the fill lands in between.
 *   - null: the context could not be read. Callers say "not available before the trade", never "0%".
 * It never reports a zero as a fact: a quote of 0 bps is shown as 0 only when the matcher really quotes 0.
 */
import type { MatcherCtxView } from "@/lib/limits/decode";
import { preTradeQuote, type MatcherExtCaps } from "@/lib/limits/matcher-quote";
import { defaultFeeCapMarginBps } from "@/lib/limits/fee-channel";

/**
 * What the matcher prices on besides the context, for the order's own leg (see lib/limits/matcher-quote.ts `preTradeQuote`):
 * the wrapper's ext-v3 caps, whether the order only reduces the taker's position, the slot (volatility step) and the exec band.
 */
export interface SpreadQuoteOpts {
  ext?: MatcherExtCaps | null;
  takerReducing?: boolean;
  nowSlot?: bigint;
  bandBps?: number;
}

/**
 * `inFee`: the market's fee channel is on, so the matcher's spread is CHARGED AS PART OF THE TRADING FEE (fee_bps = base + requested)
 * and the fee row already contains it. Then the spread is shown for information and must never be added to the fee row or the
 * balance preview a second time.
 */
export type SpreadEstimate =
  | { kind: "quote"; bps: number; execPriceE6: bigint | null; inFee?: boolean }
  | { kind: "range"; minBps: number; maxBps: number; inFee?: boolean };

export function spreadEstimateFromCtx(
  ctx: MatcherCtxView | null | undefined,
  oracleE6: bigint,
  sizeQ: bigint,
  takerBuys: boolean,
  inFee = false,
  opts: SpreadQuoteOpts = {},
): SpreadEstimate | null {
  if (!ctx || oracleE6 <= 0n || sizeQ <= 0n) return null;
  const q = preTradeQuote(ctx, oracleE6, sizeQ, takerBuys, opts);
  if (!q) return null;
  if (q.kind === "adaptive" && q.totalBps !== null && q.fillQ > 0n) {
    return { kind: "quote", bps: Number(q.totalBps), execPriceE6: q.quotePriceE6, ...(inFee ? { inFee } : {}) };
  }
  if (q.kind === "legacy") {
    const min = Math.max(0, q.baseSpreadBps);
    const max = Math.max(min, q.maxTotalBps);
    return { kind: "range", minBps: min, maxBps: max, ...(inFee ? { inFee } : {}) };
  }
  return null;
}

const pct = (bps: number): string => `${(bps / 100).toFixed(2)}%`;

/** The "Spread / price impact" row's value. Always labelled as an estimate; null (unknown) has its own honest words. */
export function spreadValueText(e: SpreadEstimate | null): string {
  if (!e) return "Not available before the trade. The fill price is shown after it.";
  const tail = e.inFee ? ", included in the trading fee" : ", not charged on this market: fills settle at the mark";
  if (e.kind === "quote") return `~${pct(e.bps)} (est.${tail})`;
  return e.minBps === e.maxBps ? `~${pct(e.minBps)} (est.${tail})` : `${pct(e.minBps)} to ${pct(e.maxBps)} (est. range${tail})`;
}

export const SPREAD_LABEL = "Spread / price impact";

/**
 * The displayed fee bps on a fee-channel market: the chain charges base + the matcher's requested fee whether or not the ticket's P2 flag
 * put the QUOTE in the estimate. Add the quote's requested bps (floor for a range) unless `quoteCharged` says the estimate already holds it.
 * Decide on the quote, never on "above base": a busy-side fee also lifts an estimate above base without containing the requested fee.
 * Display only: what is signed is unchanged.
 */
export function feeBpsWithSpread(feeBps: bigint, e: SpreadEstimate | null, quoteCharged: boolean): bigint {
  if (!e?.inFee) return feeBps;
  // Round 10 (review of #3820, MED 3): a quote is exact for the state it was read in; the fee the fill pays can be a few bps higher (the volatility
  // step). The shown fee carries the same margin the signed cap does, so the shown cost is never below what the cap lets through for that drift.
  const margin = e.kind === "quote" ? BigInt(defaultFeeCapMarginBps()) : 0n;
  if (quoteCharged) return feeBps + margin;
  return feeBps + BigInt(e.kind === "quote" ? e.bps : e.minBps) + margin;
}

/**
 * The price an order is expected to FILL at on a fee-channel market: the mark moved by the matcher's spread for THIS order's size, rounded toward
 * the LP as the matcher does (up for a buy, down for a sell), plus the fee-cap margin (an honest upper bound, as the fee row). It is what the position's Entry becomes (booked mark + spread, never the busy-side
 * fee). Null where there is no exact per-size quote or the spread is not charged: the caller keeps its own estimate.
 */
export function quotedFillPriceE6(oracleE6: bigint, e: SpreadEstimate | null, takerBuys: boolean): bigint | null {
  if (!e || e.kind !== "quote" || !e.inFee || oracleE6 <= 0n) return null;
  const bps = BigInt(e.bps) + BigInt(defaultFeeCapMarginBps());
  const num = takerBuys ? oracleE6 * (10_000n + bps) : oracleE6 * (10_000n - bps);
  if (num <= 0n) return null;
  return takerBuys ? (num + 9_999n) / 10_000n : num / 10_000n;
}
