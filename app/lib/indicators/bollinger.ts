import type { Candle } from "./types";

/** A single Bollinger Bands point: middle line (SMA) plus the upper and
 *  lower bands at `stdDev` standard deviations from the middle. */
export interface BollingerPoint {
  time: number;
  upper: number;
  middle: number;
  lower: number;
}

/**
 * Bollinger Bands over a candle's close prices.
 *
 * For each window of `period` closes:
 *  - middle = arithmetic mean (SMA)
 *  - σ      = population standard deviation (NOT sample) — divide by `period`
 *  - upper  = middle + stdDev × σ
 *  - lower  = middle − stdDev × σ
 *
 * The output point at index `i` (for i ≥ period - 1) carries the
 * candle's timestamp at the right edge of the window. Output length is
 * exactly `candles.length - period + 1`.
 *
 * **Convention pinned**: population standard deviation is the TradingView
 * convention. Many references and `numpy.std` (default) use sample σ
 * (divide by `period - 1`), which produces values 5–10% wider on small
 * windows. Future contributors who "fix" this to sample σ will silently
 * diverge from every other charting tool — keep population.
 *
 * Returns `[]` when input is empty, when `period < 1`, or when there
 * aren't enough candles to fill one window.
 */
export function bollingerBands(
  candles: readonly Candle[],
  period: number,
  stdDev: number,
): BollingerPoint[] {
  if (period < 1 || candles.length < period) return [];
  const result: BollingerPoint[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += candles[i - j].close;
    const mean = sum / period;
    let variance = 0;
    for (let j = 0; j < period; j++) {
      const diff = candles[i - j].close - mean;
      variance += diff * diff;
    }
    // Population σ: divide by `period`, not `period - 1` (TradingView convention).
    const sigma = Math.sqrt(variance / period);
    result.push({
      time: candles[i].timestamp,
      middle: mean,
      upper: mean + stdDev * sigma,
      lower: mean - stdDev * sigma,
    });
  }
  return result;
}
