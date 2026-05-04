import type { Candle, IndicatorPoint } from "./types";
import { exponentialMovingAverage } from "./ema";

/** A single MACD point: the MACD line value, the signal line value (EMA
 *  of the MACD line), and the histogram (macd − signal). */
export interface MacdPoint {
  time: number;
  macd: number;
  signal: number;
  histogram: number;
}

/**
 * Moving Average Convergence Divergence.
 *
 *  - macdLine  = EMA(close, fastPeriod) − EMA(close, slowPeriod)
 *  - signalLine = EMA(macdLine, signalPeriod)
 *  - histogram = macdLine − signalLine
 *
 * TradingView defaults: fast 12, slow 26, signal 9.
 *
 * **The tricky part is alignment.** Each EMA produces an array of a
 * different length:
 *  - fastEma.length = N − fastPeriod + 1
 *  - slowEma.length = N − slowPeriod + 1   (shorter; longer warm-up)
 *
 * To compute the MACD line we need them aligned at the SAME timestamps,
 * so we trim the head of fastEma by `slowPeriod − fastPeriod` points.
 * Then signal is an EMA of the (already-aligned) MACD line, which warms
 * up for another `signalPeriod − 1` points. Final output length is
 * exactly `N − slowPeriod − signalPeriod + 2`.
 *
 * **Sign convention pinned**: histogram = macd − signal, NOT signal − macd.
 * Positive histogram means the MACD line is above the signal line —
 * the bullish-crossover region. TradingView and TA-Lib both use this
 * convention; flipping it would invert every histogram bar's color in
 * the chart.
 *
 * **Synthetic-candle approach for the signal line**: the EMA function
 * takes `Candle[]` (it reads `close` and `timestamp`), so we feed it
 * pseudo-candles where every OHLC field equals the MACD line value.
 * This is mathematically equivalent to running EMA on a single-value
 * series and avoids duplicating the EMA recurrence in this file.
 *
 * Returns `[]` when:
 *  - any period is < 1
 *  - slowPeriod < fastPeriod (misconfigured — slow is supposed to be slower)
 *  - input has fewer than `slowPeriod + signalPeriod − 1` candles
 *    (not enough data to seed both the slow EMA and the signal EMA)
 */
export function macd(
  candles: readonly Candle[],
  fastPeriod: number,
  slowPeriod: number,
  signalPeriod: number,
): MacdPoint[] {
  if (fastPeriod < 1 || slowPeriod < 1 || signalPeriod < 1) return [];
  if (slowPeriod < fastPeriod) return [];

  const fastEma = exponentialMovingAverage(candles, fastPeriod);
  const slowEma = exponentialMovingAverage(candles, slowPeriod);

  if (slowEma.length === 0) return [];

  // Trim fastEma head to align with slowEma. Both functions return values
  // keyed to the right edge of their window; slowEma starts later (longer
  // warm-up), so fastEma has a longer prefix that doesn't have a matching
  // slow value yet.
  const offset = fastEma.length - slowEma.length;
  const macdLine: IndicatorPoint[] = slowEma.map((slowPoint, i) => ({
    time: slowPoint.time,
    value: fastEma[i + offset].value - slowPoint.value,
  }));

  if (macdLine.length < signalPeriod) return [];

  // Signal line is EMA of the MACD line. Feed it as synthetic candles —
  // EMA only reads `close` and `timestamp`, so OHLC fields all equal the
  // MACD value. This avoids duplicating the EMA recurrence here.
  const syntheticCandles: Candle[] = macdLine.map((p) => ({
    timestamp: p.time,
    open: p.value,
    high: p.value,
    low: p.value,
    close: p.value,
  }));
  const signalLine = exponentialMovingAverage(syntheticCandles, signalPeriod);

  // Trim macdLine head to align with signalLine for the final output.
  const signalOffset = macdLine.length - signalLine.length;
  return signalLine.map((sigPoint, i) => {
    const macdValue = macdLine[i + signalOffset].value;
    return {
      time: sigPoint.time,
      macd: macdValue,
      signal: sigPoint.value,
      histogram: macdValue - sigPoint.value,
    };
  });
}
