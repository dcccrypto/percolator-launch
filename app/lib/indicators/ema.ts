import type { Candle, IndicatorPoint } from "./types";

/**
 * Exponential Moving Average over a candle's close prices.
 *
 * Uses the standard multiplier `k = 2 / (period + 1)` and seeds the EMA
 * with the SMA of the first `period` closes (TradingView convention,
 * matches TA-Lib's `EMA` when called with a period >= 1). After the seed,
 * each subsequent EMA value is `close * k + prevEma * (1 - k)`.
 *
 * The first output point is at index `period - 1` (the seed). Output
 * length is `candles.length - period + 1`.
 *
 * Conventions worth pinning down because future contributors may "fix"
 * one of them and silently break TradingView parity:
 *  - Multiplier is `2 / (period + 1)` (not `1 / period` and not Wilder's).
 *  - Seed is the SMA of the first `period` closes, NOT just the first close.
 *  - Output `time` matches the candle's `timestamp` exactly so the line
 *    aligns with the price axis on every renderer.
 *
 * Returns `[]` when the input is empty, when `period < 1`, or when there
 * aren't enough candles to compute the seed.
 */
export function exponentialMovingAverage(
  candles: readonly Candle[],
  period: number,
): IndicatorPoint[] {
  if (period < 1 || candles.length < period) return [];
  const result: IndicatorPoint[] = [];
  const k = 2 / (period + 1);
  // Seed with SMA of first `period` closes
  let ema = 0;
  for (let i = 0; i < period; i++) ema += candles[i].close;
  ema /= period;
  result.push({ time: candles[period - 1].timestamp, value: ema });
  for (let i = period; i < candles.length; i++) {
    ema = candles[i].close * k + ema * (1 - k);
    result.push({ time: candles[i].timestamp, value: ema });
  }
  return result;
}
