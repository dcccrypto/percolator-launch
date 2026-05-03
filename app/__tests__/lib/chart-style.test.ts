import { describe, it, expect } from "vitest";
import {
  isChartStyle,
  isCandleStyle,
  candleStyleOptions,
  DEFAULT_CHART_STYLE,
  type ChartStyle,
} from "../../lib/chart-style";

const UP = "#22c55e";
const DOWN = "#ef4444";
const TRANSPARENT = "rgba(0,0,0,0)";

describe("isChartStyle", () => {
  it("accepts every member of the ChartStyle union", () => {
    const all: ChartStyle[] = [
      "line",
      "candle-solid",
      "candle-hollow",
      "candle-hollow-up",
      "candle-hollow-down",
    ];
    for (const s of all) expect(isChartStyle(s)).toBe(true);
  });

  it("rejects unknown strings, including case-mismatches and dropped variants", () => {
    for (const v of ["", "candle", "Line", "candle-Solid", "bar", "area", "ohlc"]) {
      expect(isChartStyle(v)).toBe(false);
    }
  });

  it("rejects non-string inputs", () => {
    for (const v of [null, undefined, 0, 1, {}, [], true, false]) {
      expect(isChartStyle(v)).toBe(false);
    }
  });
});

describe("isCandleStyle", () => {
  it("returns true for every candle-* variant", () => {
    expect(isCandleStyle("candle-solid")).toBe(true);
    expect(isCandleStyle("candle-hollow")).toBe(true);
    expect(isCandleStyle("candle-hollow-up")).toBe(true);
    expect(isCandleStyle("candle-hollow-down")).toBe(true);
  });

  it("returns false for the line style", () => {
    expect(isCandleStyle("line")).toBe(false);
  });
});

describe("DEFAULT_CHART_STYLE", () => {
  it("is itself a valid ChartStyle", () => {
    expect(isChartStyle(DEFAULT_CHART_STYLE)).toBe(true);
  });

  it("is a candle variant (matches first-paint expectation)", () => {
    expect(isCandleStyle(DEFAULT_CHART_STYLE)).toBe(true);
  });
});

describe("candleStyleOptions", () => {
  it("solid: filled bodies in trend colour, no border", () => {
    const opts = candleStyleOptions("candle-solid", UP, DOWN);
    expect(opts.upColor).toBe(UP);
    expect(opts.downColor).toBe(DOWN);
    expect(opts.borderUpColor).toBe(UP);
    expect(opts.borderDownColor).toBe(DOWN);
    expect(opts.borderVisible).toBe(false);
  });

  it("hollow: transparent bodies for both directions, borders on", () => {
    const opts = candleStyleOptions("candle-hollow", UP, DOWN);
    expect(opts.upColor).toBe(TRANSPARENT);
    expect(opts.downColor).toBe(TRANSPARENT);
    expect(opts.borderUpColor).toBe(UP);
    expect(opts.borderDownColor).toBe(DOWN);
    expect(opts.borderVisible).toBe(true);
  });

  it("hollow-up: hollow bullish bars, solid bearish bars", () => {
    const opts = candleStyleOptions("candle-hollow-up", UP, DOWN);
    expect(opts.upColor).toBe(TRANSPARENT);
    expect(opts.downColor).toBe(DOWN);
    expect(opts.borderUpColor).toBe(UP);
    expect(opts.borderDownColor).toBe(DOWN);
    expect(opts.borderVisible).toBe(true);
  });

  it("hollow-down: solid bullish bars, hollow bearish bars", () => {
    const opts = candleStyleOptions("candle-hollow-down", UP, DOWN);
    expect(opts.upColor).toBe(UP);
    expect(opts.downColor).toBe(TRANSPARENT);
    expect(opts.borderUpColor).toBe(UP);
    expect(opts.borderDownColor).toBe(DOWN);
    expect(opts.borderVisible).toBe(true);
  });

  it("wick colours always follow the trend colour so direction stays visible", () => {
    for (const style of ["candle-solid", "candle-hollow", "candle-hollow-up", "candle-hollow-down"] as const) {
      const opts = candleStyleOptions(style, UP, DOWN);
      expect(opts.wickUpColor).toBe(UP);
      expect(opts.wickDownColor).toBe(DOWN);
    }
  });

  it("throws via assertNever when a value bypasses the type system", () => {
    // Simulates a future variant that slipped past the union via an `as` cast
    // or stale persisted enum. The assertNever sentinel must throw, NOT
    // silently return base — that would render the unknown variant as solid
    // and mask the bug.
    expect(() =>
      candleStyleOptions("candle-bogus" as unknown as Parameters<typeof candleStyleOptions>[0], UP, DOWN),
    ).toThrow(/Unexpected value/);
  });
});
