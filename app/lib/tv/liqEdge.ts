/**
 * Off-screen liquidation indicator for the TradingView chart (the counterpart of lib/chart-liq-edge.ts,
 * #3102, which works from a pixel coordinate; TradingView exposes the price scale's visible RANGE instead).
 *
 * Horizontal-line shapes are not part of the price scale's autoscale, and TradingView does not pin their
 * axis label when the price is outside the visible range, so a liquidation price far from the candles
 * (a low-leverage, cross-margined short) would be invisible. This says which edge it hides behind.
 */
export type LiqEdge = "above" | "below" | null;

export interface VisiblePriceRange { from: number; to: number }

export function liqEdgeFromRange(liq: number | null | undefined, range: VisiblePriceRange | null | undefined): LiqEdge {
  if (liq == null || !Number.isFinite(liq) || !(liq > 0)) return null;
  if (!range || !Number.isFinite(range.from) || !Number.isFinite(range.to) || !(range.to > range.from)) return null;
  if (liq > range.to) return "above";
  if (liq < range.from) return "below";
  return null;
}
