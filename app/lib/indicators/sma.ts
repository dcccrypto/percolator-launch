import type { Candle, IndicatorPoint } from "./types";

/**
 * Simple Moving Average over a candle's close prices.
 *
 * For each index `i` from `period - 1` to `candles.length - 1`, returns
 * the arithmetic mean of the `period` most recent closes (inclusive of
 * `candles[i]`). The first `period - 1` candles produce no output (the
 * window isn't full yet) — output length is `candles.length - period + 1`.
 *
 * This matches TradingView's SMA convention and any standard reference
 * (Investopedia, TA-Lib's `SMA`).
 *
 * Returns `[]` when the input is empty, when `period < 1`, or when there
 * aren't enough candles to fill one window.
 */
export function simpleMovingAverage(
  candles: readonly Candle[],
  period: number,
): IndicatorPoint[] {
  if (period < 1 || candles.length < period) return [];
  const result: IndicatorPoint[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += candles[i - j].close;
    result.push({ time: candles[i].timestamp, value: sum / period });
  }
  return result;
}
