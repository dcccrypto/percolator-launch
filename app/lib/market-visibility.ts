import { BLOCKED_SLAB_ADDRESSES } from "@/lib/blocklist";
import { isHiddenFromListing } from "@/lib/listing-hidden";
import { isZombieMarket } from "@/lib/activeMarketFilter";
import { PLAYGROUND_SLAB_META } from "@/lib/playground-slab-meta";

/**
 * GH#2705: the ONE definition of which registry rows count as listed markets.
 *
 * /api/stats used to rebuild /api/markets' visibility by hand and mirrored only
 * the zombie half; the completeness gate added to /api/markets on 2026-09-25
 * never reached it, so the dashboard counted (and summed OI/volume for) markets
 * the list hides — 25 vs 20 live. Both routes now read these predicates.
 *
 * Rows are the shape `loadMergedMarketRows()` returns (registry + live merge);
 * NUMERIC columns may still be strings, and a key the query never selected is
 * ABSENT (undefined), which isZombieMarket must see as "not mirrored", not 0.
 */

/** $1M ceiling — mirrors /api/markets sanitizePrice (MAX_SANE_PRICE_USD). */
const MAX_SANE_PRICE_USD = 1_000_000;

function numericOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function asSupplied(row: Record<string, unknown>, key: string): number | null | undefined {
  return row[key] === undefined ? undefined : numericOrNull(row[key]);
}

/**
 * Creation PROVEN unfinished on-chain (`is_complete === false`: marketauth never
 * rotated to the stake-pool PDA). `undefined` (live state unread) is NOT
 * incomplete — an RPC gap degrades to "shown". Curated seeds are exempt: they
 * are proven complete out of band. Applied by /api/markets on both its paths.
 */
export function isProvenIncompleteMarket(row: Record<string, unknown>): boolean {
  return row.is_complete === false && !PLAYGROUND_SLAB_META[row.slab_address as string];
}

/**
 * Zombie test over a registry row, with the same inputs /api/markets feeds
 * isZombieMarket: last_price sanitized to (0, $1M], absent keys forwarded as
 * undefined.
 */
export function isZombieRegistryRow(row: Record<string, unknown>): boolean {
  const rawPrice = numericOrNull(row.last_price);
  const sanitizedPrice =
    rawPrice != null && rawPrice > 0 && rawPrice <= MAX_SANE_PRICE_USD ? rawPrice : null;
  return isZombieMarket({
    vault_balance: asSupplied(row, "vault_balance"),
    c_tot: asSupplied(row, "c_tot"),
    last_price: sanitizedPrice,
    volume_24h: numericOrNull(row.volume_24h),
    total_open_interest: asSupplied(row, "total_open_interest"),
    total_accounts: asSupplied(row, "total_accounts"),
  });
}

/**
 * Whether a row is a LISTED market: what the /markets page counts as "All
 * Markets" (/api/markets' default rows, minus the listing-hidden slabs that
 * page and the landing rail drop client-side via lib/listed-markets.ts).
 *
 * /api/markets itself must keep listing-hidden slabs in its payload — portfolio
 * symbol resolution, the trade page and the duplicate-market check read it, and
 * a hidden market's holders must still be able to exit — so that route applies
 * isProvenIncompleteMarket + the zombie test, and the listing-hidden step is
 * applied by the listing surfaces and by /api/stats through this function.
 */
export function isListedMarket(row: Record<string, unknown>): boolean {
  const slab = String(row.slab_address ?? "");
  if (BLOCKED_SLAB_ADDRESSES.has(slab)) return false;
  if (isHiddenFromListing(slab)) return false;
  if (isProvenIncompleteMarket(row)) return false;
  return !isZombieRegistryRow(row);
}
