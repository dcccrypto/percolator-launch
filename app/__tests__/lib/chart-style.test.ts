import { describe, it, expect } from "vitest";
import {
  isChartStyle,
  isCandleStyle,
  candleStyleOptions,
  chartDataKind,
  hasRenderableData,
  finiteCandles,
  finitePricePoints,
  DEFAULT_CHART_STYLE,
  CHART_STYLE_LABELS,
  CHART_STYLE_DISPLAY_ORDER,
  type ChartStyle,
  type ChartSeriesKind,
} from "../../lib/chart-style";

const UP = "#22c55e";
const DOWN = "#ef4444";
const TRANSPARENT = "rgba(0,0,0,0)";

describe("isChartStyle", () => {
  it("accepts every member of the ChartStyle union", () => {
    const all: ChartStyle[] = [
      "line",
      "area",
      "candle-solid",
      "candle-hollow",
      "candle-hollow-up",
      "candle-hollow-down",
      "bar",
    ];
    for (const s of all) expect(isChartStyle(s)).toBe(true);
  });

  it("rejects unknown strings, including case-mismatches", () => {
    for (const v of ["", "candle", "Line", "candle-Solid", "ohlc", "heikin-ashi"]) {
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

  it("returns false for area and bar — they are series types but not candle variants", () => {
    expect(isCandleStyle("area")).toBe(false);
    expect(isCandleStyle("bar")).toBe(false);
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

describe("chartDataKind", () => {
  it("returns 'ohlc' for every candle variant", () => {
    expect(chartDataKind("candle-solid")).toBe("ohlc");
    expect(chartDataKind("candle-hollow")).toBe("ohlc");
    expect(chartDataKind("candle-hollow-up")).toBe("ohlc");
    expect(chartDataKind("candle-hollow-down")).toBe("ohlc");
  });

  it("returns 'ohlc' for bar — bar series consume OHLC, not single-value", () => {
    expect(chartDataKind("bar")).toBe("ohlc");
  });

  it("returns 'single' for line and area — both read the closes-only stream", () => {
    expect(chartDataKind("line")).toBe("single");
    expect(chartDataKind("area")).toBe("single");
  });

  it("throws via assertNever when a value bypasses the type system", () => {
    expect(() =>
      chartDataKind("heikin-ashi" as unknown as Parameters<typeof chartDataKind>[0]),
    ).toThrow(/Unexpected value/);
  });
});

describe("hasRenderableData", () => {
  const bar = (t: number) => ({ timestamp: t });
  const point = (t: number) => ({ timestamp: t });

  it("inspects candleData for ohlc styles, ignores lineData length", () => {
    // 5 line points must NOT make a candle style 'ready' — that was the
    // ad-hoc pre-helper bug shape (cross-source inspection).
    const r = hasRenderableData("candle-solid", [], [point(1), point(2), point(3), point(4), point(5)]);
    expect(r.ready).toBe(false);
    expect(r.sparse).toBe(true);
  });

  it("inspects lineData for single styles, ignores candleData length", () => {
    const r = hasRenderableData("line", [bar(1), bar(2), bar(3)], []);
    expect(r.ready).toBe(false);
    expect(r.sparse).toBe(true);
  });

  it("treats area as single-value (regression: area used to fall through the sparse predicate)", () => {
    expect(hasRenderableData("area", [bar(1), bar(2)], []).sparse).toBe(true);
    expect(hasRenderableData("area", [], [point(1), point(2)]).sparse).toBe(false);
  });

  it("treats bar as ohlc (regression: bar used to fall through the sparse predicate)", () => {
    expect(hasRenderableData("bar", [], [point(1), point(2)]).sparse).toBe(true);
    expect(hasRenderableData("bar", [bar(1), bar(2)], []).sparse).toBe(false);
  });

  it("ready threshold is >= 1 (so the switch can create the series for a single point)", () => {
    expect(hasRenderableData("line", [], [point(1)]).ready).toBe(true);
    expect(hasRenderableData("candle-solid", [bar(1)], []).ready).toBe(true);
  });

  it("sparse threshold is < 2 (single point still shows 'building…' overlay)", () => {
    expect(hasRenderableData("line", [], [point(1)]).sparse).toBe(true);
    expect(hasRenderableData("line", [], [point(1), point(2)]).sparse).toBe(false);
    expect(hasRenderableData("candle-solid", [bar(1)], []).sparse).toBe(true);
    expect(hasRenderableData("candle-solid", [bar(1), bar(2)], []).sparse).toBe(false);
  });

  it("empty arrays yield ready=false, sparse=true for any style", () => {
    for (const style of ["line", "area", "candle-solid", "candle-hollow", "candle-hollow-up", "candle-hollow-down", "bar"] as const) {
      const r = hasRenderableData(style, [], []);
      expect(r.ready).toBe(false);
      expect(r.sparse).toBe(true);
    }
  });
});

describe("finiteCandles", () => {
  const c = (o: number, h: number, l: number, cl: number, t = 1_000, v = 5) => ({
    timestamp: t,
    open: o,
    high: h,
    low: l,
    close: cl,
    volume: v,
  });

  it("keeps candles whose OHLC are all finite (incl. sub-cent values)", () => {
    const good = [c(0.000613, 0.000614, 0.000612, 0.000613), c(1, 2, 0.5, 1.5)];
    expect(finiteCandles(good)).toEqual(good);
  });

  it("drops any candle with a NaN in open/high/low/close", () => {
    expect(finiteCandles([c(NaN, 1, 1, 1)])).toHaveLength(0);
    expect(finiteCandles([c(1, NaN, 1, 1)])).toHaveLength(0);
    expect(finiteCandles([c(1, 1, NaN, 1)])).toHaveLength(0);
    expect(finiteCandles([c(1, 1, 1, NaN)])).toHaveLength(0);
  });

  it("drops candles with ±Infinity or a non-finite timestamp", () => {
    expect(finiteCandles([c(Infinity, 1, 1, 1)])).toHaveLength(0);
    expect(finiteCandles([c(1, 1, 1, -Infinity)])).toHaveLength(0);
    expect(finiteCandles([c(1, 1, 1, 1, NaN)])).toHaveLength(0);
  });

  it("does NOT require volume to be finite — the volume series coerces that itself", () => {
    const bar = c(1, 1, 1, 1, 1_000, NaN);
    expect(finiteCandles([bar])).toEqual([bar]);
  });

  it("an all-NaN batch collapses to empty, so hasRenderableData reports not-ready (no crash path)", () => {
    // This is the exact regression: a length>=1 batch of whitespace candles
    // used to pass `ready` and then throw "Value is null" once a price line
    // was drawn. After filtering, `ready` is false and the empty overlay shows.
    const allNaN = [c(NaN, NaN, NaN, NaN), c(NaN, NaN, NaN, NaN)];
    const filtered = finiteCandles(allNaN);
    expect(filtered).toHaveLength(0);
    expect(hasRenderableData("candle-solid", filtered, []).ready).toBe(false);
  });

  it("a mixed batch keeps only the finite candles", () => {
    const mixed = [c(1, 1, 1, 1), c(NaN, 1, 1, 1), c(2, 2, 2, 2)];
    expect(finiteCandles(mixed)).toHaveLength(2);
  });

  it("preserves input order and does not mutate the source array", () => {
    const src = [c(1, 1, 1, 1, 1), c(NaN, 1, 1, 1, 2), c(3, 3, 3, 3, 3)];
    const out = finiteCandles(src);
    expect(out.map((x) => x.timestamp)).toEqual([1, 3]);
    expect(src).toHaveLength(3); // source untouched
  });
});

describe("finitePricePoints", () => {
  const p = (price: number, timestamp = 1_000) => ({ timestamp, price });

  it("keeps points with a finite price", () => {
    const good = [p(0.000613), p(1.5)];
    expect(finitePricePoints(good)).toEqual(good);
  });

  it("drops NaN / ±Infinity prices and non-finite timestamps", () => {
    expect(finitePricePoints([p(NaN)])).toHaveLength(0);
    expect(finitePricePoints([p(Infinity)])).toHaveLength(0);
    expect(finitePricePoints([p(1, NaN)])).toHaveLength(0);
  });

  it("an all-NaN batch collapses to empty → line style reports not-ready", () => {
    const filtered = finitePricePoints([p(NaN), p(NaN)]);
    expect(filtered).toHaveLength(0);
    expect(hasRenderableData("line", [], filtered).ready).toBe(false);
  });

  it("keeps only the finite points in a mixed batch, order preserved", () => {
    const src = [p(1, 1), p(NaN, 2), p(3, 3)];
    const out = finitePricePoints(src);
    expect(out.map((x) => x.timestamp)).toEqual([1, 3]);
    expect(src).toHaveLength(3);
  });
});

describe("ChartSeriesKind", () => {
  it("admits exactly the four lightweight-charts series-API discriminator strings", () => {
    // Compile-time check: every member must be assignable. Runtime expect
    // is just to keep vitest happy — the test is the type annotation.
    const kinds: ChartSeriesKind[] = ["Candlestick", "Line", "Area", "Bar"];
    expect(kinds).toHaveLength(4);
  });
});

describe("CHART_STYLE_LABELS", () => {
  it("provides a non-empty label for every ChartStyle", () => {
    // The Record<ChartStyle, string> type already enforces this at compile
    // time, but a runtime check guards against an empty-string slipping in
    // (which would render a blank dropdown trigger and make the menu unusable).
    for (const style of CHART_STYLE_DISPLAY_ORDER) {
      expect(CHART_STYLE_LABELS[style]).toBeTruthy();
      expect(CHART_STYLE_LABELS[style].length).toBeGreaterThan(0);
    }
  });

  it("labels are unique — no two styles collide", () => {
    const seen = new Set<string>();
    for (const style of CHART_STYLE_DISPLAY_ORDER) {
      const label = CHART_STYLE_LABELS[style];
      expect(seen.has(label)).toBe(false);
      seen.add(label);
    }
  });
});

describe("CHART_STYLE_DISPLAY_ORDER", () => {
  it("includes every ChartStyle exactly once", () => {
    const all: ChartStyle[] = [
      "line",
      "area",
      "candle-solid",
      "candle-hollow",
      "candle-hollow-up",
      "candle-hollow-down",
      "bar",
    ];
    expect(CHART_STYLE_DISPLAY_ORDER.length).toBe(all.length);
    for (const style of all) {
      expect(CHART_STYLE_DISPLAY_ORDER).toContain(style);
    }
  });

  it("orders simplest series first (line/area) then candles then bar", () => {
    // Validates the intent of the manual ordering — if someone reshuffles
    // ALL_STYLES they should also rethink whether the menu reads naturally.
    expect(CHART_STYLE_DISPLAY_ORDER[0]).toBe("line");
    expect(CHART_STYLE_DISPLAY_ORDER[1]).toBe("area");
    expect(CHART_STYLE_DISPLAY_ORDER[CHART_STYLE_DISPLAY_ORDER.length - 1]).toBe("bar");
  });
});
