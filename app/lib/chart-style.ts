/**
 * Pure helpers for the TradingChart series-style preference.
 *
 * Extracted from useChartStylePref.ts and TradingChart.tsx so the union,
 * the "is this a valid persisted value?" guard, and the "is this a candle
 * variant?" guard all derive from a single source of truth. Adding a new
 * variant means appending to one tuple — TypeScript catches drift between
 * the union and the runtime sets at compile time.
 */

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
