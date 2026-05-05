/**
 * Brand-aware color palette for indicator line colors.
 *
 * Avoids the green/red used by candle bodies (chartTheme.upColor /
 * downColor) so a moving-average line never visually merges with a
 * candle's fill. Ordered to cycle through visually distinct hues so that
 * adding multiple indicators in quick succession produces lines that are
 * easy to tell apart at a glance.
 *
 * The palette is hex strings (no alpha) — alpha is applied per-renderer
 * if needed (e.g., the Bollinger band fill uses ~10% alpha on the
 * indicator's chosen color).
 */

/** Eight distinct, brand-aware indicator colors. Cycles when exhausted. */
export const INDICATOR_COLORS = [
  "#9945FF", // brand purple
  "#22D3EE", // cyan
  "#F59E0B", // amber
  "#3B82F6", // blue
  "#EC4899", // pink
  "#A855F7", // violet
  "#14B8A6", // teal
  "#F97316", // orange
] as const;

/** Pick the next color for a new indicator. Prefers colors not already in
 *  `usedColors`; if all 8 are taken, cycles from the start (returns the
 *  first palette color). The user can have at most 20 indicators per slab
 *  — the duplicate cycling at >8 is a deliberate trade-off (color picker
 *  for fine-grained control is deferred to a follow-up commit). */
export function getNextColor(usedColors: readonly string[]): string {
  for (const color of INDICATOR_COLORS) {
    if (!usedColors.includes(color)) return color;
  }
  // All palette colors used — cycle from the first.
  return INDICATOR_COLORS[0];
}
