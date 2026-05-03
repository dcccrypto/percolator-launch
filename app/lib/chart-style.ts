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
  "candle-solid",
  "candle-hollow",
  "candle-hollow-up",
  "candle-hollow-down",
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
