import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { validateNumericParam } from "@/lib/route-validators";
import { parseHeader, parseConfig } from "@percolatorct/sdk";
import { getServiceClient, getServerNetwork } from "@/lib/supabase";
import { getConfig } from "@/lib/config";
import { getClientIp } from "@/lib/get-client-ip";
import * as Sentry from "@sentry/nextjs";
import nacl from "tweetnacl";
import { isSaneMarketValue, isActiveMarket, isZombieMarket } from "@/lib/activeMarketFilter";
import { isPhantomOpenInterest, MIN_VAULT_FOR_OI } from "@/lib/phantom-oi";
import { computeDisplayOiUsd } from "@/lib/oi-display";
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

const MAINNET_MARKET_DIRECTORY_FALLBACK: Record<string, unknown>[] = [
  {
    slab_address: "AiVcTXxKfKmcpUBG3unxCdEHHtXvAq8zYpbtS6oPrV6J",
    mint_address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    symbol: "SOL-PERP",
    name: "SOL/USD Perpetual",
    decimals: 6,
    deployer: "7JVQvrAfzj3aasLxCkoLYX5KQcrb5nEZhUe5Qa8PvV5G",
    logo_url: null,
    max_leverage: 10,
    trading_fee_bps: 10,
    last_price: null,
    mark_price: null,
    index_price: null,
    volume_24h: 0,
    trade_count_24h: 0,
    open_interest_long: 0,
    open_interest_short: 0,
    total_open_interest: 0,
    total_open_interest_usd: 0,
    insurance_fund: 20_000_001,
    insurance_balance: 20_000_001,
    total_accounts: 0,
    funding_rate: null,
    net_lp_pos: 0,
    lp_sum_abs: 0,
    c_tot: 0,
    volume_24h_usd: 0,
    vault_balance: 70_000_000,
    created_at: "2026-05-04T00:32:02.380Z",
    stats_updated_at: null,
    oracle_mode: "admin",
    dex_pool_address: "3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv",
    mainnet_ca: "So11111111111111111111111111111111111111112",
    oracle_authority: "7JVQvrAfzj3aasLxCkoLYX5KQcrb5nEZhUe5Qa8PvV5G",
    is_zombie: false,
  },
];

const DEVNET_MARKET_DIRECTORY_FALLBACK: Record<string, unknown>[] = [
  {
    slab_address: "FCusfsg4uzcLSdRbj9Ez5okcrS1MwvKHvDbmcwrnSWvL",
    mint_address: null,
    symbol: "DEVNET-SMALL-1",
    name: "Devnet Small Market",
    decimals: 6,
    deployer: null,
    oracle_authority: null,
    oracle_mode: null,
    created_at: null,
    is_zombie: false,
  },
  {
    slab_address: "4r4bxZ2LxNCu4EWdkXThoVaBHBsYQcWkizdkmWciprJC",
    mint_address: null,
    symbol: "DEVNET-SMALL-2",
    name: "Devnet Small Market",
    decimals: 6,
    deployer: null,
    oracle_authority: null,
    oracle_mode: null,
    created_at: null,
    is_zombie: false,
  },
  {
    slab_address: "7G3SsnevWwUWjWAwGGmr2N11x8KAGn1abzjV3bBbZkAM",
    mint_address: null,
    symbol: "DEVNET-SMALL-3",
    name: "Devnet Small Market",
    decimals: 6,
    deployer: null,
    oracle_authority: null,
    oracle_mode: null,
    created_at: null,
    is_zombie: false,
  },
  {
    slab_address: "GfRak5ben9rvZiaEWW6FmmkeqjXFz9SBLhDwiPWhoapS",
    mint_address: null,
    symbol: "DEVNET-MEDIUM-1",
    name: "Devnet Medium Market",
    decimals: 6,
    deployer: null,
    oracle_authority: null,
    oracle_mode: null,
    created_at: null,
    is_zombie: false,
  },
  {
    slab_address: "2t389M7NwJ1FbwKuv1yf8TSGk84FR1itGgxMBkjh5fDs",
    mint_address: null,
    symbol: "DEVNET-MEDIUM-2",
    name: "Devnet Medium Market",
    decimals: 6,
    deployer: null,
    oracle_authority: null,
    oracle_mode: null,
    created_at: null,
    is_zombie: false,
  },
  {
    slab_address: "A3XJVaQxKsM4bbikoSTvKczQLVQQ19GbrxY9S9ShK119",
    mint_address: null,
    symbol: "DEVNET-MEDIUM-3",
    name: "Devnet Medium Market",
    decimals: 6,
    deployer: null,
    oracle_authority: null,
    oracle_mode: null,
    created_at: null,
    is_zombie: false,
  },
  {
    slab_address: "HrdveBrbepjvwAn2qmCPU9eRSFG6Munpkw7gXCHvLpBN",
    mint_address: null,
    symbol: "DEVNET-LARGE-1",
    name: "Devnet Large Market",
    decimals: 6,
    deployer: null,
    oracle_authority: null,
    oracle_mode: null,
    created_at: null,
    is_zombie: false,
  },
  {
    slab_address: "JBS3qeCoiAvyPRm4DsUfunA7YcL6UnRmbk6TyRBHTz2X",
    mint_address: null,
    symbol: "DEVNET-LARGE-2",
    name: "Devnet Large Market",
    decimals: 6,
    deployer: null,
    oracle_authority: null,
    oracle_mode: null,
    created_at: null,
    is_zombie: false,
  },
  {
    slab_address: "5JUTyfARLVAWTMPxPnGq5jyYq7aNuq5c1M2tvDqaFQJL",
    mint_address: null,
    symbol: "DEVNET-LARGE-3",
    name: "Devnet Large Market",
    decimals: 6,
    deployer: null,
    oracle_authority: null,
    oracle_mode: null,
    created_at: null,
    is_zombie: false,
  },
];

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

function fallbackMarketsResponse(request: NextRequest, reason: string): NextResponse {
  const network = getConfig().network;
  const rows = network === "mainnet"
    ? MAINNET_MARKET_DIRECTORY_FALLBACK
    : DEVNET_MARKET_DIRECTORY_FALLBACK;
  const searchParam =
    request?.nextUrl?.searchParams?.get("search") ??
    request?.nextUrl?.searchParams?.get("q") ??
    null;
  const searchTrimmed = searchParam?.trim().toLowerCase() ?? null;
  const oracleModeParam = request?.nextUrl?.searchParams?.get("oracle_mode") ?? null;
  const dbOracleMode = oracleModeParam ? ORACLE_MODE_FRONTEND_TO_DB[oracleModeParam] ?? oracleModeParam : null;

  const filtered = rows
    .filter((m) => !BLOCKED_SLAB_ADDRESSES.has(m.slab_address as string))
    .filter((m) => {
      if (!searchTrimmed) return true;
      const symbol = String(m.symbol ?? "").toLowerCase();
      const name = String(m.name ?? "").toLowerCase();
      const slab = String(m.slab_address ?? "").toLowerCase();
      const mint = String(m.mint_address ?? "").toLowerCase();
      return symbol.includes(searchTrimmed) ||
        name.includes(searchTrimmed) ||
        slab.includes(searchTrimmed) ||
        mint.includes(searchTrimmed);
    })
    .filter((m) => !dbOracleMode || m.oracle_mode === dbOracleMode);

  const activeTotal = filtered.filter((m) => isActiveMarket(m as Parameters<typeof isActiveMarket>[0])).length;
  const marketsWithPrice = filtered.filter((m) => isSaneMarketValue(numericOrNull(m.last_price))).length;

  const MAX_LIMIT = 500;
  const MIN_LIMIT = 1;
  const DEFAULT_LIMIT = MAX_LIMIT;
  const limitParam = request?.nextUrl?.searchParams?.get("limit") ?? null;
  let limitNum = 0;
  if (limitParam !== null) {
    const parsed = parseInt(limitParam, 10);
    limitNum = Number.isNaN(parsed)
      ? DEFAULT_LIMIT
      : Math.min(Math.max(parsed, MIN_LIMIT), MAX_LIMIT);
  }

  const offsetParam = request?.nextUrl?.searchParams?.get("offset") ?? null;
  let offsetNum = 0;
  if (offsetParam !== null) {
    const offsetValidation = validateNumericParam(offsetParam, { min: 0 });
    if (!offsetValidation.valid) return offsetValidation.response;
    offsetNum = offsetValidation.value;
  }

  const paged = offsetNum > 0 ? filtered.slice(offsetNum) : filtered;
  const limited = limitNum > 0 ? paged.slice(0, limitNum) : paged;

  Sentry.captureMessage(`PERC-8450: /api/markets using static directory fallback (${reason})`, {
    level: "warning",
    tags: { endpoint: "/api/markets", method: "GET", degraded: "true", network },
    fingerprint: ["perc-8450-markets-static-directory-fallback"],
  });

  return NextResponse.json(
    { total: filtered.length, activeTotal, marketsWithPrice, zombieCount: 0, markets: limited },
    {
      headers: {
        "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30",
        "X-Percolator-Data-Source": "static-directory-fallback",
      },
    },
  );
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
  // GH#1618: round to 2dp to eliminate IEEE-754 float artifacts (e.g. 4620.241999999999)
  return usd > MAX_PER_MARKET_USD ? null : Math.round(usd * 100) / 100;
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
    // GH#1781: Exclude zombie markets with null slab_address at the DB layer.
    // These are incomplete DB rows (TEST x2, BREW, LOBSTAR) with no on-chain account —
    // they have slab=null, mainnet_ca=null, vault_balance=null and cannot be indexed.
    // Filtering at the query level prevents them polluting the response even if
    // the JS-layer zombie/blocklist guards don't catch them (Set.has(null) → false).
    // PERC-8195: filter by network so devnet and mainnet rows don't mix.
    // PERC-8215: Graceful fallback — if the network column is missing (migration not yet
    // applied to this Supabase instance), retry without the filter to restore service.
    // The column absence causes a hard 500; we detect it by error message and degrade
    // gracefully rather than keeping the endpoint broken for all users.
    const SELECT_FIELDS =
      "slab_address,mint_address,symbol,name,decimals,deployer,logo_url,max_leverage,trading_fee_bps," +
      "last_price,mark_price,index_price,volume_24h,trade_count_24h,open_interest_long,open_interest_short,total_open_interest," +
      "insurance_fund,insurance_balance,total_accounts,funding_rate,net_lp_pos,lp_sum_abs,c_tot," +
      "vault_balance,created_at,stats_updated_at,oracle_mode,dex_pool_address,mainnet_ca,oracle_authority";

    // PERC-8387: Progressive fallback for missing DB columns/migrations.
    // Production Supabase may not have all migrations applied. Rather than crashing
    // with a 500, we try progressively simpler queries:
    //   1. Full query (network + indexer_excluded filters)
    //   2. Drop indexer_excluded filter (migration 046 not applied)
    //   3. Drop network filter too (migration 20260329180000 not applied)
    // The view-level WHERE clause (migration 20260402170000) already filters
    // indexer_excluded markets when applied, so the PostgREST filter is defense-in-depth.
    let { data, error } = await supabase
      .from("markets_with_stats")
      .select(SELECT_FIELDS)
      .eq("network", getServerNetwork())
      .not("slab_address", "is", null)
      // GH#2072: .neq("indexer_excluded", true) excludes NULL rows (SQL: NULL <> true → NULL → excluded).
      // Since most markets have indexer_excluded=NULL, use .or() to include both NULL and non-true values.
      .or("indexer_excluded.is.null,indexer_excluded.neq.true");

    // Fallback 1: indexer_excluded column missing (migration 046 / 20260402170000 not applied).
    // PostgREST error: "Could not find the 'indexer_excluded' column of 'markets_with_stats'"
    if (error && error.message?.includes("indexer_excluded")) {
      Sentry.captureMessage(
        "PERC-8387: indexer_excluded column missing — apply migration 046 + 20260402170000. " +
        "Falling back without indexer_excluded filter.",
        {
          level: "warning",
          tags: { endpoint: "/api/markets", method: "GET", degraded: "true" },
          fingerprint: ["perc-8387-indexer-excluded-missing"],
        }
      );
      const fb1 = await supabase
        .from("markets_with_stats")
        .select(SELECT_FIELDS)
        .eq("network", getServerNetwork())
        .not("slab_address", "is", null);
      data = fb1.data;
      error = fb1.error;
    }

    // Fallback 2: network column also missing (migration 20260329180000 not applied)
    if (error && error.message?.includes("network")) {
      Sentry.captureMessage(
        "PERC-8215: network column missing — apply migration 20260329180000. " +
        "Falling back to unfiltered query.",
        {
          level: "warning",
          tags: { endpoint: "/api/markets", method: "GET", degraded: "true" },
          fingerprint: ["perc-8215-network-column-missing"],
        }
      );
      const fb2 = await supabase
        .from("markets_with_stats")
        .select(SELECT_FIELDS)
        .not("slab_address", "is", null);
      data = fb2.data;
      error = fb2.error;
    }

    // Fallback 3: catch-all for any other column-related errors.
    // If we still have an error that mentions "column" or "does not exist",
    // try the absolute minimum query to restore service.
    if (error && (error.message?.includes("column") || error.message?.includes("does not exist"))) {
      Sentry.captureMessage(
        `PERC-8387: Unexpected column error in markets query, using bare fallback. Error: ${error.message}`,
        {
          level: "error",
          tags: { endpoint: "/api/markets", method: "GET", degraded: "true" },
          fingerprint: ["perc-8387-bare-fallback"],
        }
      );
      const fb3 = await supabase
        .from("markets_with_stats")
        .select(SELECT_FIELDS);
      data = fb3.data;
      error = fb3.error;
    }

    if (error) {
      Sentry.captureException(error, {
        tags: { endpoint: "/api/markets", method: "GET" },
      });
      return fallbackMarketsResponse(request, "supabase-query-error");
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
            // GH#1594: combined === 0 is valid (zero OI), same as primary path's n_total_open_interest === 0 guard
            return combined === 0 || isSaneMarketValue(combined) ? combined : null;
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
      // GH#1599: When OI is genuinely 0, display 0 regardless of phantom status.
      // The phantom guard only suppresses *positive* OI values that are stale/orphaned
      // (no vault backing). Zero OI is always valid — it means "no positions".
      // GH#1610: pass rawOiAtoms so the helper can return 0 (not null) when atoms > 0
      // but oracle price is unavailable (admin-oracle markets where keeper never cranked).
      const displayOiUsd = computeDisplayOiUsd(total_open_interest_usd, isPhantomOI, rawOi);

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
    // GH#1760: Expose markets_with_price for transparency — subset of activeTotal with a sane last_price.
    // activeTotal = has any sane stat (price OR volume OR OI); markets_with_price = only those with price.
    // This disambiguates why activeTotal (e.g. 71) > markets_with_price (e.g. 56):
    // the 15-market gap are markets with volume/OI data but no current oracle price.
    const marketsWithPrice = nonZombieOnly.filter((m) => isSaneMarketValue((m as Record<string, unknown>).last_price as number | null)).length;

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
    // - "oi"     → total_open_interest_usd DESC NULLS LAST (USD-denominated; nulls always last)
    //              GH#1582: Was previously total_open_interest (raw atoms), causing no-price
    //              markets with large atom counts (e.g. 2.66T atoms, null USD) to rank above
    //              priced markets like usdEkK5G ($59,994 OI) and MOLTBOT ($4,620 OI).
    //              The null-last logic in the sort comparator already handles NULLS LAST.
    // - "volume" → volume_24h DESC
    // - "health" → computed health level numeric sort via computeMarketHealthFromStats
    //              (healthy=0 < caution=1 < warning=2 < empty=3), ascending by default
    const NAMED_SORT_ALIASES: Record<string, { field: string; dir: number } | "health"> = {
      recent: { field: "created_at", dir: -1 },
      oi: { field: "total_open_interest_usd", dir: -1 },
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
    // GH#1637: oracle-down markets (has capital but no price) rank below Caution/Warning
    // but above Empty. Sort order: healthy=0 < caution=1 < warning=2 < oracle-down=3 < empty=4.
    const HEALTH_ORDER: Record<string, number> = { healthy: 0, caution: 1, warning: 2, "oracle-down": 3, empty: 4 };
    const healthRank = (m: Record<string, unknown>): number => {
      // GH#1608: Markets with vault_balance < MIN_VAULT_FOR_OI have no LP liquidity.
      // computeMarketHealthFromStats may return "healthy" for these because phantom OI
      // is suppressed to 0 while c_tot > 0 remains — oi=0 + capital > 0 → "healthy".
      // This caused vault=0 markets (with legacy c_tot from FF7K keeper pattern) to rank
      // as best health (0) and appear first in sort=health results.
      // Fix: treat no-vault markets as rank 4 (empty) directly, before health computation.
      const vaultNum = numericOrNull(m.vault_balance);
      if (vaultNum !== null && vaultNum < MIN_VAULT_FOR_OI) {
        return HEALTH_ORDER["empty"]; // 4 — no vault = no real LP market
      }
      // GH#1637: Detect oracle-down markets (has capital/vault but no price data).
      // mark_price and index_price both null/zero → oracle is down.
      // These markets have c_tot>0 and vault>0, so computeMarketHealthFromStats returns
      // "healthy" (capital > OI with no price → ratio = Infinity). We must check for
      // missing price BEFORE calling computeMarketHealthFromStats.
      const mp = numericOrNull(m.mark_price);
      const ip = numericOrNull(m.index_price);
      const isOracleDown = (mp == null || mp <= 0) && (ip == null || ip <= 0);
      if (isOracleDown && vaultNum != null && vaultNum >= MIN_VAULT_FOR_OI) {
        return HEALTH_ORDER["oracle-down"]; // 3 — has capital but no price
      }
      const h = computeMarketHealthFromStats({
        total_open_interest: m.total_open_interest as number | null,
        open_interest_long: m.open_interest_long as number | null,
        open_interest_short: m.open_interest_short as number | null,
        insurance_balance: m.insurance_balance as number | null,
        insurance_fund: m.insurance_fund as number | null,
        c_tot: m.c_tot as number | null,
        vault_balance: vaultNum,
        total_accounts: m.total_accounts as number | null,
      });
      return HEALTH_ORDER[h.level] ?? 5;
    };

    const sorted =
      namedAlias === "health"
        ? [...oracleModeFiltered].sort((a, b) => {
            const ra = healthRank(a as Record<string, unknown>);
            const rb = healthRank(b as Record<string, unknown>);
            if (ra !== rb) return sortDir * (ra - rb);
            // GH#1612: Tiebreaker within same health rank — vault>0 before vault=0.
            // Markets with vault_balance=1000000 but c_tot=0 both score rank 3 (empty)
            // alongside vault=0 markets, causing interleaving. Break ties by vault presence.
            const va = numericOrNull((a as Record<string, unknown>).vault_balance) ?? 0;
            const vb = numericOrNull((b as Record<string, unknown>).vault_balance) ?? 0;
            // vault>0 sorts first (ascending): compare so that higher vault comes first
            if (va > 0 && vb === 0) return -1;
            if (va === 0 && vb > 0) return 1;
            return 0;
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
    // GH#1737: Clamp limit to MAX_LIMIT instead of rejecting — limit=510 was returning
    // a 400 error which the frontend silently swallowed, showing 0 markets. Any value
    // > MAX_LIMIT is treated as MAX_LIMIT (500).
    // GH#1753: Soft-default non-numeric/NaN strings to MAX_LIMIT instead of returning 400.
    // parseInt("abc") and parseInt("NaN") both return NaN — previously this caused the
    // validator to return 400, which some callers (mobile, SDK clients) swallowed silently,
    // receiving null total/activeTotal. Now: ?limit=abc and ?limit=NaN default to MAX_LIMIT.
    const MAX_LIMIT = 500;
    const MIN_LIMIT = 1;
    const DEFAULT_LIMIT = MAX_LIMIT; // returned when limit is absent or non-numeric
    const limitParam = request?.nextUrl?.searchParams?.get("limit") ?? null;
    let limitNum = 0;
    if (limitParam !== null) {
      // GH#1753: Use parseInt with NaN fallback to DEFAULT_LIMIT.
      // parseInt handles: "abc" → NaN, "NaN" → NaN, "0" → 0, "510" → 510.
      // Then clamp to [MIN_LIMIT, MAX_LIMIT] — limit=0 → 1, limit>500 → 500.
      const parsed = parseInt(limitParam, 10);
      limitNum = Number.isNaN(parsed)
        ? DEFAULT_LIMIT
        : Math.min(Math.max(parsed, MIN_LIMIT), MAX_LIMIT);
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

    return NextResponse.json({ total: sorted.length, activeTotal, marketsWithPrice, zombieCount, markets: limited }, {
      headers: {
        "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30",
      },
    });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { endpoint: "/api/markets", method: "GET" },
    });
    return fallbackMarketsResponse(request, "unhandled-get-error");
  }
}

// POST /api/markets — register a new market after deployment
// Auth: PERC-8332 — nonce+ed25519 wallet-signature proof required (cryptographic ownership).
//   Step 1: GET /api/markets/challenge?deployer=<pubkey>  → { nonce, expiresAt }
//   Step 2: Sign nonce bytes (UTF-8) with deployer keypair → base64 signature
//   Step 3: POST /api/markets with { ...fields, nonce, signature }
// On-chain slab admin check is kept as a secondary control.
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
    // PERC-8332: nonce+signature for deployer wallet-sig auth
    nonce,
    signature,
  } = body;

  if (!slab_address || !mint_address || !deployer) {
    return NextResponse.json(
      { error: "Missing required fields: slab_address, mint_address, deployer" },
      { status: 400 }
    );
  }

  // PERC-8332: Require nonce+signature for deployer wallet-sig authentication.
  // This proves cryptographic ownership of the deployer key instead of trusting
  // the deployer string from the body (which attackers can set to any observed pubkey).
  //
  // Bypass: internal tooling can skip sig checks only when BOTH are set:
  // - MARKETS_AUTH_BYPASS_ENABLED=true
  // - MARKETS_AUTH_BYPASS_SECRET matches x-markets-bypass header
  // This extra opt-in flag prevents accidental bypass activation from a leftover secret.
  // MUST NEVER be enabled in production.
  const bypassEnabled = process.env.MARKETS_AUTH_BYPASS_ENABLED === "true";
  const bypassSecret = process.env.MARKETS_AUTH_BYPASS_SECRET;
  const bypassHeader = req.headers.get("x-markets-bypass");
  // Security: bypass is only permitted in non-production environments.
  // If the env var is accidentally set in production, reject the bypass attempt
  // and fire a Sentry alert — the auth check still runs.
  const isProd = process.env.NODE_ENV === "production";
  if (isProd && bypassSecret) {
    Sentry.captureMessage(
      "PERC-8332: MARKETS_AUTH_BYPASS_SECRET is set in production — bypass ignored",
      {
        level: "error",
        tags: { endpoint: "/api/markets", method: "POST", auth: "bypass-prod-leak" },
        fingerprint: ["perc-8332-bypass-prod-leak"],
      }
    );
  }
  const isBypass = !isProd && bypassEnabled && bypassSecret && bypassHeader === bypassSecret;

  if (!isBypass) {
    if (!nonce || !signature) {
      return NextResponse.json(
        {
          error:
            "Missing required fields: nonce, signature. " +
            "Call GET /api/markets/challenge?deployer=<pubkey> first, then sign the returned nonce.",
        },
        { status: 400 }
      );
    }

    // Validate deployer pubkey format before DB lookup
    let deployerPubkeyBytes: Uint8Array;
    try {
      deployerPubkeyBytes = new PublicKey(deployer).toBytes();
    } catch {
      return NextResponse.json(
        { error: "Invalid deployer: must be a valid Solana public key" },
        { status: 400 }
      );
    }

    // Decode the base64 signature
    let signatureBytes: Uint8Array;
    try {
      signatureBytes = Buffer.from(signature, "base64");
      if (signatureBytes.length !== 64) {
        throw new Error("Signature must be 64 bytes");
      }
    } catch {
      return NextResponse.json(
        { error: "Invalid signature: must be a base64-encoded 64-byte ed25519 signature" },
        { status: 400 }
      );
    }

    // GH#2018: Verify ed25519 signature BEFORE claiming nonce.
    // Previously, nonce was consumed first, then signature checked — allowing an attacker
    // to burn a victim's nonces by submitting invalid signatures. Now we verify the
    // cryptographic proof first (cheap, no DB write) so invalid signatures never touch nonces.
    const nonceBytes = new Uint8Array(Buffer.from(nonce, "utf-8"));
    const sigBytes = new Uint8Array(signatureBytes);
    let sigValid = false;
    try {
      sigValid = nacl.sign.detached.verify(nonceBytes, sigBytes, deployerPubkeyBytes);
    } catch {
      // nacl throws on invalid input lengths — treat as signature failure
      sigValid = false;
    }

    if (!sigValid) {
      Sentry.captureMessage(
        "PERC-8332: Deployer signature verification failed (pre-claim)",
        {
          level: "warning",
          tags: { endpoint: "/api/markets", method: "POST", auth: "sig-fail" },
          fingerprint: ["perc-8332-sig-fail"],
          extra: { deployer, nonce },
        }
      );
      return NextResponse.json(
        { error: "Signature verification failed. Ensure you signed the nonce bytes with the deployer keypair." },
        { status: 401 }
      );
    }

    // Atomically claim the nonce: single UPDATE filtered on all validity conditions.
    // This eliminates the TOCTOU race window — if two concurrent requests arrive with
    // the same nonce, only one UPDATE can match (used_at IS NULL), the other gets count=0.
    // GH#2018: Safe to claim now — signature already verified above.
    const supabaseAuth = getServiceClient();
    const now = new Date();
    const clientIp = getClientIp(req);

    const { count: consumed, error: claimErr } = await (supabaseAuth as ReturnType<typeof getServiceClient>)
      .from("market_challenges" as never)
      .update({ used_at: now.toISOString() } as never, { count: "exact" } as never)
      .eq("nonce", nonce)
      .eq("deployer", deployer)
      .eq("client_ip", clientIp)
      .is("used_at", null)
      .gt("expires_at", now.toISOString())
      .select("nonce" as never) as { count: number | null; error: unknown };

    if (claimErr || (consumed ?? 0) === 0) {
      // Nonce is unknown, already used, or expired — single unified error to avoid oracle enumeration
      return NextResponse.json(
        { error: "Invalid, expired, or already-used nonce. Call GET /api/markets/challenge to get a fresh nonce." },
        { status: 401 }
      );
    }
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

  // GH#1963: Validate oracle_authority is a valid Solana pubkey (when provided).
  // Previously inserted raw from request body without parsing — could accept garbage strings.
  if (oracle_authority) {
    try {
      new PublicKey(oracle_authority);
    } catch {
      return NextResponse.json(
        { error: "Invalid oracle_authority: must be a valid Solana public key" },
        { status: 400 }
      );
    }
  }

  // GH#1963: Validate mainnet_ca is a valid Solana pubkey (when provided).
  // Previously inserted raw — could accept arbitrary strings that poison downstream UI/parsers.
  if (mainnet_ca) {
    try {
      new PublicKey(mainnet_ca);
    } catch {
      return NextResponse.json(
        { error: "Invalid mainnet_ca: must be a valid Solana public key" },
        { status: 400 }
      );
    }
  }

  // GH#1963: Validate symbol — alphanumeric + dash/dot/underscore, 1–20 chars.
  // Prevents deceptive or garbage metadata from entering the registry.
  const SYMBOL_RE = /^[A-Za-z0-9._\-]{1,20}$/;
  const resolvedSymbol: string = symbol || mint_address.slice(0, 4).toUpperCase();
  if (!SYMBOL_RE.test(resolvedSymbol)) {
    return NextResponse.json(
      { error: "Invalid symbol: must be 1–20 chars, alphanumeric/dash/dot/underscore only" },
      { status: 400 }
    );
  }

  // GH#1963: Validate name — printable ASCII, 1–64 chars.
  const resolvedName: string = name || `Token ${mint_address.slice(0, 8)}`;
  if (typeof resolvedName !== "string" || resolvedName.trim().length === 0 || resolvedName.length > 64) {
    return NextResponse.json(
      { error: "Invalid name: must be 1–64 characters" },
      { status: 400 }
    );
  }
  // Reject control characters and non-printable chars.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(resolvedName)) {
    return NextResponse.json(
      { error: "Invalid name: must not contain control characters" },
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

    // GH#1987: Cross-check mint_address against on-chain slab config.collateralMint.
    // Previously only the slab owner/admin was verified — a caller could pass any
    // mint_address string and it would be inserted into the DB, causing metadata
    // divergence from the on-chain collateral reality.
    try {
      const config = parseConfig(accountInfo.data);
      const onChainMint = config.collateralMint.toBase58();
      if (onChainMint !== mint_address) {
        return NextResponse.json(
          {
            error: `mint_address does not match on-chain collateral mint. ` +
              `On-chain: ${onChainMint}. Provided: ${mint_address}`,
          },
          { status: 400 },
        );
      }

      // Cross-check oracle_authority against on-chain slab config.
      // Without this, a deployer could register a false oracle_authority in the DB,
      // misleading off-chain tooling (admin dashboards, keeper configs) that reads
      // markets.oracle_authority instead of querying the chain directly.
      const onChainOracleAuth = config.oracleAuthority.toBase58();
      const resolvedOracleAuth = oracle_authority || deployer;
      const SYSTEM_PROGRAM = "11111111111111111111111111111111";
      // Only enforce when on-chain authority is set (non-zero / non-system-program)
      if (onChainOracleAuth !== SYSTEM_PROGRAM && onChainOracleAuth !== resolvedOracleAuth) {
        return NextResponse.json(
          {
            error: `oracle_authority does not match on-chain oracle authority. ` +
              `On-chain: ${onChainOracleAuth}. Provided: ${resolvedOracleAuth}`,
          },
          { status: 400 },
        );
      }
    } catch {
      // CR fix (GH#1987): parseConfig failure must fail closed — an unparseable slab
      // cannot be verified, so reject registration rather than silently falling through.
      // This prevents an attacker from registering with a spoofed mint by triggering a
      // parse error on the slab config.
      Sentry.captureMessage(
        "GH#1987: Failed to parse slab config for mint cross-check — rejecting registration",
        {
          level: "error",
          tags: { endpoint: "/api/markets", method: "POST", check: "mint-crosscheck" },
          extra: { slab_address, mint_address },
          fingerprint: ["gh1987-mint-crosscheck-parse-fail"],
        }
      );
      return NextResponse.json(
        { error: "Unable to verify mint_address against on-chain slab config — registration rejected." },
        { status: 400 },
      );
    }
  } catch (err) {
    return NextResponse.json({ error: "Failed to verify slab on-chain" }, { status: 400 });
  }

  const supabase = getServiceClient();

  // PERC-8195: tag every insert with the active network
  const insertNetwork = getServerNetwork();

  // Prevent metadata tampering-by-replay: once a slab is registered on this
  // network, reject further POST attempts instead of relying only on DB constraints.
  const { data: existingMarket, error: existingMarketError } = await supabase
    .from("markets")
    .select("id")
    .eq("slab_address", slab_address)
    .eq("network", insertNetwork)
    .maybeSingle();

  if (existingMarketError) {
    return NextResponse.json({ error: "Failed to validate existing market state" }, { status: 500 });
  }

  if (existingMarket) {
    return NextResponse.json(
      {
        error:
          "Market already registered for this slab on the active network. " +
          "Existing metadata is immutable via this endpoint.",
      },
      { status: 409 },
    );
  }

  // Insert market

  const { data: market, error: marketError } = await supabase.from("markets").insert({
      slab_address,
      mint_address,
      // GH#1963: use pre-validated resolvedSymbol/resolvedName (not raw body fields)
      symbol: resolvedSymbol,
      name: resolvedName,
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
      network: insertNetwork,
    })
    .select()
    .single();

  if (marketError) {
    return NextResponse.json({ error: marketError.message }, { status: 500 });
  }

  // Create initial stats row — tag with same network
  await supabase.from("market_stats").insert({
    slab_address,
    last_price: initial_price_e6 ? initial_price_e6 / 1_000_000 : null,
    network: insertNetwork,
  });

  // PERC-465: Hot-register with oracle keeper service (server-to-server, non-fatal)
  if (mainnet_ca && process.env.KEEPER_REGISTER_SECRET) {
    try {
      const keeperRegisterUrl = `${process.env.NEXT_PUBLIC_BASE_URL ?? ""}/api/oracle-keeper/register`;
      const res = await fetch(keeperRegisterUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-keeper-secret": process.env.KEEPER_REGISTER_SECRET,
        },
        body: JSON.stringify({ slabAddress: slab_address, mainnetCA: mainnet_ca }),
        signal: AbortSignal.timeout(5000),
      }).catch((e: unknown) => {
        console.warn("[api/markets POST] keeper hot-register fetch failed", e);
        return null;
      });
      if (res && !res.ok) {
        console.warn(
          "[api/markets POST] keeper hot-register non-OK",
          res.status,
          await res.text().catch(() => ""),
        );
      }
    } catch (e) {
      console.warn("[api/markets POST] keeper hot-register failed", e);
      // Non-fatal — oracle keeper will discover via Supabase polling
    }
  }

  // GH#1769: Ensure devnet_mints has a row for this market's devnet mint address.
  // The devnet-airdrop endpoint looks up devnet_mints.devnet_mint = mintAddress to
  // find the mainnet_ca for price lookup. If the wizard's devnet-mirror-mint step
  // ran, this row already exists and the upsert is a no-op. If the market was created
  // via the mobile API or a direct /api/markets POST (without going through the wizard),
  // this ensures the airdrop endpoint can still resolve the token metadata.
  // Only write if we have a valid mint_address and mainnet_ca (to avoid polluting the
  // table with self-referencing devnet-native entries that have no real mainnet CA).
  if (mint_address && mainnet_ca && mainnet_ca !== mint_address) {
    try {
      await (supabase.from("devnet_mints")).upsert(
        {
          mainnet_ca,
          devnet_mint: mint_address,
          // GH#1963: use pre-validated resolvedSymbol/resolvedName
          symbol: resolvedSymbol,
          name: resolvedName,
          decimals: decimals || 6,
          creator_wallet: deployer,
        },
        { onConflict: "mainnet_ca", ignoreDuplicates: true },
      );
    } catch (e) {
      console.warn("[api/markets POST] devnet_mints upsert failed", e);
      // Non-fatal — devnet-airdrop has fallback via markets table
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
