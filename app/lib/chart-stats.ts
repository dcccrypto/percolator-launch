/**
 * Pure helpers for chart header stats.
 *
 * Extracted from TradingChart.tsx so the 24h-change logic can be unit-tested
 * without a DOM or a lightweight-charts instance.
 */

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d" | "7d" | "30d";

export interface PricePoint {
  timestamp: number; // unix ms
  price: number;
}

/** Timeframes whose candle width is >= 24h. For these, 24h delta is
 *  "previous bar close vs current close" rather than "first bar in 24h window". */
const DAILY_OR_LONGER: ReadonlySet<Timeframe> = new Set(["1d", "7d", "30d"]);

/**
 * Compute the reference price to use for header "24h change" display.
 *
 * On intraday timeframes (bars smaller than 24h) we find the first bar whose
 * timestamp is >= (now - 24h). This gives a true trailing-24h delta.
 *
 * On daily-or-larger timeframes the above fails: the cutoff falls INSIDE the
 * current day's bar, so `find` returns the current bar itself — making the
 * delta always 0. For those timeframes, use the previous bar's close as the
 * reference instead, which is the conventional "yesterday's close vs today"
 * reading any trader will expect on a daily chart.
 */
export function computeRef24h(
  activeData: PricePoint[],
  timeframe: Timeframe,
  currentPrice: number,
  now: number = Date.now(),
): number {
  if (activeData.length === 0) return currentPrice;

  if (DAILY_OR_LONGER.has(timeframe)) {
    // Prefer previous bar; fall back to oldest; fall back to current.
    return (
      activeData[activeData.length - 2]?.price ??
      activeData[0]?.price ??
      currentPrice
    );
  }

  const cutoff = now - 24 * 60 * 60 * 1000;
  return (
    activeData.find((p) => p.timestamp >= cutoff)?.price ??
    activeData[0]?.price ??
    currentPrice
  );
}

export interface PriceChangeStats {
  priceChange: number;
  priceChangePercent: number;
  isUp: boolean;
}

export function computePriceChange(
  currentPrice: number,
  ref24h: number,
): PriceChangeStats {
  const priceChange = currentPrice - ref24h;
  const priceChangePercent = ref24h > 0 ? (priceChange / ref24h) * 100 : 0;
  return { priceChange, priceChangePercent, isUp: priceChange >= 0 };
}
