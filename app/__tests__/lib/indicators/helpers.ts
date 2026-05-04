import type { Candle } from "@/lib/indicators/types";

/** Build a Candle array from close prices for tests. open=high=low=close
 *  (the indicator math only reads close + timestamp; the OHLC shape stays
 *  realistic so tests look like real market data). Timestamps are 60s apart
 *  starting at epoch 0 for deterministic output. */
export function candlesFromCloses(closes: readonly number[]): Candle[] {
  return closes.map((close, i) => ({
    timestamp: i * 60_000,
    open: close,
    high: close,
    low: close,
    close,
  }));
}
