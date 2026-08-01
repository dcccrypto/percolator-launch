/**
 * Identifies the source currently backing the visible chart series.
 *
 * Mark-price ticks and historical candle sources are deliberately separate:
 * - oracle: built from the same mark-price stream, so the open bar may be
 *   updated directly between the slower React/state aggregation passes;
 * - percolator: updated by actual `trades:<slab>` events;
 * - pyth/dex: refreshed by their own upstream candle feeds.
 */
export type ChartDataSource = 'percolator' | 'pyth' | 'dex' | 'oracle';

export interface LiveOhlcBar<TTime> {
  time: TTime;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface LivePricePoint<TTime> {
  time: TTime;
  value: number;
}

export function resolveChartDataSource(
  hasPercolatorData: boolean,
  hasPythData: boolean,
  hasExternalData: boolean,
): ChartDataSource {
  if (hasPercolatorData) return 'percolator';
  if (hasPythData) return 'pyth';
  if (hasExternalData) return 'dex';
  return 'oracle';
}

/**
 * Merge a live mark into the visible OHLC bar only when that bar was itself
 * built from mark/oracle observations.
 *
 * Returning the original object for external sources is intentional. The
 * caller can use identity to skip `series.update()` completely, preventing a
 * mark tick from overwriting a Pyth, DEX, or trade-derived close.
 */
export function mergeMarkPriceIntoBar<TTime>(
  source: ChartDataSource,
  bar: LiveOhlcBar<TTime>,
  markPriceUsd: number,
): LiveOhlcBar<TTime> {
  if (source !== 'oracle' || !Number.isFinite(markPriceUsd)) return bar;

  return {
    ...bar,
    high: Math.max(bar.high, markPriceUsd),
    low: Math.min(bar.low, markPriceUsd),
    close: markPriceUsd,
  };
}

/** Same source-integrity rule as `mergeMarkPriceIntoBar`, for line/area mode. */
export function mergeMarkPriceIntoPoint<TTime>(
  source: ChartDataSource,
  point: LivePricePoint<TTime>,
  markPriceUsd: number,
): LivePricePoint<TTime> {
  if (source !== 'oracle' || !Number.isFinite(markPriceUsd)) return point;
  return { time: point.time, value: markPriceUsd };
}
