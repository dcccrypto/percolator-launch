import { BLOCKED_SLAB_ADDRESSES } from "@/lib/blocklist";
import { isHiddenFromListing } from "@/lib/listing-hidden";
import { isZombieMarket } from "@/lib/activeMarketFilter";

/** Max sane price (USD) for both listed-market filtering and display capping.
 *  Mirrors /api/stats sanitizePrice() cap. Corrupt oracle prices (e.g. $7.9T)
 *  exceed this and are nulled/excluded. */
export const MAX_SANE_PRICE_USD = 1_000_000;

/** GH#1536: NUMERIC columns arrive from Supabase as strings; coerce before
 *  comparing (`"0" === 0` is false and lets zombies through). */
function numericOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** GH#1536: raw DB prices above the cap are stale garbage and must not count
 *  as activity in the zombie check (mirrors /api/markets GH#1506). */
function sanitizePrice(v: unknown): number | null {
  const n = numericOrNull(v);
  if (n == null || n <= 0 || n > MAX_SANE_PRICE_USD) return null;
  return n;
}

/**
 * A-6: a market with NO price source recorded can never be priced by the keeper. The keeper
 * reads each market's price from the DEX pool recorded at registration (`dex_pool_address`), so a
 * market whose registry row carries an explicit null/empty pool is an orphan (e.g. the abandoned
 * Hm1bapsZ… creation the indexer auto-listed): nothing will ever push to it.
 *
 * "Never priced" is deliberately NOT used as the signal. A brand-new market with a registered
 * pool has not been pushed yet either, and hiding it before its first push would hide every market
 * for its first minutes; those stay listed and show an "Awaiting price" badge (no new positions
 * until the price lands, which the order ticket already enforces). Only an EXPLICIT null/empty
 * pool counts: `undefined` (the field was not selected / not read) degrades to "listed", the same
 * policy as is_complete. The market stays reachable by direct URL and in the portfolio, so any
 * funds in it can still be closed and withdrawn.
 */
export function hasNoPriceSource(row: { dex_pool_address?: unknown }): boolean {
  const v = row.dex_pool_address;
  if (v === undefined) return false;
  return v === null || (typeof v === "string" && v.trim() === "");
}

/** The stats fields the listing decision reads. Values may be number, string or null. */
export interface ListedMarketStatsRow {
  vault_balance?: unknown;
  c_tot?: unknown;
  last_price?: unknown;
  volume_24h?: unknown;
  total_open_interest?: unknown;
  total_accounts?: unknown;
  /** A-6: the keeper's price source. Explicit null/"" = unpriceable orphan; absent = unknown (listed). */
  dex_pool_address?: unknown;
}

/**
 * Whether a market row from `/api/markets?include_zombie=true` is LISTED: not
 * blocklisted (GH#1539) and not a zombie (GH#1531). This is the single
 * definition shared by the /markets page and the landing page's Live Markets
 * rail, so the two can never disagree about which markets exist.
 */
export function isListedMarketRow(slab: string, row: ListedMarketStatsRow): boolean {
  if (BLOCKED_SLAB_ADDRESSES.has(slab)) return false;
  if (isHiddenFromListing(slab)) return false;
  if (hasNoPriceSource(row)) return false;
  return !isZombieMarket({
    vault_balance: numericOrNull(row.vault_balance),
    c_tot: numericOrNull(row.c_tot),
    last_price: sanitizePrice(row.last_price),
    volume_24h: numericOrNull(row.volume_24h),
    total_open_interest: numericOrNull(row.total_open_interest),
    total_accounts: numericOrNull(row.total_accounts),
  });
}
