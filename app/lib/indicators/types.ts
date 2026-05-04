/**
 * Shared types for the indicator math layer.
 *
 * All indicator functions are pure: they take `Candle[]` + parameters and
 * return arrays of points keyed by timestamp. Rendering happens elsewhere
 * (the renderer hooks in app/components/trade/) — this layer has no React
 * or lightweight-charts dependency.
 *
 * `Candle` mirrors the inline shape used throughout TradingChart.tsx and
 * the data-source hooks (usePythChart, useTokenChart, usePercolatorCandles).
 * Defined here so a future contributor can grep `Candle` and find a single
 * authoritative declaration. The math functions only read `close` and
 * `timestamp` — the other OHLC fields are unused by these indicators but
 * kept so the type is reusable across callers.
 */

export interface Candle {
  timestamp: number; // milliseconds since epoch (matches Date.now() and existing chart code)
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** A single-value indicator point (SMA, EMA, RSI). */
export interface IndicatorPoint {
  time: number; // milliseconds, matches Candle.timestamp
  value: number;
}
