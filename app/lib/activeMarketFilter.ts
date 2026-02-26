/**
 * Shared filter logic for counting "active" markets.
 *
 * A market is active if it has at least one non-zero, non-sentinel stat
 * (price, volume, or open interest). Sentinel values ≈ u64::MAX (1.844e19)
 * are treated as zero because they come from uninitialized on-chain fields.
 *
 * SINGLE SOURCE OF TRUTH: used by homepage, /api/stats, and markets page
 * to ensure consistent market counts across the platform.
 */

/** Returns true if a numeric value is sane (positive, finite, not a u64::MAX sentinel). */
export function isSaneMarketValue(v: number | null | undefined): boolean {
  if (v == null) return false;
  return v > 0 && v < 1e18 && Number.isFinite(v);
}

/**
 * Determine if a market row (from markets_with_stats) is "active".
 * A market is active if it has at least one sane metric.
 */
export function isActiveMarket(row: {
  last_price?: number | null;
  volume_24h?: number | null;
  total_open_interest?: number | null;
  open_interest_long?: number | null;
  open_interest_short?: number | null;
}): boolean {
  if (isSaneMarketValue(row.last_price)) return true;
  if (isSaneMarketValue(row.volume_24h)) return true;
  if (isSaneMarketValue(row.total_open_interest)) return true;
  // Fallback: sum of long + short OI
  const combinedOI = (row.open_interest_long ?? 0) + (row.open_interest_short ?? 0);
  if (isSaneMarketValue(combinedOI)) return true;
  return false;
}
