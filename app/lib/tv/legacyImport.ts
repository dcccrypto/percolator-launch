/**
 * One-time import of the old (lightweight-charts) chart's saved preferences
 * into a market's TradingView layout:
 *
 *   perc:chart:drawings:<slab>    trend / horizontal / rectangle  -> TV drawings
 *   perc:chart:indicators:<slab>  SMA / EMA / BB / RSI / MACD     -> TV built-in studies
 *   perc:chart:style              candle/bar/line/area             -> TV chart type
 *
 * Runs only for a market that has no TradingView layout yet, and marks the
 * market done (perc:tv:imported:v1:<slab>) so it never runs twice. The old
 * keys are left untouched: the fallback chart still reads them.
 */
import { mergeDrawings, type Drawing } from "@/lib/chart-drawings";
import { mergeIndicators, type IndicatorConfig } from "@/lib/indicator-registry";
import { isChartStyle, type ChartStyle } from "@/lib/chart-style";
import { assertNever } from "@/lib/exhaustive";
import type { KeyValueStorage } from "./saveLoadAdapter";
import type { TvChartApi, TvShapePoint } from "./types";

export const importedMarker = (slab: string) => `perc:tv:imported:v1:${slab}`;
const LEGACY_DRAWINGS = (slab: string) => `perc:chart:drawings:${slab}`;
const LEGACY_INDICATORS = (slab: string) => `perc:chart:indicators:${slab}`;
const LEGACY_STYLE = "perc:chart:style";

export type PlannedShape =
  | { kind: "single"; shape: "horizontal_line"; point: TvShapePoint }
  | { kind: "multi"; shape: "trend_line" | "rectangle"; points: TvShapePoint[] };

export interface PlannedStudy {
  name: string;
  inputs: Record<string, number>;
  overrides: Record<string, string>;
}

export interface LegacyImportPlan {
  shapes: PlannedShape[];
  studies: PlannedStudy[];
  /** TradingView series type, or null to keep the default (candles). */
  chartType: number | null;
}

/** TradingView series-type ids. */
export const TV_SERIES = { bars: 0, candles: 1, line: 2, area: 3, hollowCandles: 9 } as const;

export function chartTypeFor(style: ChartStyle): number {
  switch (style) {
    case "bar":
      return TV_SERIES.bars;
    case "line":
      return TV_SERIES.line;
    case "area":
      return TV_SERIES.area;
    case "candle-hollow":
      return TV_SERIES.hollowCandles;
    // Hollow-up-only / hollow-down-only have no TradingView type; solid candles are the closest.
    case "candle-solid":
    case "candle-hollow-up":
    case "candle-hollow-down":
      return TV_SERIES.candles;
    default:
      return assertNever(style);
  }
}

const sec = (ms: number) => Math.floor(ms / 1000);

export function shapeFor(d: Drawing, nowSec: number): PlannedShape {
  switch (d.kind) {
    case "trend":
      return {
        kind: "multi",
        shape: "trend_line",
        points: [
          { time: sec(d.p1.time), price: d.p1.price },
          { time: sec(d.p2.time), price: d.p2.price },
        ],
      };
    case "rectangle":
      return {
        kind: "multi",
        shape: "rectangle",
        points: [
          { time: sec(d.p1.time), price: d.p1.price },
          { time: sec(d.p2.time), price: d.p2.price },
        ],
      };
    case "horizontal":
      return { kind: "single", shape: "horizontal_line", point: { time: nowSec, price: d.price } };
    default:
      return assertNever(d);
  }
}

/** Built-in study name + input ids — verified against v32.2.0 in a browser (getInputValues) on 2026-10-03. */
export function studyFor(ind: IndicatorConfig): PlannedStudy {
  const color = { "plot.color": ind.color };
  switch (ind.kind) {
    case "sma":
      return { name: "Moving Average", inputs: { length: ind.period }, overrides: color };
    case "ema":
      return { name: "Moving Average Exponential", inputs: { length: ind.period }, overrides: color };
    case "bollinger":
      // Bollinger Bands' inputs are positional ids in v32 (in_0 length, in_1 mult).
      return { name: "Bollinger Bands", inputs: { in_0: ind.period, in_1: ind.stdDev }, overrides: {} };
    case "rsi":
      return { name: "Relative Strength Index", inputs: { length: ind.period }, overrides: {} };
    case "macd":
      return {
        name: "MACD",
        // MACD's inputs are positional ids in v32 (in_0 fast, in_1 slow, in_2 signal).
        inputs: { in_0: ind.fastPeriod, in_1: ind.slowPeriod, in_2: ind.signalPeriod },
        overrides: {},
      };
    default:
      return assertNever(ind);
  }
}

function parse(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Pure: what to create for this market, from the old keys. */
export function planLegacyImport(storage: KeyValueStorage, slab: string, nowSec: number): LegacyImportPlan {
  const drawings = mergeDrawings(parse(storage.getItem(LEGACY_DRAWINGS(slab))));
  const indicators = mergeIndicators(parse(storage.getItem(LEGACY_INDICATORS(slab))));
  const style = storage.getItem(LEGACY_STYLE);
  return {
    shapes: drawings.map((d) => shapeFor(d, nowSec)),
    studies: indicators.map(studyFor),
    chartType: isChartStyle(style) ? chartTypeFor(style) : null,
  };
}

export function isEmptyPlan(p: LegacyImportPlan): boolean {
  return p.shapes.length === 0 && p.studies.length === 0 && p.chartType == null;
}

/**
 * Apply the plan to a ready chart. Each item is independent: one failure
 * (e.g. a drawing whose time is outside loaded data) does not stop the rest.
 * Returns how many items were applied.
 */
export async function applyLegacyImport(chart: TvChartApi, plan: LegacyImportPlan): Promise<number> {
  let applied = 0;
  if (plan.chartType != null && plan.chartType !== TV_SERIES.candles) {
    try {
      await chart.setChartType(plan.chartType);
      applied++;
    } catch {
      /* keep candles */
    }
  }
  for (const st of plan.studies) {
    try {
      const id = await chart.createStudy(st.name, false, false, st.inputs, st.overrides);
      if (id) applied++;
    } catch {
      /* skip */
    }
  }
  for (const sh of plan.shapes) {
    try {
      if (sh.kind === "single") await chart.createShape(sh.point, { shape: sh.shape });
      else await chart.createMultipointShape(sh.points, { shape: sh.shape });
      applied++;
    } catch {
      /* skip */
    }
  }
  return applied;
}

/** Import once per market. No-op when already imported or nothing to import. */
export async function importLegacyOnce(
  chart: TvChartApi,
  storage: KeyValueStorage,
  slab: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<number> {
  if (storage.getItem(importedMarker(slab)) != null) return 0;
  const plan = planLegacyImport(storage, slab, nowSec);
  const n = isEmptyPlan(plan) ? 0 : await applyLegacyImport(chart, plan);
  storage.setItem(importedMarker(slab), String(nowSec));
  return n;
}
