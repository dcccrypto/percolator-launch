import { BLOCKED_SLAB_ADDRESSES } from "@/lib/blocklist";
import { isHiddenFromListing } from "@/lib/listing-hidden";
import { isZombieMarket } from "@/lib/activeMarketFilter";
import { PLAYGROUND_SLAB_META } from "@/lib/playground-slab-meta";

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
  /** On-chain launch-completeness (marketauth rotated to the stake-pool PDA). Explicit false = the
   *  launch provably never finished; absent/undefined = unread (shown). */
  is_complete?: unknown;
}

/**
 * A market whose launch provably never finished: the create wizard's last on-chain step (stake-pool
 * init, which rotates `marketauth` off the creator) never ran, so `is_complete === false`.
 * Identifiable on chain, so no per-slab list is needed. Curated seeds are exempt (proven complete
 * out of band). Only an EXPLICIT false counts; an unread value degrades to "shown".
 */
export function isHalfMadeLaunch(slab: string, row: { is_complete?: unknown }): boolean {
  return row.is_complete === false && !PLAYGROUND_SLAB_META[slab];
}

/**
 * Whether a row may appear in a BROWSE / PICKER surface (trade-page market switcher and selector,
 * the /trade default pick): not listing-hidden, not blocklisted, not a half-made launch, and not an
 * unpriceable orphan (registry row with an explicit empty pool, i.e. an "UNKNOWN" placeholder).
 * Deliberately NOT the zombie test: those pickers have always listed empty-but-priced markets.
 * Browse only: the market stays reachable by direct link, in the creator's My Markets and in
 * RecoverSolBanner (reclaim), and in /api/markets (portfolio symbol resolution).
 */
export function isBrowsableMarketRow(slab: string, row: ListedMarketStatsRow): boolean {
  if (BLOCKED_SLAB_ADDRESSES.has(slab)) return false;
  if (isHiddenFromListing(slab)) return false;
  if (isHalfMadeLaunch(slab, row)) return false;
  if (hasNoPriceSource(row) && !PLAYGROUND_SLAB_META[slab]) return false;
  return true;
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
  if (isHalfMadeLaunch(slab, row)) return false;
  return !isZombieMarket({
    vault_balance: numericOrNull(row.vault_balance),
    c_tot: numericOrNull(row.c_tot),
    last_price: sanitizePrice(row.last_price),
    volume_24h: numericOrNull(row.volume_24h),
    total_open_interest: numericOrNull(row.total_open_interest),
    total_accounts: numericOrNull(row.total_accounts),
  });
}

/**
 * The creator's OWN just-launched market, before its live price is connected: the registry row
 * exists (the indexer inserted it, or the registration wrote it) but carries no price source, so
 * isListedMarketRow hides it from everyone. The wallet that deployed it still sees it in the
 * markets list, marked "awaiting live price", instead of nothing while the registration lands. It
 * is shown only to that wallet, and only if every other listing rule passes (not blocked, not
 * hidden, not a half-made launch, not a zombie): an unpriced or half-made market stays hidden from
 * every other visitor and from every picker.
 */
export function isOwnAwaitingPriceRow(
  slab: string,
  row: ListedMarketStatsRow & { deployer?: unknown },
  wallet: string | null | undefined,
): boolean {
  if (!wallet || typeof row.deployer !== "string" || row.deployer !== wallet) return false;
  if (!hasNoPriceSource(row)) return false;
  if (PLAYGROUND_SLAB_META[slab]) return false;
  // Every rule except the missing price source: an undefined pool reads as "unknown", i.e. listed.
  return isListedMarketRow(slab, { ...row, dex_pool_address: undefined });
}
