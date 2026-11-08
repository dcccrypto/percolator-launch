/**
 * M7: the cost of crossing the matcher's spread / price impact, as the ticket and the close dialog can know it BEFORE the trade.
 *
 * The booked price of a v2.2 fill is the asset MARK (wrapper effective_price), NOT the matcher's execution price. The matcher's
 * quote (oracle +/- total bps, lib/limits/matcher-quote.ts) is CHARGED ONLY through the fee channel (fee_bps = base + requested),
 * so the spread is part of the trading fee where the channel is on (`inFee`) and costs nothing extra anywhere else (channel off:
 * the wrapper refuses a requested fee and books at the mark). This module turns the matcher's own context into the honest pre-trade
 * figure, for information; it NEVER yields an extra cost to add to the fee row or a balance preview:
 *   - "quote": the adaptive matcher's quote for this exact size (same integer math as the program). Still an ESTIMATE: the
 *     volatility term, the LP inventory and the oracle move between the read and the fill.
 *   - "range": a legacy / unquoted matcher. We know the floor (base spread) and the ceiling (max_total); the fill lands in between.
 *   - null: the context could not be read. Callers say "not available before the trade", never "0%".
 * It never reports a zero as a fact: a quote of 0 bps is shown as 0 only when the matcher really quotes 0.
 */
import type { MatcherCtxView } from "@/lib/limits/decode";
import { preTradeQuote } from "@/lib/limits/matcher-quote";

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
): SpreadEstimate | null {
  if (!ctx || oracleE6 <= 0n || sizeQ <= 0n) return null;
  const q = preTradeQuote(ctx, oracleE6, sizeQ, takerBuys);
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
