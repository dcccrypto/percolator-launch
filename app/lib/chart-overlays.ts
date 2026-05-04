/**
 * Single source of truth for the chart-overlay user preferences.
 *
 * Each overlay (Avg Entry price line, Liquidation price line, Live PnL label)
 * has an independent ON/OFF user preference, persisted to localStorage and
 * surfaced via the toolbar's Display menu. The renderer reads the prefs and
 * conditionally draws the overlay; this module owns ONLY the union, defaults,
 * labels, and parse-safety helpers.
 *
 * Mirrors the architecture of chart-style.ts — append-once-update-everywhere
 * via a single `as const` tuple, with assertNever and `Record<OverlayKey,...>`
 * giving compile-time enforcement that labels and defaults stay in lockstep.
 */

/** Single source of truth for every overlay the chart can toggle. */
const ALL_OVERLAYS = ["position", "entry", "liq", "pnl"] as const;

/** Discriminator union for chart-overlay preferences. */
export type OverlayKey = (typeof ALL_OVERLAYS)[number];

/** Display order in the Display menu. Reads top-to-bottom in the order a
 *  trader thinks about an open position: do I have one (Position) → where
 *  did I get in (Entry) → where do I get liquidated (Liq) → what's it doing
 *  (PnL). */
export const OVERLAY_DISPLAY_ORDER: readonly OverlayKey[] = ALL_OVERLAYS;

/** Human-readable labels. Adding a new OverlayKey forces this Record to grow
 *  — TypeScript flags any missing entry. */
export const OVERLAY_LABELS: Record<OverlayKey, string> = {
  position: "Position Summary",
  entry: "Avg Entry Price",
  liq: "Liquidation Price",
  pnl: "Live PnL",
};

/** Persisted preference shape: every overlay key mapped to ON/OFF. */
export type OverlayPrefs = Record<OverlayKey, boolean>;

/** Defaults are all ON — matches today's behaviour where Liq/Entry render
 *  whenever a position is open. The Display menu is a way to OPT OUT, not
 *  opt in. Future overlays added to ALL_OVERLAYS must declare a default
 *  here or this Record fails to type-check. */
export const DEFAULT_OVERLAY_PREFS: OverlayPrefs = {
  position: true,
  entry: true,
  liq: true,
  pnl: true,
};

const VALID_KEYS: ReadonlySet<string> = new Set(ALL_OVERLAYS);

/** Type guard for unknown input (localStorage reads, URL params, etc). */
export function isOverlayKey(v: unknown): v is OverlayKey {
  return typeof v === "string" && VALID_KEYS.has(v);
}

/** Merge a partial / unknown stored value with defaults. Recovers gracefully
 *  from older deploys that persisted a smaller set of keys, or from forward-
 *  compat reads where a downgraded build sees a key it doesn't know about
 *  (the unknown key is dropped, known keys missing from the input fall back
 *  to DEFAULT_OVERLAY_PREFS). */
export function mergeOverlayPrefs(stored: unknown): OverlayPrefs {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    return { ...DEFAULT_OVERLAY_PREFS };
  }
  const obj = stored as Record<string, unknown>;
  const merged = { ...DEFAULT_OVERLAY_PREFS };
  for (const key of ALL_OVERLAYS) {
    if (typeof obj[key] === "boolean") merged[key] = obj[key] as boolean;
  }
  return merged;
}
