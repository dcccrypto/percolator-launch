import { describe, it, expect } from "vitest";
import {
  computeRef24h,
  computePriceChange,
  type PricePoint,
  type Timeframe,
} from "../../lib/chart-stats";

const NOW = Date.UTC(2026, 3, 20, 11, 30); // 2026-04-20 11:30 UTC

/** Build bar-spaced price points ending roughly at NOW. */
function bars(count: number, stepMs: number, startPrice = 100, drift = 1): PricePoint[] {
  const endBucket = Math.floor(NOW / stepMs) * stepMs;
  const out: PricePoint[] = [];
  for (let i = count - 1; i >= 0; i--) {
    out.push({ timestamp: endBucket - i * stepMs, price: startPrice + (count - 1 - i) * drift });
  }
  return out;
}

describe("computeRef24h", () => {
  it("returns currentPrice when activeData is empty", () => {
    expect(computeRef24h([], "1h", 84.4, NOW)).toBe(84.4);
  });

  describe("intraday timeframes (find-by-cutoff path)", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    it("picks the first bar whose timestamp is >= (now - 24h) on 5m", () => {
      const data = bars(500, 5 * 60_000, 80); // ~41 hours of 5-min bars
      const ref = computeRef24h(data, "5m", data[data.length - 1].price, NOW);
      // Should not be the very first bar (too old) nor the last one (current).
      expect(ref).toBeGreaterThan(data[0].price);
      expect(ref).toBeLessThan(data[data.length - 1].price);
      // And it should be the price of a bar roughly 24h before NOW.
      const expectedBar = data.find((p) => p.timestamp >= NOW - DAY_MS);
      expect(ref).toBe(expectedBar!.price);
    });

    it("falls back to oldest when all bars are older than 24h", () => {
      const data = bars(10, 60 * 60_000, 80); // 10 hours of 1h bars, oldest is ~10h ago
      // Request on 1h timeframe — 10h window is within the 24h cutoff
      const ref = computeRef24h(data, "1h", data[data.length - 1].price, NOW + 48 * 60 * 60 * 1000);
      // 48h in the future → all 10 bars are > 24h old → find returns undefined → fall back to activeData[0].
      expect(ref).toBe(data[0].price);
    });
  });

  describe("daily+ timeframes (previous-bar path)", () => {
    it("uses the previous bar's close on 1d, not the current one", () => {
      // 180 daily bars ending today
      const data = bars(180, 24 * 60 * 60_000, 80, 0.5);
      const currentPrice = data[data.length - 1].price;
      const expected = data[data.length - 2].price;
      const ref = computeRef24h(data, "1d", currentPrice, NOW);
      expect(ref).toBe(expected);
      expect(ref).not.toBe(currentPrice); // the bug we are fixing
    });

    it("falls back to the first bar when only one bar exists on 1d", () => {
      const data = bars(1, 24 * 60 * 60_000, 80);
      const ref = computeRef24h(data, "1d", data[0].price, NOW);
      expect(ref).toBe(data[0].price);
    });

    it("falls back to currentPrice when activeData is empty on 7d", () => {
      const ref = computeRef24h([], "7d", 120, NOW);
      expect(ref).toBe(120);
    });

    it("uses previous bar on 30d too", () => {
      const data = bars(60, 30 * 24 * 60 * 60_000, 50);
      const ref = computeRef24h(data, "30d", data[data.length - 1].price, NOW);
      expect(ref).toBe(data[data.length - 2].price);
    });
  });
});

describe("computePriceChange", () => {
  it("produces a positive delta + isUp=true when current > ref", () => {
    expect(computePriceChange(110, 100)).toEqual({
      priceChange: 10,
      priceChangePercent: 10,
      isUp: true,
    });
  });

  it("produces a negative delta + isUp=false when current < ref", () => {
    const out = computePriceChange(90, 100);
    expect(out.priceChange).toBe(-10);
    expect(out.priceChangePercent).toBe(-10);
    expect(out.isUp).toBe(false);
  });

  it("guards divide-by-zero when ref24h is 0", () => {
    const out = computePriceChange(50, 0);
    expect(out.priceChangePercent).toBe(0);
    expect(out.priceChange).toBe(50);
  });

  it("treats zero delta as up (neutral)", () => {
    expect(computePriceChange(50, 50).isUp).toBe(true);
  });
});
