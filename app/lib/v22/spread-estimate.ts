/**
 * M7: the cost of crossing the matcher's spread / price impact, as the ticket and the close dialog can know it BEFORE the trade.
 *
 * The booked price of a v2.2 fill is the matcher's execution price (oracle +/- total bps, lib/limits/matcher-quote.ts), so a
 * spread applies on every market whose matcher charges one. This module turns the matcher's own context into the honest pre-trade
 * figure:
 *   - "quote": the adaptive matcher's quote for this exact size (same integer math as the program). Still an ESTIMATE: the
 *     volatility term, the LP inventory and the oracle move between the read and the fill.
 *   - "range": a legacy / unquoted matcher. We know the floor (base spread) and the ceiling (max_total); the fill lands in between.
 *   - null: the context could not be read. Callers say "not available before the trade", never "0%".
 * It never reports a zero as a fact: a quote of 0 bps is shown as 0 only when the matcher really quotes 0.
 */
import type { MatcherCtxView } from "@/lib/limits/decode";
import { preTradeQuote } from "@/lib/limits/matcher-quote";

export type SpreadEstimate =
  | { kind: "quote"; bps: number; execPriceE6: bigint | null }
  | { kind: "range"; minBps: number; maxBps: number };

export function spreadEstimateFromCtx(
  ctx: MatcherCtxView | null | undefined,
  oracleE6: bigint,
  sizeQ: bigint,
  takerBuys: boolean,
): SpreadEstimate | null {
  if (!ctx || oracleE6 <= 0n || sizeQ <= 0n) return null;
  const q = preTradeQuote(ctx, oracleE6, sizeQ, takerBuys);
  if (!q) return null;
  if (q.kind === "adaptive" && q.totalBps !== null && q.fillQ > 0n) {
    return { kind: "quote", bps: Number(q.totalBps), execPriceE6: q.quotePriceE6 };
  }
  if (q.kind === "legacy") {
    const min = Math.max(0, q.baseSpreadBps);
    const max = Math.max(min, q.maxTotalBps);
    return { kind: "range", minBps: min, maxBps: max };
  }
  return null;
}

const pct = (bps: number): string => `${(bps / 100).toFixed(2)}%`;

/** The "Spread / price impact" row's value. Always labelled as an estimate; null (unknown) has its own honest words. */
export function spreadValueText(e: SpreadEstimate | null): string {
  if (!e) return "Not available before the trade. The fill price is shown after it.";
  if (e.kind === "quote") return `~${pct(e.bps)} (est.)`;
  return e.minBps === e.maxBps ? `~${pct(e.minBps)} (est.)` : `${pct(e.minBps)} to ${pct(e.maxBps)} (est. range)`;
}

export const SPREAD_LABEL = "Spread / price impact";

/** Estimated cost in collateral atoms of a trade of `notionalAtoms`: the point estimate, or the floor of a range. Null = unknown. */
export function spreadCostAtoms(e: SpreadEstimate | null, notionalAtoms: bigint): bigint | null {
  if (!e || notionalAtoms <= 0n) return null;
  const bps = e.kind === "quote" ? e.bps : e.minBps;
  return (notionalAtoms * BigInt(bps)) / 10_000n;
}
