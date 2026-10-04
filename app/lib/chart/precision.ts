/**
 * Price-axis precision for a perp chart.
 *
 * The on-chain mark lives on an e6 grid (1e-6 USD per unit), so a $0.000126 token has only ~3
 * significant digits and moves in visible 1e-6 steps. The axis must therefore (a) show enough
 * decimals that those steps are visible rather than rounded away, and (b) never show more digits
 * than the grid can carry.
 */
export function perpPricePrecision(ref: number | null | undefined): { precision: number; minMove: number } {
  const p = ref != null && Number.isFinite(ref) ? Math.abs(ref) : 0;
  if (p <= 0) return { precision: 2, minMove: 0.01 };
  if (p >= 1000) return { precision: 2, minMove: 0.01 };
  if (p >= 1) return { precision: 4, minMove: 0.0001 };
  // 4 significant digits, capped at the e6 grid's 6 decimals + 2 spare for sub-grid oracle prices.
  const lead = -Math.floor(Math.log10(p)); // 0.0346 -> 2
  const precision = Math.min(8, Math.max(4, lead + 3));
  return { precision, minMove: Number((10 ** -precision).toFixed(precision)) };
}

/** Compact price text for a header chip: same precision rule, no thousands separators below 1000. */
export function formatPerpPrice(p: number | null | undefined, ref?: number | null): string {
  if (p == null || !Number.isFinite(p)) return "—";
  const { precision } = perpPricePrecision(ref ?? p);
  return p.toLocaleString("en-US", { minimumFractionDigits: precision, maximumFractionDigits: precision });
}
