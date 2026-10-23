import { isSaneMarketValue } from "@/lib/activeMarketFilter";

/**
 * Engine position scale: every v17 size / OI / volume quantity ("Q") is a
 * base-asset amount in fixed point at 1e6, whatever the base mint's decimals —
 * the engine's notional is `size_q * price_e6 / POS_SCALE` (percolator
 * src/lib.rs POS_SCALE = 1_000_000; src/v16.rs trade_notional_floor).
 *
 * The indexer's `market_stats.volume_24h` is `SUM(ABS(trades.size))` of those
 * same Q units (see __tests__/lib/indexer-stats-volume-usd.test.ts), and a
 * trade's recorded fee confirms it: SOL fill size 3_298_097 @ $118.78 carried a
 * $1.1752 fee = 30 bps of 3.298 SOL x $118.78, not of 0.0033 SOL.
 *
 * Dividing by the MINT's decimals instead (the old /api/markets rawToUsd) is
 * right only for 6-decimal mints — SOL (9) came out 1000x too small ($0.40
 * for ~$397 of volume).
 */
export const Q_SCALE = 1_000_000;
/** log10(Q_SCALE) — the `decimals` to pass to token-amount formatters for a Q quantity. */
export const Q_DECIMALS = 6;

/** Cap per-market USD contribution — prevents sentinel leakage ($10B > any real market). */
export const MAX_PER_MARKET_USD = 10_000_000_000;

/**
 * USD value of a Q quantity at `priceUsd`, rounded to cents.
 *
 * - 0 -> 0 (a real, valid zero — no price needed)
 * - null / non-finite / insane raw -> null
 * - no usable price -> null (indeterminate, NOT zero)
 * - above MAX_PER_MARKET_USD -> null (sentinel leakage)
 */
export function qToUsd(
  rawQ: number | null | undefined,
  priceUsd: number | null | undefined,
): number | null {
  if (rawQ == null || !Number.isFinite(rawQ)) return null;
  if (rawQ === 0) return 0;
  if (!isSaneMarketValue(rawQ)) return null;
  const p = priceUsd ?? 0;
  if (!(p > 0) || !Number.isFinite(p)) return null;
  const usd = (rawQ / Q_SCALE) * p;
  // GH#1618: round to 2dp to eliminate IEEE-754 float artifacts.
  return usd > MAX_PER_MARKET_USD ? null : Math.round(usd * 100) / 100;
}

/**
 * 24h volume in USD for a /api/markets row: the API's own `volume_24h_usd`
 * when present (already Q-scaled server-side), else `volume_24h` (Q) at the
 * row's `last_price`. `volume_24h` is NEVER dollars — formatting it as currency
 * directly (LiveMarketRail, MarketInfoBar) showed SOL's 3_396_789 Q as "$3.4M"
 * for ~$397 of volume. null = unknown, 0 = a real zero.
 */
export function rowVolumeUsd(
  row: { volume_24h?: number | null; volume_24h_usd?: number | null; last_price?: number | null } | null | undefined,
): number | null {
  if (!row) return null;
  const usd = row.volume_24h_usd;
  if (typeof usd === "number" && Number.isFinite(usd)) return usd;
  return qToUsd(row.volume_24h, row.last_price);
}

/**
 * "≈ $200.12": a position's size (Q, signed) valued at the mark, for the small
 * line under a size shown in base units. Q, so Q_SCALE via qToUsd — never the
 * mint's or the collateral's decimals.
 *
 * null when there is no position or no usable mark: an unknown price is not a
 * $0.00 position.
 */
export function positionSizeUsdText(
  sizeQ: bigint,
  markPriceE6: bigint | null | undefined,
): string | null {
  if (sizeQ === 0n || markPriceE6 == null || markPriceE6 <= 0n) return null;
  const absQ = sizeQ < 0n ? -sizeQ : sizeQ;
  const usd = qToUsd(Number(absQ), Number(markPriceE6) / 1_000_000);
  if (usd == null) return null;
  return `≈ $${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
