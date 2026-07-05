/**
 * Re-export trading math from @percolatorct/sdk for backward compatibility.
 * The canonical implementation lives in @percolatorct/sdk (math/trading).
 */
export {
  computeMarkPnl,
  computeLiqPrice,
  computePreTradeLiqPrice,
  computeTradingFee,
  computePnlPercent,
  computeEstimatedEntryPrice,
  computeFundingRateAnnualized,
  computeRequiredMargin,
  computeMaxLeverage,
} from "@percolatorct/sdk";

/**
 * Estimate an effective entry price when no on-chain or client-cached entry
 * price is available for a position.
 *
 * v17 doesn't store entry_price on-chain (same as v12.17 — see
 * useUserAccount's portfolioV17ToAccount), so the app normally recovers it
 * from a client-side cache saved at trade-open time (lib/entry-price.ts).
 * That cache is keyed to the browser that opened the trade, so it is NEVER
 * populated for a Position NFT received via transfer — the recipient's
 * browser never ran the trade. Naively substituting the current mark price
 * as "entry" makes the row look like the position has zero PnL (entry ==
 * mark), which then cascades into computeLiqPrice clamping to 0 ("N/A")
 * while a DIFFERENT, disconnected number is shown in the PnL column.
 *
 * Instead, invert the exact computeMarkPnl formula this app already trusts,
 * using the position's on-chain unrealized PnL as ground truth, to back out
 * the entry price implied by it. This keeps entry/liq/pnl/roe internally
 * self-consistent (computeMarkPnl(size, derivedEntry, mark) === onChainPnl)
 * instead of mixing an "entry == mark" placeholder with an unrelated PnL
 * figure. Falls back to `oraclePrice` (no distance travelled) when there's
 * no position or mark to work with, matching computeMarkPnl's own fallback.
 */
export function estimateEntryFromPnl(
  positionSize: bigint,
  onChainPnl: bigint,
  oraclePrice: bigint,
): bigint {
  if (positionSize === 0n || oraclePrice === 0n) return oraclePrice;
  const absPos = positionSize < 0n ? -positionSize : positionSize;
  // computeMarkPnl: pnl = diff * absPos / oraclePrice, where
  //   diff = oraclePrice - entry (longs) or entry - oraclePrice (shorts).
  // Invert: diff = onChainPnl * oraclePrice / absPos.
  const diff = (onChainPnl * oraclePrice) / absPos;
  const entry = positionSize > 0n ? oraclePrice - diff : oraclePrice + diff;
  return entry > 0n ? entry : oraclePrice;
}
