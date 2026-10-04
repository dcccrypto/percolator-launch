/**
 * Which built-in (non-TradingView) chart the trade page renders.
 *
 *   "perp"   the perp-standard chart (Mark / Oracle / Last candles, push-fed)
 *   "legacy" the original trade/DEX-built chart (TradingChart)
 *
 * `?chart=legacy` always asks for the original, and NEXT_PUBLIC_PERP_CHART=0 is the rollback switch.
 */
export type BuiltInChart = "perp" | "legacy";

export function selectBuiltInChart(o: { perpEnabled: boolean; query: string | null }): BuiltInChart {
  if (o.query === "legacy") return "legacy";
  return o.perpEnabled ? "perp" : "legacy";
}

/** The `chart` query parameter of the current page, or null (no window / no param). */
export function chartQueryParam(): string | null {
  try {
    return new URLSearchParams(window.location.search).get("chart");
  } catch {
    return null;
  }
}
