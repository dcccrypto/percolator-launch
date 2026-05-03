import { describe, it, expect } from "vitest";
import {
  isChartStyle,
  isCandleStyle,
  DEFAULT_CHART_STYLE,
  type ChartStyle,
} from "../../lib/chart-style";

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
