import { NextRequest, NextResponse } from "next/server";
// requireAuth removed from POST — on-chain admin verification is sufficient
import { Connection, PublicKey } from "@solana/web3.js";
import { validateNumericParam } from "@/lib/route-validators";
import { parseHeader } from "@percolator/sdk";
import { getServiceClient } from "@/lib/supabase";
import { getConfig } from "@/lib/config";
import * as Sentry from "@sentry/nextjs";
import { isSaneMarketValue, isActiveMarket, isZombieMarket } from "@/lib/activeMarketFilter";
import { isPhantomOpenInterest } from "@/lib/phantom-oi";
import { computeMarketHealthFromStats } from "@/lib/health";
import { BLOCKED_SLAB_ADDRESSES } from "@/lib/blocklist";
import { SLUG_ALIASES } from "@/lib/symbol-utils";

/**
 * GH#1526: Map frontend oracle_mode filter values to DB-stored values.
 * The UI displays "manual" and "live feed" but the DB stores "admin" and "hyperp".
 * Without this map the filter returns 0 results for any value except "admin".
 */
const ORACLE_MODE_FRONTEND_TO_DB: Record<string, string> = {
  manual: "admin",
  live_feed: "hyperp",
  // Pass-through values (already DB canonical)
  admin: "admin",
  hyperp: "hyperp",
  pyth: "pyth",
};

/**
 * GH#1527: Build a reverse lookup from mint address → well-known ticker symbol.
 * Used to make search match "SOL" even when DB stores symbol="So111111".
 * Derived from SLUG_ALIASES (single source of truth).
 */
const MINT_TO_KNOWN_SYMBOL: Map<string, string> = new Map(
  Object.entries(SLUG_ALIASES).map(([symbol, mint]) => [mint, symbol]),
);

/**
 * Maximum valid funding rate in bps/slot (matches on-chain guard).
 * Raw DB values outside [-MAX, MAX] are garbage from uninitialized slabs.
 */
const FUNDING_RATE_BPS_MAX = 10_000;

/** Cap per-market USD contribution — prevents sentinel leakage ($10B > any real market). */
const MAX_PER_MARKET_USD = 10_000_000_000;

/**
 * GH#1208: Cap for c_tot raw value.
 * c_tot is LP collateral in token micro-units. Even the deepest devnet vault
 * would not exceed $100M USD at any reasonable token price. Raw cap at 5e17
 * catches near-sentinel corrupted values (e.g. 7.997e17) that slip through
 * the isSaneMarketValue 1e18 threshold.
 */
const MAX_SANE_C_TOT = 5e17;

/**
 * Return null for c_tot values that are clearly corrupted.
 * Does NOT convert to USD — just guards the raw value.
 */
function sanitizeCtot(v: number | null | undefined): number | null {
  if (v == null) return null;
  if (!Number.isFinite(v) || v < 0 || v > MAX_SANE_C_TOT) return null;
  return v;
}

/**
 * GH#1564: Coerce a value to number | null.
 * Supabase returns NUMERIC columns as JavaScript strings at runtime (TypeScript `as number`
 * is compile-time only). Without this coercion, Number.isFinite("0.42") → false, causing
 * sanitizePrice / rawToUsd / isSaneMarketValue to return null for every market.
 * This helper is module-level so it can be used both in the map() pipeline and in the
 * zombie-check block (previously it was defined inline inside map, too late for USD calcs).
 */
function numericOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Convert a raw on-chain token micro-unit amount to USD.
 * Returns null when the raw value is a sentinel/garbage or no price is available.
 * GH#1578: Explicitly return 0 when raw value is exactly 0 — isSaneMarketValue requires
 * v > 0 and would otherwise return null for zero-OI/volume markets.
 * (#1160: expose a pre-computed USD field so API consumers don't have to divide by 10^decimals themselves)
 */
function rawToUsd(raw: number | null | undefined, decimals: number | null | undefined, priceUsd: number | null | undefined): number | null {
  if (raw == null || !Number.isFinite(raw as number)) return null;
  // GH#1578: zero is a valid and expected value — return 0 immediately without price check
  if (raw === 0) return 0;
  if (!isSaneMarketValue(raw)) return null;
  const d = Math.min(Math.max(decimals ?? 6, 0), 18);
  const p = priceUsd ?? 0;
  if (p <= 0) return null;
  const usd = (raw! / 10 ** d) * p;
  return usd > MAX_PER_MARKET_USD ? null : usd;
}

/** Sanitize a numeric funding_rate from the DB view. Returns null for garbage values. */
function sanitizeFundingRate(v: number | null | undefined): number | null {
  if (v == null) return null;
  if (!Number.isFinite(v) || Math.abs(v) > FUNDING_RATE_BPS_MAX) return null;
  return v;
}

/**
 * Maximum sane mark/last price in USD for API output.
 * Set at $1M — well above any real crypto price today (BTC ~$100K) but below
 * the unscaled admin-set test garbage values (e.g. $100M, $900M, $7.9T).
 * Note: Rust MAX_ORACLE_PRICE is $1B; this is a stricter display-layer guard. (#856)
 */
const MAX_SANE_PRICE_USD = 1_000_000; // $1M

/**
 * Sanitize a price field from the DB (USD float). Returns null for corrupt/garbage values.
 * Logs a Sentry warning when sanitization fires so we can track data quality. (#882)
 *
 * Fingerprinted per (field, slab) so repeated sanitizations from the same bad market
 * collapse into ONE Sentry issue rather than one event per API poll cycle (#PERC-801).
 *
 * Known causes of sanitization:
 *  - Admin-mode markets with on-chain authorityPriceE6 set to garbage/test values
 *    (e.g. value > MAX_SANE_PRICE_USD × 1e6 on-chain, e.g. GYpukkn94, 2Zta2EPRR)
 *  - HYPERP markets without oracle_markets entries — oracle-keeper can't crank them,
 *    stale/uninitialised lastEffectivePriceE6 leaks through StatsCollector
 *  Fix: seed oracle_markets table (migration 041) for HYPERP markets, or correct the
 *  admin oracle price via the admin UI (pushPrice action with correct price_e6).
 */
function sanitizePrice(v: number | null | undefined, field?: string, slabAddress?: string): number | null {
  if (v == null) return null;
  if (!Number.isFinite(v) || v <= 0 || v > MAX_SANE_PRICE_USD) {
    Sentry.captureMessage(
      `Price sanitization: ${field ?? "price"} nulled for slab ${slabAddress ?? "unknown"} (value=${v})`,
      {
        level: "warning",
        tags: { endpoint: "/api/markets", sanitization: "price", field: field ?? "price" },
        // Fingerprint collapses all events for the same bad (field, slab) pair into a
        // single Sentry issue instead of one event per poll cycle.
        fingerprint: ["price-sanitization", field ?? "price", slabAddress ?? "unknown"],
        extra: { rawValue: v, field, slabAddress, maxSanePriceUsd: MAX_SANE_PRICE_USD },
      },
    );
    return null;
  }
  return v;
}

// #868: Blocklist for markets with corrupt state or wrong oracle_authority (e.g. issue #837).
// GH#1539: Now uses the unified BLOCKED_SLAB_ADDRESSES from lib/blocklist.ts which
// includes both hardcoded addresses and env var overrides. No local merge needed.

export const dynamic = "force-dynamic";

// GET /api/markets — list all active markets with stats
export async function GET(request: NextRequest) {
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("markets_with_stats")
      .select(
        "slab_address,mint_address,symbol,name,decimals,deployer,logo_url,max_leverage,trading_fee_bps," +
        "last_price,mark_price,index_price,volume_24h,trade_count_24h,open_interest_long,open_interest_short,total_open_interest," +
        "insurance_fund,insurance_balance,total_accounts,funding_rate,net_lp_pos,lp_sum_abs,c_tot," +
        "vault_balance,created_at,stats_updated_at,oracle_mode,dex_pool_address,mainnet_ca,oracle_authority"
      );

    if (error) {
      Sentry.captureException(error, {
        tags: { endpoint: "/api/markets", method: "GET" },
      });
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Sanitize funding_rate: raw DB values from uninitialized slabs can be
    // garbage (e.g. 17733189824741436). Clamp to valid bps range. (#817)
    // Also: oracle_mode was not populated for markets created before migration 035.
    // Derive from oracle_authority: zero pubkey → pyth-pinned, else admin/hyperp.
    // Default to "admin" when unknown — safest assumption for old devnet markets.
    const ZERO_PUBKEY = "11111111111111111111111111111111";
    // GH#1420: Parse ?include_zombie=true to opt-in to zombie markets in the response.
    // By default, markets with vault_balance=0 are excluded as they have no LP liquidity
    // and return garbage/stale prices (e.g. BTC@$148, SOL@$0.60).
    const includeZombie = request?.nextUrl?.searchParams?.get("include_zombie") === "true";

    const sanitized = ((data ?? []) as unknown as Record<string, unknown>[])
      .filter((m) => !BLOCKED_SLAB_ADDRESSES.has(m.slab_address as string))
      .map((m) => {
      let oracle_mode = m.oracle_mode as string | null;
      if (!oracle_mode) {
        const auth = m.oracle_authority as string | null;
        if (auth && auth !== ZERO_PUBKEY) {
          oracle_mode = "admin";
        } else if (auth === ZERO_PUBKEY) {
          oracle_mode = "pyth";
        } else {
          oracle_mode = "admin"; // safe default
        }
      }
      // GH#1564: Coerce all NUMERIC fields from Supabase strings to numbers up-front.
      // Supabase returns NUMERIC columns as strings at runtime; TypeScript `as number` is
      // compile-time only and performs no actual coercion. Without this, Number.isFinite
      // receives a string, returns false, and sanitizePrice / rawToUsd / isSaneMarketValue
      // all return null — causing volume_24h_usd and total_open_interest_usd to be null
      // for every market (168/168). Mirrors the fix already applied in GH#1494 for the
      // zombie-check numericOrNull block, now extended to the USD computation path.
      const n_last_price = numericOrNull(m.last_price);
      const n_mark_price = numericOrNull(m.mark_price);
      const n_index_price = numericOrNull(m.index_price);
      const n_volume_24h = numericOrNull(m.volume_24h);
      const n_total_open_interest = numericOrNull(m.total_open_interest);
      const n_open_interest_long = numericOrNull(m.open_interest_long);
      const n_open_interest_short = numericOrNull(m.open_interest_short);
      const n_decimals = numericOrNull(m.decimals);
      const n_funding_rate = numericOrNull(m.funding_rate);
      const n_vault_balance = numericOrNull(m.vault_balance);
      const n_c_tot = numericOrNull(m.c_tot);
      const n_total_accounts = numericOrNull(m.total_accounts);

      // #1160: Compute a USD-denominated OI field so consumers don't need to divide
      // by 10^decimals manually. Derived from total_open_interest when sane, falls
      // back to open_interest_long + open_interest_short. Raw fields are preserved.
      const sanitizedPrice = sanitizePrice(n_last_price, "last_price", m.slab_address as string);
      // GH#1578: treat explicit 0 as a valid zero-OI value — isSaneMarketValue requires v > 0
      // and would otherwise return null for zero-OI markets.
      // Guard: only short-circuit for 0 when total_open_interest is explicitly 0 (valid data).
      // If total_open_interest is a garbage sentinel (e.g. 2e19), fall through to combined path.
      const rawOi = (n_total_open_interest === 0 || isSaneMarketValue(n_total_open_interest))
        ? n_total_open_interest!
        : (() => {
            // total_open_interest was null or garbage → try long+short fallback
            const combined = (n_open_interest_long ?? 0) + (n_open_interest_short ?? 0);
            return isSaneMarketValue(combined) ? combined : null;
          })();
      const total_open_interest_usd = rawToUsd(rawOi, n_decimals, sanitizedPrice);

      // GH#1250: If total_accounts == 0, OI must be stale/orphaned — suppress from display.
      // Root cause: the on-chain totalOpenInterest counter is not decremented when positions
      // are force-closed or accounts are reclaimed (PERC-511 path). This guard prevents
      // misleading solvency signals (OI > 0 with vault = 0 and no accounts).
      // Indexer-level fix (StatsCollector.ts) will clear OI for future syncs; this is a
      // defensive display-layer fallback.
      // GH#1271: Also suppress when vault_balance = 0 (no LP liquidity → no real positions).
      // PERC-816: Extend to suppress for dust vault_balance (0 < vault < 1,000,000 micro-units).
      // Mirrors the invariant enforced by StatsCollector and migration 049.
      // GH#1290 / PERC-570: Phantom OI guard — suppress all OI fields (USD and raw atoms)
      // when vault is dust/empty or no accounts exist. Matches StatsCollector invariant
      // and migration 051. Suppressing only total_open_interest_usd left the raw
      // total_open_interest atom value in the response, which fed phantom OI into
      // computeMarketHealthFromStats and the markets page sort/filter.
      // GH#1438: Aligned to strict < via shared isPhantomOpenInterest() helper in lib/phantom-oi.ts
      // so /api/markets and /api/stats are guaranteed to use the same predicate (single source of truth).
      // GH#1494/GH#1564: coerce NUMERIC (string from Supabase) to number before arithmetic comparisons.
      // Uses module-level numericOrNull() already applied above; fall back to 0 for nulls.
      const accountsCount = n_total_accounts ?? 0;
      const vaultBal = n_vault_balance ?? 0;
      const isPhantomOI = isPhantomOpenInterest(accountsCount, vaultBal);
      const displayOiUsd = isPhantomOI ? null : total_open_interest_usd;

      // GH#1270: Pre-compute volume_24h in USD so consumers (e.g. Watchlist) don't need
      // to divide by 10^decimals manually. Mirrors the total_open_interest_usd pattern.
      // Raw volume_24h is preserved in the response for backward compatibility.
      // GH#1564: uses n_volume_24h (coerced from Supabase NUMERIC string) — see block above.
      const volume_24h_usd = rawToUsd(n_volume_24h, n_decimals, sanitizedPrice);

      // GH#1420 + GH#1427: Mark zombie markets using shared isZombieMarket() helper.
      // (CodeRabbit #1466: extracted from inline predicate in stats route to avoid drift.)
      // Zombie markets have no LP liquidity; their prices are stale/garbage from
      // when the vault drained (e.g. BTC@$148, SOL@$0.60 — prices from months ago).
      // We tag them with is_zombie=true and exclude them from the default response
      // (opt-in via ?include_zombie=true). See isZombieMarket() in activeMarketFilter.ts
      // for the two conditions: vault=0 (drained) or vault=null+no-stats (phantom).
      //
      // GH#1494/GH#1564: All NUMERIC fields are now coerced via module-level numericOrNull()
      // at the top of this map() (the n_* locals block). No inline helper needed here.
      // GH#1506: Use sanitizedPrice (already capped at MAX_SANE_PRICE_USD=$1M) for the
      // zombie check instead of raw last_price. Raw DB prices can be stale garbage values
      // that pass isSaneMarketValue (< 1e18) but exceed the display cap. NNOB had a stale
      // raw last_price > $1M — sanitizePrice nulled it for output, but passing the raw value
      // to isZombieMarket() made hasActivity=true → c_tot>0 exemption → is_zombie=false even
      // though the API returned null. Using sanitizedPrice keeps zombie check consistent with
      // what consumers receive.
      // GH#1564: All n_* locals already coerced via numericOrNull() above — no double-coerce needed.
      const is_zombie = isZombieMarket({
        vault_balance: n_vault_balance,
        c_tot: n_c_tot,
        last_price: sanitizedPrice,
        volume_24h: n_volume_24h,
        total_open_interest: n_total_open_interest,
        total_accounts: n_total_accounts,
      });

      return {
        ...m,
        oracle_mode,
        is_zombie,
        funding_rate: sanitizeFundingRate(n_funding_rate),
        // #856: Null out corrupt admin-set test prices (raw unscaled u64 values or billions/trillions).
        // Matches Rust MAX_ORACLE_PRICE = $1B USD ceiling.
        // GH#1420: Also null out prices for zombie markets — stale prices with no liquidity are misleading.
        // GH#1564: sanitizedPrice already computed from coerced n_last_price (not the raw string m.last_price).
        last_price: is_zombie ? null : sanitizedPrice,
        mark_price: is_zombie ? null : sanitizePrice(n_mark_price, "mark_price", m.slab_address as string),
        // #855: Apply same sanitization to index_price — same DB column type and
        // corruption vector as last_price/mark_price. Inconsistent sanitization
        // means a corrupt index price still reaches consumers.
        index_price: is_zombie ? null : sanitizePrice(n_index_price, "index_price", m.slab_address as string),
        // #1160 / GH#1290 / PERC-570: OI fields — USD and raw atoms.
        // Raw atom fields (total_open_interest, open_interest_long, open_interest_short) are
        // zeroed (not just the USD conversion) when the phantom OI guard fires.
        // GH#1564: uses coerced n_* values — spread from m would still be strings.
        total_open_interest: isPhantomOI ? 0 : (n_total_open_interest ?? 0),
        open_interest_long: isPhantomOI ? 0 : (n_open_interest_long ?? 0),
        open_interest_short: isPhantomOI ? 0 : (n_open_interest_short ?? 0),
        total_open_interest_usd: displayOiUsd,
        // GH#1270: Pre-converted 24h volume in USD. Null when price unavailable or raw
        // value is a sentinel. Raw volume_24h preserved for backward compatibility.
        // GH#1564: volume_24h_usd now computed from coerced n_volume_24h (not the string m.volume_24h).
        volume_24h_usd,
        // GH#1208: Sanitize c_tot — near-sentinel values (e.g. 7.997e17) pass the
        // isSaneMarketValue 1e18 check but are clearly corrupt LP collateral totals.
        c_tot: sanitizeCtot(n_c_tot),
      };
    });

    // GH#1420: Filter zombie markets (vault_balance=0) unless ?include_zombie=true
    const nonZombie = sanitized.filter((m) => includeZombie || !(m as Record<string, unknown>).is_zombie);
    // GH#1429: Compute zombieCount from sanitized array BEFORE the zombie filter, not from
    // the difference sanitized.length - nonZombie.length. When include_zombie=true, nonZombie
    // includes all markets (including zombies), making the difference always 0. Computing
    // directly from the tagged is_zombie field gives the correct count regardless of the flag.
    const zombieCount = sanitized.filter((m) => (m as Record<string, unknown>).is_zombie === true).length;

    // #1168: Include total count so API consumers can get market count without
    // fetching all records. Reflects post-filter count (blocked markets excluded).
    // #1172: Add activeTotal — markets with at least one sane stat (price/volume/OI).
    // This matches the count shown by /api/stats totalMarkets.
    // GH#1455: Always compute activeTotal from non-zombie markets only, regardless of
    // include_zombie flag. Previously, when include_zombie=true, nonZombie contained ALL
    // markets (including zombies), so activeTotal counted zombie markets that passed
    // isActiveMarket() — producing 71 instead of 69. Computing from the zombie-excluded
    // set ensures consistency with /api/stats.
    const nonZombieOnly = sanitized.filter((m) => !(m as Record<string, unknown>).is_zombie);
    const activeTotal = nonZombieOnly.filter((m) => isActiveMarket(m as Parameters<typeof isActiveMarket>[0])).length;

    // GH#1512: Apply search filter — case-insensitive substring match on symbol or name.
    // GH#1527: Also resolve the query against SLUG_ALIASES so searching "SOL" matches
    // markets whose DB symbol is a truncated address (e.g. "So111111") but whose
    // mint_address or mainnet_ca is the SOL mint. This bridges the gap between the
    // human-readable token names shown in the UI (via token-metadata enrichment) and
    // the raw DB values that the search runs against.
    // GH#1556: Accept both ?search= and ?q= — the UI and direct API consumers use both.
    // ?search= is the canonical param; ?q= is the legacy/shorthand alias. search= wins when both are present.
    const searchParam =
      request?.nextUrl?.searchParams?.get("search") ??
      request?.nextUrl?.searchParams?.get("q") ??
      null;
    const searchTrimmed = searchParam ? searchParam.trim() : null;
    const searchFiltered = searchTrimmed
      ? (() => {
          const q = searchTrimmed.toLowerCase();
          // Collect mint addresses whose well-known symbol matches the query
          // (e.g. q="sol" matches MINT_TO_KNOWN_SYMBOL entry "SOL" → So111...112)
          const matchingMints = new Set<string>();
          for (const [mint, knownSymbol] of MINT_TO_KNOWN_SYMBOL) {
            if (knownSymbol.toLowerCase().includes(q)) {
              matchingMints.add(mint);
            }
          }
          return nonZombie.filter((m) => {
            const sym = ((m as Record<string, unknown>).symbol as string | null) ?? "";
            const name = ((m as Record<string, unknown>).name as string | null) ?? "";
            // Direct DB field match (existing behaviour — handles WENDYS, etc.)
            if (sym.toLowerCase().includes(q) || name.toLowerCase().includes(q)) return true;
            // GH#1527: Known-symbol match via mint_address or mainnet_ca
            const mintAddress = ((m as Record<string, unknown>).mint_address as string | null) ?? "";
            const mainnetCa = ((m as Record<string, unknown>).mainnet_ca as string | null) ?? "";
            if (matchingMints.has(mintAddress) || matchingMints.has(mainnetCa)) return true;
            return false;
          });
        })()
      : nonZombie;

    // GH#1512: Apply oracle_mode filter.
    // GH#1526: Map frontend display values ("manual", "live_feed") to DB canonical
    // values ("admin", "hyperp") before filtering. Previously the filter did an exact
    // match, so passing "manual" or "live_feed" (the values the UI uses) always returned
    // 0 results because the DB stores "admin" and "hyperp" respectively.
    const oracleModeParam = request?.nextUrl?.searchParams?.get("oracle_mode") ?? null;
    const oracleModeFiltered = oracleModeParam
      ? (() => {
          const dbValue = ORACLE_MODE_FRONTEND_TO_DB[oracleModeParam] ?? oracleModeParam;
          return searchFiltered.filter(
            (m) => ((m as Record<string, unknown>).oracle_mode as string | null) === dbValue,
          );
        })()
      : searchFiltered;

    // GH#1512: Apply sort + order. Supported sort keys: symbol, last_price, volume_24h,
    // total_open_interest_usd, funding_rate. Default: no sort (DB order).
    const sortParam = request?.nextUrl?.searchParams?.get("sort") ?? null;
    const orderParam = (request?.nextUrl?.searchParams?.get("order") ?? "asc").toLowerCase();
    const sortDir = orderParam === "desc" ? -1 : 1;
    // GH#1524: Expanded sortable field set to include all fields callers actually use.
    // Previously only 5 fields were allowlisted; sort=total_open_interest, sort=mark_price,
    // and sort=created_at all silently fell through to the else branch (no sort applied),
    // causing asc == desc == no-sort for those fields.
    const SORTABLE_FIELDS = new Set([
      "symbol",
      "last_price",
      "mark_price",
      "index_price",
      "volume_24h",
      "volume_24h_usd",
      "total_open_interest",
      "total_open_interest_usd",
      "funding_rate",
      "created_at",
      "stats_updated_at",
      "trade_count_24h",
      "insurance_fund",
      "insurance_balance",
      "total_accounts",
    ]);
    // GH#1555: sort=recent is a named alias for created_at DESC (most recently created first).
    // PR #1550 fixed the frontend client-side sort but the API endpoint still silently ignored
    // the "recent" value (not in SORTABLE_FIELDS), returning unsorted DB order.
    // Map "recent" → created_at with forced DESC direction so API consumers and the
    // frontend server-side path both return newest-first.
    //
    // GH#1566: sort=oi and sort=volume are named aliases matching the frontend SortKey enum.
    // Previously these fell through to no-sort (not in SORTABLE_FIELDS), returning DB order.
    // - "oi"     → total_open_interest DESC (raw atom count; USD not reliable on devnet)
    // - "volume" → volume_24h DESC
    // - "health" → computed health level numeric sort via computeMarketHealthFromStats
    //              (healthy=0 < caution=1 < warning=2 < empty=3), ascending by default
    const NAMED_SORT_ALIASES: Record<string, { field: string; dir: number } | "health"> = {
      recent: { field: "created_at", dir: -1 },
      oi: { field: "total_open_interest", dir: -1 },
      volume: { field: "volume_24h", dir: -1 },
      health: "health",
    };
    const namedAlias = sortParam ? NAMED_SORT_ALIASES[sortParam] : undefined;
    const effectiveSortParam =
      namedAlias && namedAlias !== "health"
        ? namedAlias.field
        : sortParam === "recent" ? "created_at" : sortParam; // backward-compat fallback
    const effectiveSortDir =
      namedAlias && namedAlias !== "health"
        ? namedAlias.dir
        : sortParam === "recent" ? -1 : sortDir;

    // Health sort uses a computed level rank, not a raw field value.
    const HEALTH_ORDER: Record<string, number> = { healthy: 0, caution: 1, warning: 2, empty: 3 };
    const healthRank = (m: Record<string, unknown>): number => {
      const h = computeMarketHealthFromStats({
        total_open_interest: m.total_open_interest as number | null,
        open_interest_long: m.open_interest_long as number | null,
        open_interest_short: m.open_interest_short as number | null,
        insurance_balance: m.insurance_balance as number | null,
        insurance_fund: m.insurance_fund as number | null,
        c_tot: m.c_tot as number | null,
        vault_balance: m.vault_balance as number | null,
        total_accounts: m.total_accounts as number | null,
      });
      return HEALTH_ORDER[h.level] ?? 5;
    };

    const sorted =
      namedAlias === "health"
        ? [...oracleModeFiltered].sort((a, b) => {
            const ra = healthRank(a as Record<string, unknown>);
            const rb = healthRank(b as Record<string, unknown>);
            return sortDir * (ra - rb);
          })
        : effectiveSortParam && SORTABLE_FIELDS.has(effectiveSortParam)
          ? [...oracleModeFiltered].sort((a, b) => {
              const av = (a as Record<string, unknown>)[effectiveSortParam] ?? null;
              const bv = (b as Record<string, unknown>)[effectiveSortParam] ?? null;
              // Nulls last regardless of order direction.
              if (av === null && bv === null) return 0;
              if (av === null) return 1;
              if (bv === null) return -1;
              if (typeof av === "string" && typeof bv === "string") {
                return effectiveSortDir * av.localeCompare(bv);
              }
              return effectiveSortDir * ((av as number) - (bv as number));
            })
          : oracleModeFiltered;

    // GH#1348: Respect ?limit= query param to avoid returning 100+ markets
    // GH#1490: Validate limit (must be 1–500) and offset (must be >= 0) using
    // validateNumericParam() from route-validators.ts. Previously limit=-1/0/999999
    // all returned the full dataset and non-numeric offset was silently ignored.
    // Follow-up: use validated .value directly (not re-parsed) to reject "1.5"/"20abc".
    const MAX_LIMIT = 500;
    const limitParam = request?.nextUrl?.searchParams?.get("limit") ?? null;
    let limitNum = 0;
    if (limitParam !== null) {
      const limitValidation = validateNumericParam(limitParam, { min: 1, max: MAX_LIMIT });
      if (!limitValidation.valid) return limitValidation.response;
      limitNum = limitValidation.value;
    }

    const offsetParam = request?.nextUrl?.searchParams?.get("offset") ?? null;
    let offsetNum = 0;
    if (offsetParam !== null) {
      const offsetValidation = validateNumericParam(offsetParam, { min: 0 });
      if (!offsetValidation.valid) return offsetValidation.response;
      offsetNum = offsetValidation.value;
    }

    const paged = offsetNum > 0 ? sorted.slice(offsetNum) : sorted;
    const limited = limitNum > 0 ? paged.slice(0, limitNum) : paged;

    return NextResponse.json({ total: sorted.length, activeTotal, zombieCount, markets: limited }, {
      headers: {
        "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30",
      },
    });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { endpoint: "/api/markets", method: "GET" },
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// POST /api/markets — register a new market after deployment
// Auth: on-chain verification (deployer == slab admin) is the real gate.
// No API key required — the client calls this after successful on-chain deployment.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

  const {
    slab_address,
    mint_address,
    symbol,
    name,
    decimals,
    deployer,
    oracle_authority,
    initial_price_e6,
    max_leverage,
    trading_fee_bps,
    lp_collateral,
    matcher_context,
    logo_url,
    mainnet_ca,
    oracle_mode,
    dex_pool_address,
  } = body;

  if (!slab_address || !mint_address || !deployer) {
    return NextResponse.json(
      { error: "Missing required fields: slab_address, mint_address, deployer" },
      { status: 400 }
    );
  }

  // GH#1398: Reject markets with unreasonably high max_leverage.
  // 333x (and similar) garbage test markets have been observed on devnet.
  // Cap at 100x — any higher is almost certainly a misconfiguration or test artifact.
  // The on-chain program may allow higher values, but we reject at the API layer to
  // keep the market list clean and prevent user-facing extreme-leverage exposure.
  const MAX_ALLOWED_LEVERAGE = 100;
  if (max_leverage != null && max_leverage > MAX_ALLOWED_LEVERAGE) {
    return NextResponse.json(
      { error: `max_leverage exceeds allowed maximum of ${MAX_ALLOWED_LEVERAGE}x` },
      { status: 400 }
    );
  }

  // #813: Validate oracle_mode enum
  const VALID_ORACLE_MODES = ["pyth", "hyperp", "admin"] as const;
  type OracleMode = typeof VALID_ORACLE_MODES[number];
  const resolvedOracleMode: OracleMode = oracle_mode ?? "admin";
  if (!VALID_ORACLE_MODES.includes(resolvedOracleMode)) {
    return NextResponse.json(
      { error: `Invalid oracle_mode. Must be one of: ${VALID_ORACLE_MODES.join(", ")}` },
      { status: 400 }
    );
  }

  // #813: Validate dex_pool_address is a valid Solana pubkey (when provided)
  if (dex_pool_address) {
    try {
      new PublicKey(dex_pool_address);
    } catch {
      return NextResponse.json(
        { error: "Invalid dex_pool_address: must be a valid Solana public key" },
        { status: 400 }
      );
    }
  }

  // Verify slab account exists on-chain and is owned by our program
  try {
    const cfg = getConfig();
    const connection = new Connection(cfg.rpcUrl, "confirmed");
    const slabPubkey = new PublicKey(slab_address);
    const accountInfo = await connection.getAccountInfo(slabPubkey);
    if (!accountInfo) {
      return NextResponse.json({ error: "Slab account does not exist on-chain" }, { status: 400 });
    }
    const validPrograms = new Set<string>([cfg.programId]);
    const tiers = (cfg as Record<string, unknown>).programsBySlabTier as Record<string, string> | undefined;
    if (tiers) Object.values(tiers).forEach((id) => validPrograms.add(id));
    if (!validPrograms.has(accountInfo.owner.toBase58())) {
      return NextResponse.json({ error: "Slab account not owned by a known percolator program" }, { status: 400 });
    }

    // R2-S8: Verify deployer matches the on-chain admin
    try {
      const header = parseHeader(accountInfo.data);
      if (header.admin.toBase58() !== deployer) {
        return NextResponse.json(
          { error: "Deployer does not match slab admin" },
          { status: 403 },
        );
      }
    } catch {
      return NextResponse.json({ error: "Failed to parse slab header" }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: "Failed to verify slab on-chain" }, { status: 400 });
  }

  const supabase = getServiceClient();

  // Insert market
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: market, error: marketError } = await (supabase
    .from("markets") as any)
    .insert({
      slab_address,
      mint_address,
      symbol: symbol || mint_address.slice(0, 4).toUpperCase(),
      name: name || `Token ${mint_address.slice(0, 8)}`,
      decimals: decimals || 6,
      deployer,
      oracle_authority: oracle_authority || deployer,
      initial_price_e6,
      max_leverage: max_leverage || 10,
      trading_fee_bps: trading_fee_bps || 10,
      lp_collateral,
      matcher_context,
      logo_url: logo_url || null,
      mainnet_ca: mainnet_ca || null,
      oracle_mode: resolvedOracleMode,
      dex_pool_address: dex_pool_address || null,
    })
    .select()
    .single();

  if (marketError) {
    return NextResponse.json({ error: marketError.message }, { status: 500 });
  }

  // Create initial stats row
  await (supabase.from("market_stats") as any).insert({
    slab_address,
    last_price: initial_price_e6 ? initial_price_e6 / 1_000_000 : null,
  });

  // PERC-465: Hot-register with oracle keeper service (server-to-server, non-fatal)
  if (mainnet_ca && process.env.KEEPER_REGISTER_SECRET) {
    try {
      const keeperRegisterUrl = `${process.env.NEXT_PUBLIC_BASE_URL ?? ""}/api/oracle-keeper/register`;
      await fetch(keeperRegisterUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-keeper-secret": process.env.KEEPER_REGISTER_SECRET,
        },
        body: JSON.stringify({ slabAddress: slab_address, mainnetCA: mainnet_ca }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    } catch {
      // Non-fatal — oracle keeper will discover via Supabase polling
    }
  }

    return NextResponse.json({ market }, { status: 201 });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { endpoint: "/api/markets", method: "POST" },
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
