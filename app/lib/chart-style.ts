/**
 * Pure helpers for the TradingChart series-style preference.
 *
 * Extracted from useChartStylePref.ts and TradingChart.tsx so the union,
 * the "is this a valid persisted value?" guard, and the "is this a candle
 * variant?" guard all derive from a single source of truth. Adding a new
 * variant means appending to one tuple — TypeScript catches drift between
 * the union and the runtime sets at compile time.
 */

import { assertNever } from "./exhaustive";

/** Single source of truth for every chart style TradingChart can render.
 *  The `ChartStyle` union and the `VALID_STYLES` set are both derived
 *  from this tuple — append here to add a variant. */
const ALL_STYLES = [
  "line",
  "area",
  "candle-solid",
  "candle-hollow",
  "candle-hollow-up",
  "candle-hollow-down",
  "bar",
] as const;

/** Subset of `ALL_STYLES` that renders as a candlestick series. The
 *  `satisfies readonly ChartStyle[]` clause makes a typo or removed
 *  variant a compile error rather than a silent runtime fall-through. */
const ALL_CANDLE_STYLES = [
  "candle-solid",
  "candle-hollow",
  "candle-hollow-up",
  "candle-hollow-down",
] as const satisfies readonly ChartStyle[];

/** Chart series styles TradingChart can render today. The union is kept
 *  intentionally narrow — each new variant is added in lockstep with the
 *  render branch that draws it. Stale values from older deploys (or future
 *  builds being downgraded) fail isChartStyle() and fall back to
 *  DEFAULT_CHART_STYLE. */
export type ChartStyle = (typeof ALL_STYLES)[number];

/** Strict subset narrowed to the candlestick variants. */
export type CandleStyle = (typeof ALL_CANDLE_STYLES)[number];

/** Default series style used during SSR / first paint and as the
 *  recovery target when a stored preference fails validation. */
export const DEFAULT_CHART_STYLE: ChartStyle = "candle-solid";

/** Human-readable labels for the style picker. Kept here (not inline in the
 *  menu component) so adding a new ChartStyle variant forces the
 *  `Record<ChartStyle, string>` to grow in lockstep — TypeScript flags any
 *  new union member that lacks an entry here. */
export const CHART_STYLE_LABELS: Record<ChartStyle, string> = {
  "line": "Line",
  "area": "Area",
  "candle-solid": "Candle (Solid)",
  "candle-hollow": "Candle (Hollow)",
  "candle-hollow-up": "Candle (Hollow Up)",
  "candle-hollow-down": "Candle (Hollow Down)",
  "bar": "Bar (OHLC)",
};

/** Display order for the style picker. Reads top-to-bottom from simplest
 *  series (line) to richest (bar OHLC). Derived from ALL_STYLES so the menu
 *  cannot drift from the union — the order is intentional, not alphabetic. */
export const CHART_STYLE_DISPLAY_ORDER: readonly ChartStyle[] = ALL_STYLES;

const VALID_STYLES: ReadonlySet<ChartStyle> = new Set(ALL_STYLES);
const CANDLE_STYLES: ReadonlySet<ChartStyle> = new Set(ALL_CANDLE_STYLES);

/** Type guard for unknown input (localStorage reads, URL params, etc). */
export function isChartStyle(v: unknown): v is ChartStyle {
  return typeof v === "string" && VALID_STYLES.has(v as ChartStyle);
}

/** True when `s` is one of the candlestick variants. Narrows the type so
 *  downstream code can branch on candle-only chart options for free. */
export function isCandleStyle(s: ChartStyle): s is CandleStyle {
  return CANDLE_STYLES.has(s);
}

/** Subset of lightweight-charts `CandlestickSeriesPartialOptions` we set per
 *  variant. We avoid importing the library type here to keep this module
 *  pure (Apache-2.0 friendly + tree-shakeable). The shape is enforced
 *  structurally by `addCandlestickSeries` at the call site. */
export interface CandleStyleOptions {
  upColor: string;
  downColor: string;
  borderUpColor: string;
  borderDownColor: string;
  wickUpColor: string;
  wickDownColor: string;
  borderVisible: boolean;
}

/** lightweight-charts series-API discriminator strings TradingChart can hold a
 *  ref to. Every render branch in TradingChart's series-creation switch maps
 *  to exactly one of these. Centralised here so the `seriesRef` declaration
 *  and the `addOverlayLines` parameter cannot drift apart. */
export type ChartSeriesKind = "Candlestick" | "Line" | "Area" | "Bar";

/** Which raw data shape a chart style consumes:
 *
 *  - `"ohlc"`   — needs `{open, high, low, close}` per bar (candle + bar series)
 *  - `"single"` — needs `{price}` per point (line + area series)
 *
 *  Two distinct call sites in TradingChart need this answer (sparse-data
 *  overlay, fit-key viewport bucket). Centralising it means adding a new
 *  ChartStyle to ALL_STYLES forces a build error at the assertNever default
 *  rather than silently mis-classifying. */
export function chartDataKind(style: ChartStyle): "ohlc" | "single" {
  switch (style) {
    case "candle-solid":
    case "candle-hollow":
    case "candle-hollow-up":
    case "candle-hollow-down":
    case "bar":
      return "ohlc";
    case "line":
    case "area":
      return "single";
    default:
      return assertNever(style);
  }
}

/** Minimal structural shapes the renderable-data check needs. Declared here
 *  (not imported from TradingChart) to keep this module pure and avoid an
 *  import cycle. Callers can pass their richer types — only `.length` is read. */
interface OhlcLike { readonly timestamp: number }
interface PricePointLike { readonly timestamp: number }

/** Render-readiness of the data source the given style will actually consume.
 *
 *  - `ready`  — true when the relevant array has >= 1 point. Used by the
 *               render-switch to bail before calling `addXSeries(...)`.
 *  - `sparse` — true when the relevant array has < 2 points. A single point
 *               cannot draw a usable body/line, so the "Price chart building…"
 *               overlay paints instead.
 *
 *  The two thresholds (`>= 1` vs `< 2`) are intentional and live here so they
 *  cannot drift across call sites — before this helper, the switch used
 *  `=== 0` and the overlay used `< 2`, and the overlay only checked candle +
 *  line so area and bar fell through and never showed the sparse banner. */
export function hasRenderableData(
  style: ChartStyle,
  candleData: readonly OhlcLike[],
  lineData: readonly PricePointLike[],
): { ready: boolean; sparse: boolean } {
  const len = chartDataKind(style) === "ohlc" ? candleData.length : lineData.length;
  return { ready: len >= 1, sparse: len < 2 };
}

/** Build the `addCandlestickSeries` option preset for a given candle variant.
 *
 *  - `candle-solid`: filled bodies in trend color (the default lightweight-charts look)
 *  - `candle-hollow`: transparent bodies, colored borders — minimal "outlined" look
 *  - `candle-hollow-up`: hollow on bullish bars, solid on bearish (TradingView's
 *    classic style — emphasises selling pressure)
 *  - `candle-hollow-down`: solid bullish, hollow bearish (less common; some traders
 *    use it to emphasise buying pressure)
 *
 *  Wick colors always follow the trend color so direction stays visible even
 *  when the body is hollow. `borderVisible` is true for any hollow variant
 *  so the outline draws. */
export function candleStyleOptions(
  style: CandleStyle,
  upColor: string,
  downColor: string,
): CandleStyleOptions {
  const base: CandleStyleOptions = {
    upColor,
    downColor,
    borderUpColor: upColor,
    borderDownColor: downColor,
    wickUpColor: upColor,
    wickDownColor: downColor,
    borderVisible: false,
  };
  switch (style) {
    case "candle-solid":
      return base;
    case "candle-hollow":
      return { ...base, upColor: "rgba(0,0,0,0)", downColor: "rgba(0,0,0,0)", borderVisible: true };
    case "candle-hollow-up":
      return { ...base, upColor: "rgba(0,0,0,0)", borderVisible: true };
    case "candle-hollow-down":
      return { ...base, downColor: "rgba(0,0,0,0)", borderVisible: true };
    default:
      // If a new CandleStyle is added to ALL_CANDLE_STYLES without a case
      // here, TypeScript fails at this call site rather than at the function
      // signature, pointing at the missing branch.
      return assertNever(style);
  }
}
