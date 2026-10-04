/**
 * Keeps one overlay price line (Liq / Entry) on a lightweight-charts series in
 * sync with a desired price WITHOUT touching the series itself (#2990).
 *
 * - desired null  -> remove the line if one is drawn
 * - line present  -> applyOptions({ price }) in place (no-op if unchanged)
 * - line absent   -> createPriceLine(options with price)
 *
 * The series-rebuild effect in TradingChart nulls the refs when it removes a
 * series (its lines die with it), so after a rebuild this recreates them.
 */
export interface OverlayPriceLine {
  applyOptions(options: { price: number }): void;
  options?(): { price: number };
}

export interface OverlayPriceLineHost<L extends OverlayPriceLine, O> {
  createPriceLine(options: O & { price: number }): L;
  removePriceLine(line: L): void;
}

export function syncOverlayPriceLine<L extends OverlayPriceLine, O>(
  series: OverlayPriceLineHost<L, O> | null | undefined,
  lineRef: { current: L | null },
  price: number | null,
  makeOptions: () => O,
): void {
  if (!series) {
    // No series to draw on; the next rebuild (seriesEpoch bump) retries.
    lineRef.current = null;
    return;
  }
  if (price == null || !Number.isFinite(price) || price <= 0) {
    if (lineRef.current) {
      series.removePriceLine(lineRef.current);
      lineRef.current = null;
    }
    return;
  }
  if (lineRef.current) {
    if (lineRef.current.options?.().price !== price) {
      lineRef.current.applyOptions({ price });
    }
    return;
  }
  lineRef.current = series.createPriceLine({ ...makeOptions(), price });
}
