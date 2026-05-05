import { describe, it, expect } from "vitest";
import { bollingerBands } from "@/lib/indicators/bollinger";
import { candlesFromCloses } from "./helpers";

describe("bollingerBands", () => {
  it("collapses all three bands to the mean when prices are constant (σ = 0)", () => {
    // Constant prices → variance = 0 → σ = 0 → upper = middle = lower.
    const result = bollingerBands(candlesFromCloses([100, 100, 100, 100, 100]), 3, 2);
    expect(result).toHaveLength(3);
    for (const point of result) {
      expect(point.middle).toBeCloseTo(100, 9);
      expect(point.upper).toBeCloseTo(100, 9);
      expect(point.lower).toBeCloseTo(100, 9);
    }
  });

  it("computes population σ (not sample) for the canonical reference vector", () => {
    // closes [2, 4, 4, 4, 5, 5, 7, 9], period 8, stdDev 2
    // mean = (2+4+4+4+5+5+7+9)/8 = 40/8 = 5
    // squared diffs = [9, 1, 1, 1, 0, 0, 4, 16] sum = 32
    // POPULATION σ = sqrt(32/8) = sqrt(4) = 2
    // (Sample σ would be sqrt(32/7) ≈ 2.138 — wrong for TradingView parity)
    // upper = 5 + 2*2 = 9; lower = 5 - 2*2 = 1
    const result = bollingerBands(
      candlesFromCloses([2, 4, 4, 4, 5, 5, 7, 9]),
      8,
      2,
    );
    expect(result).toHaveLength(1);
    expect(result[0].middle).toBeCloseTo(5, 9);
    expect(result[0].upper).toBeCloseTo(9, 9);
    expect(result[0].lower).toBeCloseTo(1, 9);
  });

  it("invariant: lower ≤ middle ≤ upper for every output point", () => {
    // Random-ish but deterministic input
    const closes = [10, 12, 11, 14, 13, 15, 17, 16, 18, 20, 19, 21, 23, 22, 25];
    const result = bollingerBands(candlesFromCloses(closes), 5, 2);
    for (const point of result) {
      expect(point.lower).toBeLessThanOrEqual(point.middle);
      expect(point.middle).toBeLessThanOrEqual(point.upper);
    }
  });

  it("invariant: bands are symmetric around the middle (upper - middle === middle - lower)", () => {
    const closes = [10, 12, 11, 14, 13, 15, 17, 16, 18, 20];
    const result = bollingerBands(candlesFromCloses(closes), 5, 2);
    for (const point of result) {
      expect(point.upper - point.middle).toBeCloseTo(point.middle - point.lower, 9);
    }
  });

  it("stdDev = 0 collapses both bands to the middle line", () => {
    // Even with varying prices, stdDev=0 means upper = middle = lower.
    const result = bollingerBands(candlesFromCloses([10, 20, 30, 40, 50]), 3, 0);
    expect(result).toHaveLength(3);
    for (const point of result) {
      expect(point.upper).toBeCloseTo(point.middle, 9);
      expect(point.lower).toBeCloseTo(point.middle, 9);
    }
  });

  it("returns [] for empty input", () => {
    expect(bollingerBands([], 20, 2)).toEqual([]);
  });

  it("returns [] when candles.length < period (window can't fill)", () => {
    expect(bollingerBands(candlesFromCloses([1, 2, 3]), 5, 2)).toEqual([]);
  });

  it("returns [] for non-positive period (defensive)", () => {
    expect(bollingerBands(candlesFromCloses([1, 2, 3, 4]), 0, 2)).toEqual([]);
    expect(bollingerBands(candlesFromCloses([1, 2, 3, 4]), -1, 2)).toEqual([]);
  });

  it("output length is exactly candles.length - period + 1 (matches SMA)", () => {
    for (const len of [10, 50, 100, 500]) {
      for (const period of [5, 10, 20, 50]) {
        if (len < period) continue;
        const closes = Array.from({ length: len }, (_, i) => i + 1);
        const result = bollingerBands(candlesFromCloses(closes), period, 2);
        expect(result).toHaveLength(len - period + 1);
      }
    }
  });

  it("output time aligns with the candle's timestamp at the window's right edge", () => {
    const candles = candlesFromCloses([10, 20, 30, 40, 50]);
    const result = bollingerBands(candles, 3, 2);
    expect(result[0].time).toBe(candles[2].timestamp);
    expect(result[result.length - 1].time).toBe(candles[candles.length - 1].timestamp);
  });

  it("widening stdDev pushes upper higher and lower lower (linear in stdDev)", () => {
    // For the same data + period, doubling stdDev should double the band gap.
    const closes = [10, 12, 11, 14, 13, 15, 17, 16, 18, 20];
    const r1 = bollingerBands(candlesFromCloses(closes), 5, 1);
    const r2 = bollingerBands(candlesFromCloses(closes), 5, 2);
    // Same middle; bands at exactly 2x the distance.
    for (let i = 0; i < r1.length; i++) {
      expect(r2[i].middle).toBeCloseTo(r1[i].middle, 9);
      expect(r2[i].upper - r2[i].middle).toBeCloseTo(2 * (r1[i].upper - r1[i].middle), 9);
      expect(r1[i].middle - r2[i].lower).toBeCloseTo(2 * (r1[i].middle - r1[i].lower), 9);
    }
  });
});
