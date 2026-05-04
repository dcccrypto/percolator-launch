import type { Candle, IndicatorPoint } from "./types";

/**
 * Relative Strength Index using Wilder's smoothing.
 *
 * RSI = 100 − 100 / (1 + RS), where RS = avgGain / avgLoss.
 *
 * Three conventions are pinned here. ALL three must hold for the output to
 * match TradingView's RSI(14) on the same dataset. Future contributors may
 * "fix" any one of them and silently diverge — the JSDoc on each is the
 * load-bearing documentation, NOT the test reference values.
 *
 *  1. **Wilder's smoothing**, NOT a simple-EMA-based RSI:
 *       avgGain[t] = (avgGain[t−1] × (period − 1) + currentGain) / period
 *     Mathematically equivalent to an EMA with k = 1/period. This is LOWER
 *     than a standard EMA's k = 2/(period + 1), which is why Wilder-RSI is
 *     smoother (slower to react) than the EMA-RSI variant some references
 *     describe. Wilder's is the original 1978 definition and what every
 *     major charting tool uses.
 *
 *  2. **SMA seeding for the first `period` price changes** (NOT Wilder's
 *     from the start). The first avgGain and avgLoss are simple averages
 *     over the first `period` changes; only AFTER that does Wilder's
 *     smoothing kick in. TA-Lib does this; some textbook implementations
 *     skip the seed and start Wilder's immediately, which produces values
 *     that drift from TradingView for ~2× the period before converging.
 *
 *  3. **Divide-by-zero rule**: when `avgLoss === 0`, RSI = 100. This covers
 *     both the all-gains case AND the perfectly-flat market case (where
 *     avgGain = avgLoss = 0; the avgLoss === 0 guard fires first and
 *     returns 100 by convention). Some implementations return 50 or
 *     undefined for the flat case; TradingView returns 100.
 *
 * Output length is exactly `candles.length − period` — note this is one
 * less than SMA/EMA/Bollinger because RSI consumes price *changes* (which
 * need `period + 1` price points to produce `period` changes). The first
 * output point is at index `period` of the input, not `period − 1`.
 *
 * Returns `[]` when input is empty, when `period < 1`, or when there
 * aren't enough candles to compute the seed (need `period + 1` candles).
 */
export function relativeStrengthIndex(
  candles: readonly Candle[],
  period: number,
): IndicatorPoint[] {
  if (period < 1 || candles.length < period + 1) return [];
  const result: IndicatorPoint[] = [];

  // Seed: simple average of first `period` price changes
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change > 0) avgGain += change;
    else avgLoss += -change;
  }
  avgGain /= period;
  avgLoss /= period;

  // First RSI value is at input index `period` (after consuming `period` changes)
  result.push({
    time: candles[period].timestamp,
    value: avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss),
  });

  // Subsequent: Wilder's smoothing
  for (let i = period + 1; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result.push({
      time: candles[i].timestamp,
      value: avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss),
    });
  }

  return result;
}
