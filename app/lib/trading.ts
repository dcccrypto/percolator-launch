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
