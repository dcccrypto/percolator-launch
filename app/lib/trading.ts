/**
 * Re-export trading math from @percolator/sdk for backward compatibility.
 * The canonical implementation lives in packages/core/src/math/trading.ts.
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
} from "@percolator/sdk";
