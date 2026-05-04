import { describe, it, expect } from "vitest";
import { simpleMovingAverage } from "@/lib/indicators/sma";
import { candlesFromCloses } from "./helpers";

describe("simpleMovingAverage", () => {
  it("computes the canonical reference vector: [1,2,3,4,5] period 3 → [2,3,4]", () => {
    // SMA(3) at index 2: (1+2+3)/3 = 2
    // SMA(3) at index 3: (2+3+4)/3 = 3
    // SMA(3) at index 4: (3+4+5)/3 = 4
    const result = simpleMovingAverage(candlesFromCloses([1, 2, 3, 4, 5]), 3);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ time: 2 * 60_000, value: 2 });
    expect(result[1]).toEqual({ time: 3 * 60_000, value: 3 });
    expect(result[2]).toEqual({ time: 4 * 60_000, value: 4 });
  });

  it("returns identity when period === 1 (each output equals its close)", () => {
    const result = simpleMovingAverage(candlesFromCloses([10, 20, 30]), 1);
    expect(result).toHaveLength(3);
    expect(result.map((p) => p.value)).toEqual([10, 20, 30]);
  });

  it("returns a single point when period === candles.length", () => {
    const result = simpleMovingAverage(candlesFromCloses([100, 200, 300]), 3);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBeCloseTo(200, 9); // mean of [100,200,300]
  });

  it("returns [] for empty input", () => {
    expect(simpleMovingAverage([], 14)).toEqual([]);
  });

  it("returns [] when candles.length < period (window can't fill)", () => {
    expect(simpleMovingAverage(candlesFromCloses([1, 2, 3]), 5)).toEqual([]);
  });

  it("returns [] for non-positive period (defensive)", () => {
    expect(simpleMovingAverage(candlesFromCloses([1, 2, 3, 4]), 0)).toEqual([]);
    expect(simpleMovingAverage(candlesFromCloses([1, 2, 3, 4]), -1)).toEqual([]);
  });

  it("output length is exactly candles.length - period + 1 (invariant)", () => {
    for (const len of [10, 50, 100, 500]) {
      for (const period of [5, 10, 20, 50]) {
        if (len < period) continue;
        const closes = Array.from({ length: len }, (_, i) => i + 1);
        const result = simpleMovingAverage(candlesFromCloses(closes), period);
        expect(result).toHaveLength(len - period + 1);
      }
    }
  });

  it("output time aligns with the candle's timestamp at each window's right edge", () => {
    const candles = candlesFromCloses([10, 20, 30, 40, 50]);
    const result = simpleMovingAverage(candles, 3);
    // First SMA point is at candle index 2 (the third candle), so its time
    // must equal candles[2].timestamp, not candles[0].timestamp.
    expect(result[0].time).toBe(candles[2].timestamp);
    expect(result[result.length - 1].time).toBe(candles[candles.length - 1].timestamp);
  });
});
