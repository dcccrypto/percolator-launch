import { describe, it, expect } from "vitest";
import { macd } from "@/lib/indicators/macd";
import { candlesFromCloses } from "./helpers";

describe("macd", () => {
  it("computes the canonical reference vector with hand-verifiable arithmetic", () => {
    // closes [10,12,14,13,15,17,16], fast=2, slow=4, signal=2
    //
    // Fast EMA(2), k = 2/3:
    //   seed at i=1: SMA([10,12]) = 11
    //   i=2: 14*(2/3) + 11*(1/3) = 13
    //   i=3: 13*(2/3) + 13*(1/3) = 13
    //   i=4: 15*(2/3) + 13*(1/3) = 43/3 ≈ 14.3333
    //   i=5: 17*(2/3) + (43/3)*(1/3) = 145/9 ≈ 16.1111
    //   i=6: 16*(2/3) + (145/9)*(1/3) = 433/27 ≈ 16.0370
    //
    // Slow EMA(4), k = 2/5:
    //   seed at i=3: SMA([10,12,14,13]) = 12.25
    //   i=4: 15*(0.4) + 12.25*(0.6) = 13.35
    //   i=5: 17*(0.4) + 13.35*(0.6) = 14.81
    //   i=6: 16*(0.4) + 14.81*(0.6) = 15.286
    //
    // MACD line (offset = fastEma.length - slowEma.length = 6 - 4 = 2):
    //   at i=3: fastEma[2] - slowEma[0] = 13 - 12.25 = 0.75
    //   at i=4: fastEma[3] - slowEma[1] = 14.3333 - 13.35 = 0.9833
    //   at i=5: fastEma[4] - slowEma[2] = 16.1111 - 14.81 = 1.3011
    //   at i=6: fastEma[5] - slowEma[3] = 16.0370 - 15.286 = 0.7510
    //
    // Signal EMA(macdLine, 2), k = 2/3:
    //   seed at macdIndex=1 (candle i=4): SMA([0.75, 0.9833]) = 0.8667
    //   macdIndex=2 (i=5): 1.3011*(2/3) + 0.8667*(1/3) = 1.1563
    //   macdIndex=3 (i=6): 0.7510*(2/3) + 1.1563*(1/3) = 0.8861
    //
    // Final output (signalOffset = macdLine.length − signalLine.length = 4 − 3 = 1):
    //   at i=4: macd = macdLine[1] = 0.9833, signal = 0.8667, histogram = +0.1166
    //   at i=5: macd = macdLine[2] = 1.3011, signal = 1.1563, histogram = +0.1448
    //   at i=6: macd = macdLine[3] = 0.7510, signal = 0.8861, histogram = −0.1351
    const result = macd(
      candlesFromCloses([10, 12, 14, 13, 15, 17, 16]),
      2, // fast
      4, // slow
      2, // signal
    );
    expect(result).toHaveLength(3);
    expect(result[0].macd).toBeCloseTo(0.9833, 3);
    expect(result[0].signal).toBeCloseTo(0.8667, 3);
    expect(result[0].histogram).toBeCloseTo(0.1166, 3);
    expect(result[1].macd).toBeCloseTo(1.3011, 3);
    expect(result[1].signal).toBeCloseTo(1.1563, 3);
    expect(result[1].histogram).toBeCloseTo(0.1448, 3);
    expect(result[2].macd).toBeCloseTo(0.751, 3);
    expect(result[2].signal).toBeCloseTo(0.8861, 3);
    expect(result[2].histogram).toBeCloseTo(-0.1351, 3);
  });

  it("invariant: histogram === macd − signal at every point", () => {
    // The histogram value is purely derived; this invariant must hold by
    // construction, not by chance. If the formula ever flips to
    // (signal − macd), every chart's histogram colors invert.
    const closes = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i / 5) * 10);
    const result = macd(candlesFromCloses(closes), 12, 26, 9);
    for (const point of result) {
      expect(point.histogram).toBeCloseTo(point.macd - point.signal, 9);
    }
  });

  it("constant prices → MACD = 0 and signal = 0 at every point", () => {
    // If price never moves, both EMAs equal the constant. macd = 0, then
    // EMA(zeros) = 0, so signal = 0. histogram = 0.
    const result = macd(candlesFromCloses(Array(40).fill(100)), 12, 26, 9);
    expect(result.length).toBeGreaterThan(0);
    for (const point of result) {
      expect(point.macd).toBeCloseTo(0, 9);
      expect(point.signal).toBeCloseTo(0, 9);
      expect(point.histogram).toBeCloseTo(0, 9);
    }
  });

  it("output length is exactly N − slowPeriod − signalPeriod + 2", () => {
    // For defaults (12, 26, 9) and N = 50: output = 50 − 26 − 9 + 2 = 17.
    // Verify the formula across multiple input sizes.
    for (const N of [40, 50, 100, 500]) {
      const closes = Array.from({ length: N }, (_, i) => i + 1);
      const result = macd(candlesFromCloses(closes), 12, 26, 9);
      expect(result).toHaveLength(N - 26 - 9 + 2);
    }
  });

  it("returns [] when slowPeriod < fastPeriod (misconfigured)", () => {
    // slow is supposed to be the slower-moving line. swapping them is a
    // user error, not a valid input.
    const closes = Array.from({ length: 50 }, (_, i) => i + 1);
    expect(macd(candlesFromCloses(closes), 26, 12, 9)).toEqual([]);
  });

  it("returns [] when any period is non-positive", () => {
    const closes = Array.from({ length: 50 }, (_, i) => i + 1);
    expect(macd(candlesFromCloses(closes), 0, 26, 9)).toEqual([]);
    expect(macd(candlesFromCloses(closes), 12, 0, 9)).toEqual([]);
    expect(macd(candlesFromCloses(closes), 12, 26, 0)).toEqual([]);
    expect(macd(candlesFromCloses(closes), -1, 26, 9)).toEqual([]);
  });

  it("returns [] for empty input", () => {
    expect(macd([], 12, 26, 9)).toEqual([]);
  });

  it("returns [] when input is too short to seed the slow EMA", () => {
    // slowEma needs slowPeriod candles minimum. 25 < 26.
    const closes = Array.from({ length: 25 }, (_, i) => i + 1);
    expect(macd(candlesFromCloses(closes), 12, 26, 9)).toEqual([]);
  });

  it("returns [] when input has slow EMA but not enough for signal seed", () => {
    // slowPeriod + signalPeriod − 1 = 34 minimum. 33 candles → empty.
    const closes = Array.from({ length: 33 }, (_, i) => i + 1);
    expect(macd(candlesFromCloses(closes), 12, 26, 9)).toEqual([]);
  });

  it("output time aligns to the candle's timestamp at the right edge of the window", () => {
    const candles = candlesFromCloses([10, 12, 14, 13, 15, 17, 16]);
    const result = macd(candles, 2, 4, 2);
    // First output is at candle index 4 (the 5th candle) per the alignment math
    // computed in the canonical reference test above.
    expect(result[0].time).toBe(candles[4].timestamp);
    expect(result[result.length - 1].time).toBe(candles[candles.length - 1].timestamp);
  });

  it("MACD line crosses above signal → histogram flips positive (regression spot-check)", () => {
    // After a sustained rise, the fast EMA leads the slow EMA, so MACD > 0.
    // The signal line lags the MACD line, so during the upswing histogram
    // should be positive somewhere.
    const closes = [
      ...Array(30).fill(100),       // flat
      ...Array(30).fill(0).map((_, i) => 100 + i * 2), // rising
    ];
    const result = macd(candlesFromCloses(closes), 12, 26, 9);
    const hasPositiveHist = result.some((p) => p.histogram > 0.5);
    expect(hasPositiveHist).toBe(true);
  });
});
