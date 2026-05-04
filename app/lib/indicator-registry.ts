/**
 * Single source of truth for the indicator system.
 *
 * Owns the `IndicatorKind` union, the `IndicatorConfig` discriminated union
 * over per-kind parameter shapes, the default config per kind, the human-
 * readable labels, and the overlay-vs-pane classification used by the
 * renderer to decide where each indicator draws.
 *
 * Mirrors the architecture of chart-overlays.ts and chart-style.ts —
 * append-once-update-everywhere via a single `as const` tuple. Adding a new
 * indicator means appending to ALL_INDICATOR_KINDS, adding entries to the
 * Record maps, picking overlay-or-pane, and adding a case to the math
 * dispatch in the renderer hooks. TypeScript flags every missing entry at
 * compile time.
 */

import { assertNever } from "./exhaustive";

/** Single source of truth for every indicator the chart can render. */
export const ALL_INDICATOR_KINDS = ["sma", "ema", "bollinger", "rsi", "macd"] as const;

/** Discriminator for indicator dispatch. */
export type IndicatorKind = (typeof ALL_INDICATOR_KINDS)[number];

/** Display order in the f(x) settings menu. Reads top-to-bottom from the
 *  indicators traders use most heavily down to less common ones — matches
 *  the convention on TradingView and MEXC. Derived from ALL_INDICATOR_KINDS
 *  so the menu cannot drift from the union. */
export const INDICATOR_DISPLAY_ORDER: readonly IndicatorKind[] = ALL_INDICATOR_KINDS;

/** Human-readable labels used by the settings UI. Adding a new
 *  IndicatorKind forces this Record to grow — TypeScript flags any missing
 *  entry. */
export const INDICATOR_LABELS: Record<IndicatorKind, string> = {
  sma: "Simple Moving Average",
  ema: "Exponential Moving Average",
  bollinger: "Bollinger Bands",
  rsi: "Relative Strength Index",
  macd: "MACD",
};

/** Per-instance indicator configuration. Each entry in the user's
 *  indicator list is one of these — multiple SMAs at different periods,
 *  one RSI, etc. The `id` distinguishes instances; the `kind` discriminates
 *  the per-kind parameter shape. */
export type IndicatorConfig =
  | { id: string; kind: "sma"; period: number; color: string }
  | { id: string; kind: "ema"; period: number; color: string }
  | { id: string; kind: "bollinger"; period: number; stdDev: number; color: string }
  | { id: string; kind: "rsi"; period: number; color: string }
  | {
      id: string;
      kind: "macd";
      fastPeriod: number;
      slowPeriod: number;
      signalPeriod: number;
      color: string;
    };

/** Per-kind default parameter shape. The `Extract<…>` pattern narrows the
 *  union to the variant matching `K`, then `Omit` strips the per-instance
 *  fields (id, color) leaving just the kind discriminator + params. */
type IndicatorDefaultsFor<K extends IndicatorKind> = Omit<
  Extract<IndicatorConfig, { kind: K }>,
  "id" | "color"
>;

/** Default parameter values per kind (NO id, NO color — those are filled in
 *  at "add indicator" time). Defaults match TradingView's universal
 *  conventions: SMA 20, EMA 21, Bollinger 20/2σ, RSI 14, MACD 12/26/9. */
export const INDICATOR_DEFAULTS: { [K in IndicatorKind]: IndicatorDefaultsFor<K> } = {
  sma: { kind: "sma", period: 20 },
  ema: { kind: "ema", period: 21 },
  bollinger: { kind: "bollinger", period: 20, stdDev: 2 },
  rsi: { kind: "rsi", period: 14 },
  macd: { kind: "macd", fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
};

/** Kinds that render as line series ON the main price chart. */
const OVERLAY_KINDS: ReadonlySet<IndicatorKind> = new Set(["sma", "ema", "bollinger"]);

/** Kinds that render in a separate pane below the main chart (oscillators). */
const PANE_KINDS: ReadonlySet<IndicatorKind> = new Set(["rsi", "macd"]);

/** True when the indicator overlays on the main price scale (SMA, EMA,
 *  Bollinger). These render as line series on the existing chart. */
export function isOverlayKind(kind: IndicatorKind): boolean {
  return OVERLAY_KINDS.has(kind);
}

/** True when the indicator renders in a separate pane below the main chart
 *  (RSI, MACD — oscillators with their own value scale). */
export function isPaneKind(kind: IndicatorKind): boolean {
  return PANE_KINDS.has(kind);
}

const VALID_KINDS: ReadonlySet<string> = new Set(ALL_INDICATOR_KINDS);

/** Type guard for unknown input (localStorage reads, URL params, etc). */
export function isIndicatorKind(v: unknown): v is IndicatorKind {
  return typeof v === "string" && VALID_KINDS.has(v);
}

/** Validates the shape of a stored indicator config. Returns true only when
 *  every required field for the kind is present and correctly typed. Used
 *  by mergeIndicators() to filter junk out of localStorage on load. */
export function isIndicatorConfig(v: unknown): v is IndicatorConfig {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  if (typeof obj.id !== "string" || obj.id.length === 0) return false;
  if (typeof obj.color !== "string" || obj.color.length === 0) return false;
  if (!isIndicatorKind(obj.kind)) return false;
  switch (obj.kind) {
    case "sma":
    case "ema":
    case "rsi":
      return typeof obj.period === "number" && Number.isFinite(obj.period) && obj.period >= 1;
    case "bollinger":
      return (
        typeof obj.period === "number" &&
        Number.isFinite(obj.period) &&
        obj.period >= 1 &&
        typeof obj.stdDev === "number" &&
        Number.isFinite(obj.stdDev) &&
        obj.stdDev >= 0
      );
    case "macd":
      return (
        typeof obj.fastPeriod === "number" &&
        Number.isFinite(obj.fastPeriod) &&
        obj.fastPeriod >= 1 &&
        typeof obj.slowPeriod === "number" &&
        Number.isFinite(obj.slowPeriod) &&
        obj.slowPeriod >= 1 &&
        typeof obj.signalPeriod === "number" &&
        Number.isFinite(obj.signalPeriod) &&
        obj.signalPeriod >= 1
      );
    default:
      return assertNever(obj.kind);
  }
}

/** Versioned storage envelope. Bumping the version triggers a graceful
 *  fallback to defaults rather than crash-parsing a future format. */
export interface IndicatorsStorage {
  version: number;
  indicators: IndicatorConfig[];
}

export const INDICATORS_STORAGE_VERSION = 1;

/** Maximum indicators per slab. Past this cap the user has too much chart
 *  clutter to read anyway, and the localStorage write grows unbounded.
 *  When inserting past the cap, drop the OLDEST (front of the array). */
export const MAX_INDICATORS_PER_SLAB = 20;

/** Tolerant deserializer for the stored indicator list. Drops malformed
 *  entries silently, falls back to [] for unparseable input, ignores
 *  unknown future-format envelopes. Mirrors the merge-not-reject pattern
 *  used by mergeOverlayPrefs. */
export function mergeIndicators(stored: unknown): IndicatorConfig[] {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return [];
  const obj = stored as Record<string, unknown>;
  if (typeof obj.version !== "number" || obj.version !== INDICATORS_STORAGE_VERSION) return [];
  if (!Array.isArray(obj.indicators)) return [];
  const result: IndicatorConfig[] = [];
  const seenIds = new Set<string>();
  for (const entry of obj.indicators) {
    if (!isIndicatorConfig(entry)) continue;
    if (seenIds.has(entry.id)) continue; // drop duplicates
    seenIds.add(entry.id);
    result.push(entry);
    if (result.length >= MAX_INDICATORS_PER_SLAB) break;
  }
  return result;
}
