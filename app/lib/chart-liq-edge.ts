/**
 * Where the liquidation price line sits relative to the visible price pane.
 *
 * lightweight-charts price lines are NOT part of a series' autoscale, so a
 * liquidation price far outside the candles' range — e.g. a far-above-entry liq
 * on a low-leverage / heavily-collateralized short, where the per-leg liq uses
 * the whole account's (cross-margin) capital — is drawn off the top or bottom of
 * the canvas with nothing to show where it went. `priceToCoordinate` still
 * returns a y for such a price: negative when the price maps above the top of
 * the pane, greater than the pane height when it maps below the bottom. That is
 * how we detect an off-screen line and point a chip at the edge it hides behind.
 *
 * @param coord      `series.priceToCoordinate(liqPrice)` — null when the series
 *                   has no price scale yet (no data); treated as "not off-screen".
 * @param paneHeight height of the price pane in px (chart height minus the time
 *                   axis). `<= 0` while the chart is still laying out.
 * @returns `"above"` / `"below"` when the liq line is off that edge, else `null`.
 */
export function liqEdgeFromCoordinate(
  coord: number | null,
  paneHeight: number,
): "above" | "below" | null {
  if (coord == null || !Number.isFinite(coord) || !(paneHeight > 0)) return null;
  if (coord < 0) return "above";
  if (coord > paneHeight) return "below";
  return null;
}
