import { describe, it, expect } from "vitest";
import { exponentialMovingAverage } from "@/lib/indicators/ema";
import { candlesFromCloses } from "./helpers";

describe("exponentialMovingAverage", () => {
  it("seeds with SMA of first `period` closes (TradingView convention)", () => {
    // For closes [1, 2, 3, 4, 5] with period 3:
    // Seed = SMA([1,2,3]) = 2 → first output point is { value: 2 } at index 2
    const result = exponentialMovingAverage(candlesFromCloses([1, 2, 3, 4, 5]), 3);
    expect(result).toHaveLength(3);
    expect(result[0].value).toBeCloseTo(2, 9);
  });

  it("applies the standard k = 2/(period+1) recurrence after seeding", () => {
    // closes [1, 2, 3, 4, 5], period 3, k = 2/4 = 0.5
    // Seed (i=2) = (1+2+3)/3 = 2
    // i=3: 4*0.5 + 2*0.5 = 3
    // i=4: 5*0.5 + 3*0.5 = 4
    const result = exponentialMovingAverage(candlesFromCloses([1, 2, 3, 4, 5]), 3);
    expect(result[0].value).toBeCloseTo(2, 9);
    expect(result[1].value).toBeCloseTo(3, 9);
    expect(result[2].value).toBeCloseTo(4, 9);
  });

  it("constant prices → all EMA values equal that constant", () => {
    const result = exponentialMovingAverage(candlesFromCloses([100, 100, 100, 100, 100]), 3);
    expect(result).toHaveLength(3);
    for (const point of result) {
      expect(point.value).toBeCloseTo(100, 9);
    }
  });

  it("returns identity when period === 1 (k = 1, each EMA = its close)", () => {
    // k = 2/(1+1) = 1, so EMA[i] = close[i] * 1 + prev * 0 = close[i]
    // Seed = SMA([10]) = 10, then each subsequent point equals its close.
    const result = exponentialMovingAverage(candlesFromCloses([10, 20, 30]), 1);
    expect(result.map((p) => p.value)).toEqual([10, 20, 30]);
  });

  it("returns [] for empty input", () => {
    expect(exponentialMovingAverage([], 14)).toEqual([]);
  });

  it("returns [] when candles.length < period (can't compute the seed)", () => {
    expect(exponentialMovingAverage(candlesFromCloses([1, 2, 3]), 5)).toEqual([]);
  });

  it("returns [] for non-positive period (defensive)", () => {
    expect(exponentialMovingAverage(candlesFromCloses([1, 2, 3, 4]), 0)).toEqual([]);
    expect(exponentialMovingAverage(candlesFromCloses([1, 2, 3, 4]), -1)).toEqual([]);
  });

  it("output length is exactly candles.length - period + 1 (matches SMA)", () => {
    for (const len of [10, 50, 100, 500]) {
      for (const period of [5, 10, 20, 50]) {
        if (len < period) continue;
        const closes = Array.from({ length: len }, (_, i) => i + 1);
        const result = exponentialMovingAverage(candlesFromCloses(closes), period);
        expect(result).toHaveLength(len - period + 1);
      }
    }
  });

  it("output time aligns with the candle's timestamp at each step", () => {
    const candles = candlesFromCloses([10, 20, 30, 40, 50]);
    const result = exponentialMovingAverage(candles, 3);
    // First EMA at candle index 2; subsequent at indices 3, 4
    expect(result[0].time).toBe(candles[2].timestamp);
    expect(result[1].time).toBe(candles[3].timestamp);
    expect(result[2].time).toBe(candles[4].timestamp);
  });

  it("EMA reacts faster than SMA to the latest close (regression spot-check)", () => {
    // After a sudden jump, EMA should be closer to the new value than SMA.
    // closes [1, 1, 1, 1, 100], period 3
    // SMA(3) at i=4: (1 + 1 + 100) / 3 ≈ 34.0
    // EMA(3) seed at i=2: 1; i=3: 1*0.5 + 1*0.5 = 1; i=4: 100*0.5 + 1*0.5 = 50.5
    // EMA (50.5) > SMA (34.0) — EMA weighs the recent jump more heavily.
    const closes = [1, 1, 1, 1, 100];
    const ema = exponentialMovingAverage(candlesFromCloses(closes), 3);
    const lastEma = ema[ema.length - 1].value;
    const sma = (closes[2] + closes[3] + closes[4]) / 3;
    expect(lastEma).toBeGreaterThan(sma);
    expect(lastEma).toBeCloseTo(50.5, 9);
  });
});
