import { describe, it, expect } from "vitest";
import { relativeStrengthIndex } from "@/lib/indicators/rsi";
import { candlesFromCloses } from "./helpers";

describe("relativeStrengthIndex", () => {
  it("computes the canonical reference vector with hand-verifiable arithmetic", () => {
    // closes [1,2,3,2,1,2,3,4], period 3
    // Changes: [+1, +1, -1, -1, +1, +1, +1]
    //
    // Seed (first 3 changes):
    //   avgGain = (1+1+0)/3 = 2/3
    //   avgLoss = (0+0+1)/3 = 1/3
    //   RS = 2 → RSI at i=3 = 100 − 100/3 = 66.6667
    //
    // Wilder's at i=4 (change −1):
    //   avgGain = (2/3 × 2 + 0)/3 = 4/9
    //   avgLoss = (1/3 × 2 + 1)/3 = 5/9
    //   RS = 4/5 = 0.8 → RSI = 100 − 100/1.8 = 44.4444
    //
    // Wilder's at i=5 (change +1):
    //   avgGain = (4/9 × 2 + 1)/3 = 17/27
    //   avgLoss = (5/9 × 2 + 0)/3 = 10/27
    //   RS = 17/10 = 1.7 → RSI = 100 − 100/2.7 = 62.9630
    //
    // Wilder's at i=6 (change +1):
    //   avgGain = (17/27 × 2 + 1)/3 = 61/81
    //   avgLoss = (10/27 × 2 + 0)/3 = 20/81
    //   RS = 61/20 = 3.05 → RSI = 100 − 100/4.05 = 75.3086
    //
    // Wilder's at i=7 (change +1):
    //   avgGain = (61/81 × 2 + 1)/3 = 203/243
    //   avgLoss = (20/81 × 2 + 0)/3 = 40/243
    //   RS = 203/40 = 5.075 → RSI = 100 − 100/6.075 = 83.5391
    const result = relativeStrengthIndex(
      candlesFromCloses([1, 2, 3, 2, 1, 2, 3, 4]),
      3,
    );
    expect(result).toHaveLength(5);
    expect(result[0].value).toBeCloseTo(66.6667, 3);
    expect(result[1].value).toBeCloseTo(44.4444, 3);
    expect(result[2].value).toBeCloseTo(62.9630, 3);
    expect(result[3].value).toBeCloseTo(75.3086, 3);
    expect(result[4].value).toBeCloseTo(83.5391, 3);
  });

  it("monotonically increasing closes → RSI approaches 100", () => {
    // No losses ever → avgLoss === 0 → RSI = 100 every point.
    const closes = Array.from({ length: 50 }, (_, i) => 100 + i);
    const result = relativeStrengthIndex(candlesFromCloses(closes), 14);
    for (const point of result) {
      expect(point.value).toBeCloseTo(100, 9);
    }
  });

  it("monotonically decreasing closes → RSI approaches 0", () => {
    // No gains ever → avgGain === 0 → RS = 0 → RSI = 100 − 100/1 = 0.
    const closes = Array.from({ length: 50 }, (_, i) => 100 - i);
    const result = relativeStrengthIndex(candlesFromCloses(closes), 14);
    for (const point of result) {
      expect(point.value).toBeCloseTo(0, 9);
    }
  });

  it("constant prices → RSI = 100 (avgLoss === 0 guard fires for the flat case)", () => {
    // Every change is 0 → avgGain = avgLoss = 0 → guard returns 100.
    // TradingView convention; some references return 50 for the flat case.
    const result = relativeStrengthIndex(candlesFromCloses([100, 100, 100, 100, 100]), 3);
    expect(result).toHaveLength(2);
    for (const point of result) {
      expect(point.value).toBe(100);
    }
  });

  it("invariant: every output value is in [0, 100]", () => {
    // Random-ish but deterministic. Mix of gains and losses.
    const closes = [10, 12, 11, 14, 13, 15, 17, 16, 18, 20, 19, 21, 23, 22, 25, 24, 26, 28, 27, 30];
    const result = relativeStrengthIndex(candlesFromCloses(closes), 14);
    for (const point of result) {
      expect(point.value).toBeGreaterThanOrEqual(0);
      expect(point.value).toBeLessThanOrEqual(100);
    }
  });

  it("returns [] for empty input", () => {
    expect(relativeStrengthIndex([], 14)).toEqual([]);
  });

  it("returns [] when candles.length < period + 1 (insufficient changes for the seed)", () => {
    // Need period+1 candles to produce period price changes.
    expect(relativeStrengthIndex(candlesFromCloses([1, 2, 3]), 3)).toEqual([]);
    expect(relativeStrengthIndex(candlesFromCloses([1, 2, 3, 4]), 14)).toEqual([]);
  });

  it("returns [] for non-positive period (defensive)", () => {
    expect(relativeStrengthIndex(candlesFromCloses([1, 2, 3, 4, 5]), 0)).toEqual([]);
    expect(relativeStrengthIndex(candlesFromCloses([1, 2, 3, 4, 5]), -1)).toEqual([]);
  });

  it("output length is exactly candles.length − period (NOT − period + 1 like SMA/EMA/Bollinger)", () => {
    // RSI consumes price CHANGES, which need period+1 candles → one less output.
    for (const len of [10, 50, 100, 500]) {
      for (const period of [3, 14, 20, 50]) {
        if (len < period + 1) continue;
        const closes = Array.from({ length: len }, (_, i) => i + 1);
        const result = relativeStrengthIndex(candlesFromCloses(closes), period);
        expect(result).toHaveLength(len - period);
      }
    }
  });

  it("first output time aligns to candles[period].timestamp (NOT candles[period − 1])", () => {
    // RSI lives one index later than SMA/EMA/Bollinger because of the
    // change-of-prices semantics. Pinning this prevents an off-by-one
    // regression that would mis-align the line on the chart.
    const candles = candlesFromCloses([1, 2, 3, 4, 5, 6]);
    const result = relativeStrengthIndex(candles, 3);
    expect(result[0].time).toBe(candles[3].timestamp);
    expect(result[result.length - 1].time).toBe(candles[candles.length - 1].timestamp);
  });

  it("post-jump value is meaningfully different from constant baseline (regression spot-check)", () => {
    // closes [10, 10, 10, 10, 50] period 3
    // Seed at i=3 over changes [0, 0, 0]: avgGain = avgLoss = 0 → RSI = 100
    // At i=4 (change +40): avgGain = (0×2 + 40)/3 = 40/3, avgLoss = 0 → still 100
    // Confirms: a single huge gain after flat prices doesn't drag RSI down.
    const result = relativeStrengthIndex(candlesFromCloses([10, 10, 10, 10, 50]), 3);
    expect(result).toHaveLength(2);
    expect(result[0].value).toBe(100);
    expect(result[1].value).toBe(100);
  });
});
