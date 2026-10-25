/**
 * PnL History remains opt-in until a verified history
 * data source is available.
 *
 * NEXT_PUBLIC values are embedded at build time.
 */
export function isPortfolioPnlHistoryEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ENABLE_PORTFOLIO_PNL_HISTORY === "1";
}
