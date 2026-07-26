// PUBLIC endpoint — no auth required. Intentionally unauthenticated.
// IMPORTANT: Only add aggregate, non-user-specific fields here.
// Any user-specific or admin-sensitive data MUST go behind requireAuth().
// (Security issue #1031)

import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { parseEngine, isV17Account, discoverMarkets, parseMarketGroupV17OI } from "@percolatorct/sdk";
import { getServiceClient, getServerNetwork } from "@/lib/supabase";
import { isActiveMarket, isSaneMarketValue, isZombieMarket } from "@/lib/activeMarketFilter";
import { isPhantomOpenInterest } from "@/lib/phantom-oi";
import { BLOCKED_SLAB_ADDRESSES } from "@/lib/blocklist";
import { getClientIp } from "@/lib/get-client-ip";
import { createMemoryRateLimiter } from "@/lib/memory-rate-limit";
import { getConfig, getRpcEndpoint } from "@/lib/config";
import {
  hasIndexerDb,
  queryStatsAggregate,
  queryKnownSlabs,
} from "@/lib/indexer-db";
import { getMultipleAccountsInfoChunked } from "@/lib/rpc-chunk";
import type { Database } from "@/lib/database.types";
export const dynamic = "force-dynamic";

type MarketWithStats = Database['public']['Views']['markets_with_stats']['Row'];

// ---------------------------------------------------------------------------
// PERC-660: In-memory rate limiter — 60 req/min per IP (matches /api/trader pattern)
// Uses shared createMemoryRateLimiter from lib/memory-rate-limit.ts.
// Per-process only (multi-instance: effective limit = 60 × N). At mainnet
// scale, replace with Redis-backed rate limiting.
// ---------------------------------------------------------------------------
const rateLimiter = createMemoryRateLimiter({ limit: 60, windowMs: 60_000 });

// ---------------------------------------------------------------------------
// Playground self-contained stats path (no Supabase required)
// ---------------------------------------------------------------------------

const STATS_CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=15, stale-while-revalidate=45",
} as const;

/**
 * Empty / zero stats response shape — returned when no data source is available.
 * `live: false` (M13/H10) — this is the degraded fallback, not a real fetch;
 * ProtocolStatsBar gates its pulsing "live" indicator on this flag so a dead
 * Supabase/indexer doesn't render as a healthy, actively-updating protocol.
 */
function zeroStats() {
  return {
    totalMarkets: 0,
    activeTotal: 0,
    totalListedMarkets: 0,
    totalVolume24h: 0,
    totalOpenInterest: 0,
    totalTraders: 0,
    trades24h: 0,
    updatedAt: new Date().toISOString(),
    live: false,
  };
}

/**
 * M13/H10: on-chain-discovery stats path — devnet only, no DB dependency.
 *
 * Both the local indexer Postgres and Supabase have been dead in the
 * playground (D-OPS2), which made this endpoint return $0/$0/0 under a "live"
 * badge. This mirrors the v17 OI aggregation /api/markets already does:
 * discoverMarkets() finds every v17 market-group account for the configured
 * program, then a batched getMultipleAccountsInfo + parseMarketGroupV17OI
 * sums long+short OI (base-asset "Q" quantities, scale 1e6) and converts to
 * USD using each market's own live mark price (configV17.markEwmaE6) — no
 * external price feed needed.
 *
 * There is no on-chain source for trade history, so totalVolume24h/trades24h/
 * totalTraders stay 0 here — an honest empty state (PLAYGROUND.md already
 * documents candles/24h stats as optional/degraded), not a fabricated number.
 *
 * Returns null (not zeroStats()) on any failure or when discovery finds
 * nothing, so the caller falls through to the indexer/Supabase paths instead
 * of masking a real outage as "0 markets".
 */
/**
 * QA 2026-07-12: consistency-first stats path — aggregate over the SAME
 * market list `/api/markets` serves the rest of the site.
 *
 * The raw-discovery path below counts every v17 market-group account ever
 * deployed to the devnet program (161 at last audit — bug-hunt leftovers,
 * abandoned wizard launches, test junk), while `/api/markets` applies the
 * curation/active/zombie filtering and shows 6. The dashboard's
 * ProtocolStatsBar rendered THIS endpoint's numbers ("161 markets / $237K
 * OI") next to pages showing 6 markets / ~$35K — on a "don't trust, verify"
 * product that discrepancy reads as fabrication. Self-fetching the sibling
 * route makes the two definitionally consistent, whatever its filtering
 * evolves into. Falls through to the discovery path when unavailable.
 */
async function computeStatsFromMarketsApi(request: NextRequest): Promise<(ReturnType<typeof zeroStats>) | null> {
  try {
    const base = new URL(request.url).origin;
    const res = await fetch(`${base}/api/markets?limit=500`, { next: { revalidate: 30 } });
    if (!res.ok) return null;
    const data = await res.json();
    const markets: Array<Record<string, unknown>> = Array.isArray(data?.markets) ? data.markets : [];
    if (markets.length === 0) return null;

    let totalOpenInterest = 0;
    for (const m of markets) {
      const oiUsd = m.total_open_interest_usd;
      if (typeof oiUsd === "number" && isSaneMarketValue(oiUsd)) totalOpenInterest += oiUsd;
    }
    const totalMarkets = typeof data.total === "number" ? data.total : markets.length;
    const activeTotal = typeof data.activeTotal === "number" ? data.activeTotal : markets.length;

    return {
      totalMarkets,
      activeTotal,
      totalListedMarkets: totalMarkets,
      // No on-chain source for trade history — honest zeros, same as the
      // discovery path below.
      totalVolume24h: 0,
      totalOpenInterest,
      totalTraders: 0,
      trades24h: 0,
      updatedAt: new Date().toISOString(),
      live: true,
    };
  } catch (err) {
    console.warn("[/api/stats] markets-api consistency path failed:", err);
    return null;
  }
}

async function computeStatsFromOnChainDiscovery(): Promise<(ReturnType<typeof zeroStats>) | null> {
  const cfg = getConfig();
  if (cfg.network !== "devnet") return null;

  try {
    const connection = new Connection(getRpcEndpoint(), "confirmed");
    const programId = new PublicKey(cfg.programId);
    const found = await discoverMarkets(connection, programId, {
      sequential: true,
      maxTierQueries: 0, // v17-only — mirrors /api/markets discoverMarketsOnChain()
    });
    if (found.length === 0) return null;

    const seen = new Set<string>();
    const unique = found.filter((m) => {
      const key = m.slabAddress.toBase58();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const v17Markets = unique.filter((m) => m.configV17);
    if (v17Markets.length === 0) return null;

    let totalOpenInterest = 0;
    const CHUNK = 100; // getMultipleAccountsInfo cap
    for (let start = 0; start < v17Markets.length; start += CHUNK) {
      const chunk = v17Markets.slice(start, start + CHUNK);
      const infos = await connection.getMultipleAccountsInfo(chunk.map((m) => m.slabAddress));
      infos.forEach((info, i) => {
        if (!info?.data) return;
        const bytes = new Uint8Array(info.data);
        if (!isV17Account(bytes)) return;
        try {
          const oi = parseMarketGroupV17OI(bytes);
          const markPriceRaw = chunk[i].configV17?.markEwmaE6 ?? 0n;
          const markPriceUsd = markPriceRaw > 0n ? Number(markPriceRaw) / 1_000_000 : 0;
          // No valid mark price → USD value of this market's OI is indeterminate;
          // skip rather than fabricate (mirrors /api/markets' no-$1-fallback rule).
          if (markPriceUsd <= 0) return;
          const totalOiQ = Number(oi.totalLongOiQ + oi.totalShortOiQ);
          totalOpenInterest += (totalOiQ / 1_000_000) * markPriceUsd;
        } catch {
          // Unparseable slab — contributes 0 to the total, not a crash
        }
      });
    }

    return {
      totalMarkets: unique.length,
      activeTotal: unique.length,
      totalListedMarkets: unique.length,
      totalVolume24h: 0,
      totalOpenInterest,
      totalTraders: 0,
      trades24h: 0,
      updatedAt: new Date().toISOString(),
      live: true,
    };
  } catch (err) {
    console.warn("[/api/stats] on-chain discovery path failed:", err);
    return null;
  }
}

/**
 * Compute protocol stats from the local indexer Postgres + on-chain engine state.
 *
 * Data sources:
 *  - Market count, trader count, 24h trade count, 24h raw volume
 *    → queryStatsAggregate() (single SQL query on the indexer trades table)
 *  - Total open interest (USD) → batch getMultipleAccountsInfo for known slabs,
 *    parseEngine() per slab, sum (longOi + shortOi).
 *    Assumes 6-decimal USDC collateral for USD conversion (devnet playground invariant).
 *  - Volume 24h (USD) → queryStatsAggregate() already returns real USD dollars
 *    (size × price, summed server-side — see StatsAggregate.volume24hRaw's doc
 *    comment); no further collateral-decimals division here.
 *
 * All sub-steps degrade gracefully: a failed RPC/DB call yields zeros for that
 * sub-component rather than propagating an error.
 */
async function computeStatsFromIndexer(): Promise<ReturnType<typeof zeroStats>> {
  const [agg, knownSlabs] = await Promise.all([
    queryStatsAggregate(),
    queryKnownSlabs(),
  ]);

  // On-chain OI — batch RPC fetch for all known slabs
  const COLLATERAL_DECIMALS = 6; // Sim-USDC (6-decimal) for devnet playground
  const COLLATERAL_FACTOR = 10 ** COLLATERAL_DECIMALS;
  let totalOpenInterest = 0;

  if (knownSlabs.length > 0) {
    try {
      const connection = new Connection(getRpcEndpoint(), "confirmed");
      const pubkeys = knownSlabs.map((s) => new PublicKey(s));
      // I: queryKnownSlabs() caps at exactly 100 today (LIMIT 100), which sits
      // right at the getMultipleAccountsInfo ceiling — chunked defensively so
      // this doesn't silently break the moment that SQL cap is ever raised.
      const accountInfos = await getMultipleAccountsInfoChunked(connection, pubkeys, "confirmed");
      for (const info of accountInfos) {
        if (!info) continue;
        try {
          const bytes = new Uint8Array(info.data);
          // v17 accounts (PERCV16\0 magic) don't embed a v12-style engine block;
          // their aggregate OI is not yet parsed server-side.  Skip them.
          if (isV17Account(bytes)) continue;
          const engine = parseEngine(bytes);
          const rawOi = engine.longOi + engine.shortOi;
          // Guard against overflow when converting bigint to Number
          const rawOiNum = rawOi > BigInt(Number.MAX_SAFE_INTEGER)
            ? Number.MAX_SAFE_INTEGER
            : Number(rawOi);
          totalOpenInterest += rawOiNum / COLLATERAL_FACTOR;
        } catch {
          // Skip unparseable accounts (wrong magic / unknown layout)
        }
      }
    } catch (err) {
      console.warn("[/api/stats] on-chain OI fetch failed (continuing with 0):", err);
    }
  }

  // B: agg.volume24hRaw is already real USD dollars (queryStatsAggregate now
  // multiplies by each trade's own price server-side, mirroring
  // queryLeaderboard) — no collateral-decimals division here. The previous
  // `/ COLLATERAL_FACTOR` treated a heterogeneous sum of raw base-asset
  // quantities as if it were a collateral-atom count, which was wrong on
  // both counts (wrong unit AND wrong divisor).
  const totalVolume24h =
    agg.volume24hRaw > BigInt(Number.MAX_SAFE_INTEGER)
      ? Number.MAX_SAFE_INTEGER
      : Number(agg.volume24hRaw);

  return {
    totalMarkets: agg.marketCount,
    activeTotal: agg.marketCount,
    totalListedMarkets: agg.marketCount,
    totalVolume24h,
    totalOpenInterest,
    totalTraders: agg.uniqueTraders,
    trades24h: agg.trades24h,
    updatedAt: new Date().toISOString(),
    live: true,
  };
}

/**
 * GET /api/stats — Platform-wide aggregated statistics
 *
 * Read path (in priority order):
 *  1. M13/H10: on-chain discovery — devnet only, no DB dependency. Tried first
 *     because both the local indexer Postgres and Supabase are dead in the
 *     playground right now (D-OPS2); this is the one path guaranteed to
 *     reflect real on-chain market count + OI regardless of DB config drift.
 *  2. Direct indexer Postgres + on-chain engine state when INDEXER_DATABASE_URL is set
 *     (playground self-contained mode — no Supabase/Railway required).
 *  3. Supabase (production path — existing implementation).
 *  4. Zero-stats graceful degrade — returned when no data source is available,
 *     so the endpoint never returns 500 due to missing env vars.
 *
 * Every branch sets `live` — true for a genuine successful fetch, false for
 * the zero-stats degrade — so consumers (ProtocolStatsBar) can gate a "live"
 * indicator on real data instead of always showing green.
 *
 * Uses isActiveMarket() from shared activeMarketFilter for consistent
 * market counts across homepage, /api/stats, and markets page.
 *
 * Rate limited: 60 req/min per IP (PERC-660, security issue #1031).
 */
export async function GET(request: NextRequest) {
  const ip = getClientIp(request);
  if (rateLimiter.isLimited(ip)) {
    return NextResponse.json(
      { error: "Rate limited. Max 60 requests per minute." },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  // ── PRIMARY PATH: aggregate the same curated list /api/markets serves ────
  const marketsApiStats = await computeStatsFromMarketsApi(request);
  if (marketsApiStats) {
    return NextResponse.json(marketsApiStats, { headers: STATS_CACHE_HEADERS });
  }

  // ── SECONDARY PATH: raw on-chain discovery (devnet, no DB dependency) ────
  const onChainStats = await computeStatsFromOnChainDiscovery();
  if (onChainStats) {
    return NextResponse.json(onChainStats, { headers: STATS_CACHE_HEADERS });
  }

  // ── SECONDARY PATH: indexer Postgres + chain (playground self-contained) ─
  if (hasIndexerDb()) {
    try {
      return NextResponse.json(await computeStatsFromIndexer(), {
        headers: STATS_CACHE_HEADERS,
      });
    } catch (err) {
      console.error("[/api/stats] indexer DB path failed, falling through to Supabase:", err);
    }
  }

  // ── TERTIARY PATH: Supabase (production) ─────────────────────────────────
  // Guard: if Supabase isn't configured, return zeros instead of crashing with
  // "Supabase env vars not set" (the failure mode the playground self-containment
  // task was opened to fix).
  const supabaseConfigured =
    !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!supabaseConfigured) {
    console.warn("[/api/stats] No data source configured — returning zero stats.");
    return NextResponse.json(zeroStats(), { headers: STATS_CACHE_HEADERS });
  }

  const supabase = getServiceClient();

  const [statsRes, tradersRes] = await Promise.all([
    // GH#1218: include slab_address so we can filter blocked markets (same as /api/markets)
    // GH#1265: also fetch trade_count_24h so we can sum it directly (replaces buggy trades table count query)
    // GH#1297: include vault_balance + total_accounts to apply phantom OI guard (consistent with /api/markets)
    // GH#1419: include stats_updated_at to filter stale volume_24h (markets not updated in >48h)
    // PERC-8195: filter by network so devnet/mainnet rows don't mix
    // GH#1874: Graceful fallback — if network column is missing (PERC-8215 migration
    // not yet applied), retry without the filter to keep stats endpoint alive.
    // GH#2072: Use .or() instead of .neq("indexer_excluded", true) because PostgREST's
    // neq filter excludes NULL rows (SQL: NULL <> true → NULL → excluded). Most markets
    // have indexer_excluded=NULL so .neq(true) returned 0 rows, zeroing all stats.
    // REDUCED SCHEMA (2026-07): open_interest_long/short, total_open_interest,
    // vault_balance, c_tot, total_accounts, and stats_updated_at were all dropped
    // from market_stats — no longer selected. Downstream this route already
    // treats every one of these as optional via `Number(...) || 0`/`?? null`
    // fallbacks (this is the rarely-hit tertiary Supabase path; the primary
    // path aggregates /api/markets instead), so removing them degrades those
    // fields to 0/null without further logic changes.
    supabase.from("markets_with_stats").select("slab_address, volume_24h, trade_count_24h, last_price, decimals").eq("network", getServerNetwork()).or("indexer_excluded.is.null,indexer_excluded.neq.true").limit(500),
    supabase.from("trades").select("trader").eq("network", getServerNetwork()).limit(5000),
  ]);

  // GH#2067: Cascading fallback — mirrors /api/markets 3-tier approach.
  // Tier 1: Full query (network + indexer_excluded) — already attempted above.
  // Tier 2: Drop indexer_excluded if that column is missing (migration 046 / 20260402170000).
  // Tier 3: Drop network filter too if that column is missing (migration 20260329180000).
  // Without this, a missing indexer_excluded column causes statsRes.error but the old
  // code only checked for "network" in the error message, leaving statsData_raw as null
  // and returning all zeros for every stat field.
  let statsData_raw = statsRes.data;
  let tradersData_raw = tradersRes.data;

  // GH#2070: Include network in SELECT so Tier 3 (unfiltered) fallback can still
  // filter client-side if the column exists but .eq() failed for another reason.
  // REDUCED SCHEMA (2026-07): mirrors the trim applied to the primary query above —
  // open_interest_long/short, total_open_interest, vault_balance, c_tot,
  // total_accounts, and stats_updated_at no longer exist on market_stats.
  const STATS_SELECT = "slab_address, volume_24h, trade_count_24h, last_price, decimals, network";

  if (statsRes.error) {
    const errMsg = statsRes.error.message ?? "";

    if (errMsg.includes("indexer_excluded")) {
      // Tier 2: indexer_excluded column missing — retry with network filter only
      console.warn(
        "[/api/stats] PERC-8387: indexer_excluded column missing on markets_with_stats — " +
        "falling back without indexer_excluded filter. Apply migration 046 / 20260402170000 to fix."
      );
      const fallback = await supabase.from("markets_with_stats")
        .select(STATS_SELECT)
        .eq("network", getServerNetwork())
        .limit(500);

      if (fallback.error && fallback.error.message?.includes("network")) {
        // Tier 3: network column also missing — fully unfiltered.
        // WARNING: Without network column, we cannot distinguish devnet from mainnet.
        // Return empty stats with a degraded flag rather than silently mixing networks.
        console.error(
          "[/api/stats] CRITICAL: both indexer_excluded and network columns missing — " +
          "cannot serve accurate stats. Apply migrations 20260329180000 and 20260402170000."
        );
        statsData_raw = [] as typeof statsData_raw;
      } else {
        statsData_raw = fallback.data as typeof statsData_raw;
      }
    } else if (errMsg.includes("network")) {
      // Tier 2 (alt): network column missing — retry without network but keep indexer_excluded
      console.warn(
        "[/api/stats] PERC-8215: network column missing on markets_with_stats — " +
        "falling back without network filter. Apply 20260329180000_add_network_column.sql to fix."
      );
      const fallback = await supabase.from("markets_with_stats")
        .select(STATS_SELECT)
        .or("indexer_excluded.is.null,indexer_excluded.neq.true")
        .limit(500);

      if (fallback.error && fallback.error.message?.includes("indexer_excluded")) {
        // Both columns missing — fully unfiltered
        console.warn(
          "[/api/stats] Both network and indexer_excluded columns missing — fully unfiltered fallback."
        );
        const STATS_SELECT_NO_NET = STATS_SELECT.replace(", network", "");
        const fallback2 = await supabase.from("markets_with_stats")
          .select(STATS_SELECT_NO_NET)
          .limit(500);
        statsData_raw = fallback2.data as typeof statsData_raw;
      } else {
        statsData_raw = fallback.data as typeof statsData_raw;
      }
    } else {
      // Unknown error — log but don't crash
      console.error("[/api/stats] Unexpected error querying markets_with_stats:", statsRes.error);
    }
  }

  if (tradersRes.error && tradersRes.error.message?.includes("network")) {
    console.warn(
      "[/api/stats] PERC-8215: network column missing on trades — falling back to unfiltered query."
    );
    const fallback = await supabase.from("trades").select("trader").limit(5000);
    tradersData_raw = fallback.data;
  }

  // GH#2070: Client-side network filter — safeguard for Tier 2/3 fallback paths where
  // the DB-level .eq("network", ...) filter was not applied. If the returned rows have
  // a `network` field, filter to only the current network. This prevents devnet/mainnet
  // data mixing when the column exists but the DB filter was skipped.
  const expectedNetwork = getServerNetwork();
  const networkFiltered = (statsData_raw ?? []).filter((m) => {
    const row = m as Record<string, unknown>;
    // If network field is present in the row, enforce it matches
    if ("network" in row && row.network != null) {
      return row.network === expectedNetwork;
    }
    // If network field is absent (column truly doesn't exist), keep the row
    return true;
  });

  // GH#1218: filter blocked slabs before aggregating — mirrors /api/markets behaviour.
  // Previously this endpoint had no blocklist filter, allowing corrupt markets (e.g. NL
  // with 9e12 raw OI → $89.2M false open interest) to pollute global stats.
  // GH#1539: Use unified BLOCKED_SLAB_ADDRESSES (includes env var overrides).
  const statsData = networkFiltered.filter(
    (m) => !BLOCKED_SLAB_ADDRESSES.has((m as Record<string, unknown>).slab_address as string ?? ""),
  );

  // GH#1337: Suppress phantom OI before counting active markets.
  // Previously isActiveMarket() was applied to raw data where phantom markets
  // (vault < 1M or accounts == 0) still had stale non-zero OI, causing them to
  // count as "active" here but not in /api/markets (which zeros OI post-sanitization).
  // This produced a 172 vs 135 mismatch. Now we zero phantom OI first, so both
  // endpoints agree on what counts as "active".
  // GH#1430: Match /api/markets sanitizePrice cap — null out last_price > $1M before
  // isActiveMarket() so markets with corrupt oracle prices (e.g. $7.9T) don't count
  // as "active" in stats while being nulled in /api/markets. Previously this cap was
  // only applied during USD conversion (toUsd), not before the isActiveMarket check,
  // causing 65 corrupt-price markets to be counted in totalMarkets but not activeTotal.
  const MAX_SANE_PRICE_FOR_ACTIVE = 1_000_000; // $1M — mirrors /api/markets sanitizePrice
  const phantomAwareData = statsData.map((m) => {
    const accountsCount = (m as Record<string, unknown>).total_accounts as number ?? 0;
    const vaultBal = (m as Record<string, unknown>).vault_balance as number ?? 0;
    // GH#1435/GH#1438: Use shared isPhantomOpenInterest() from lib/phantom-oi.ts (strict <).
    // Previously this route had its own copy of the predicate (MIN_VAULT_FOR_ACTIVE).
    // Now both /api/markets and /api/stats derive the phantom determination from the same
    // function, eliminating the drift that caused GH#1432, GH#1435, and GH#1438.
    const isPhantom = isPhantomOpenInterest(accountsCount, vaultBal);
    if (!isPhantom) {
      // GH#1430: Null out corrupt prices before isActiveMarket() check so the active-market
      // count matches /api/markets which applies sanitizePrice (> $1M → null) before filtering.
      const rawPrice = (m as Record<string, unknown>).last_price as number | null;
      const sanitizedPrice = (rawPrice != null && rawPrice > 0 && rawPrice <= MAX_SANE_PRICE_FOR_ACTIVE)
        ? rawPrice
        : null;
      if (sanitizedPrice !== rawPrice) {
        return { ...m, last_price: sanitizedPrice };
      }
      return m;
    }
    // GH#1425: Zero out ALL stat fields (including last_price and volume_24h) so
    // isActiveMarket() won't consider stale values as "active" for zombie markets.
    // Previously only OI fields were zeroed; vault_balance=0 zombies still passed
    // isActiveMarket() via stale last_price, overcounting totalMarkets by ~40.
    // Mirrors the homepage fix from GH#1412.
    return {
      ...m,
      last_price: 0,
      volume_24h: 0,
      trade_count_24h: 0,
      total_open_interest: 0,
      open_interest_long: 0,
      open_interest_short: 0,
    };
  });
  const activeData = phantomAwareData.filter(isActiveMarket);
  // GH#1563: totalMarkets (activeData.length = 69) was the activeMarkets field removed from
  // the response. activeData is still used for volume/OI/trades aggregations — keep it.

  // Convert raw on-chain token micro-units to USD using decimals + price
  // Without this, sentinel-like values (2e12) leak through as $2T (#1154)
  const MAX_PER_MARKET_USD = 10_000_000_000; // $10B cap — no single market should exceed this
  // GH#1191: corrupt devnet last_price values (e.g. $7.9T/token) multiply small but
  // legitimate token amounts into billions. Cap price at $1M/token — matches /api/markets
  // sanitizePrice cap. Previous $10K cap was too tight: admin-set prices (e.g. MOLTBOT
  // $210K devnet price) are valid and must not be rejected. $1M is the display-layer guard;
  // Rust MAX_ORACLE_PRICE enforces $1B on-chain. GH#1321.
  const MAX_SANE_PRICE_USD = 1_000_000; // $1M — matches /api/markets sanitizePrice cap
  const toUsd = (raw: number, m: { decimals?: number | null; last_price?: number | null }): number => {
    if (!isSaneMarketValue(raw)) return 0;
    const d = Math.min(Math.max((m as Record<string, unknown>).decimals as number ?? 6, 0), 18);
    const p = (m.last_price != null && m.last_price > 0 && m.last_price <= MAX_SANE_PRICE_USD) ? m.last_price : 0;
    if (p <= 0) return 0;
    const usd = (raw / 10 ** d) * p;
    return usd > MAX_PER_MARKET_USD ? 0 : usd;
  };

  // GH#1419: Prefer fresh volume_24h (updated within 48h) but fall back to all
  // active markets if every single one is stale. This prevents the stats endpoint
  // from returning 0 for totalVolume24h when the StatsCollector hasn't run recently
  // (GH#2083). When at least one market has fresh data, stale markets are excluded
  // to avoid inflating totals. When ALL data is stale, showing the best-available
  // (slightly outdated) numbers is better than showing zeros.
  const STALE_VOLUME_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48 hours
  const now = Date.now();
  const isStaleMarket = (m: Record<string, unknown>): boolean => {
    const updatedAt = m.stats_updated_at as string | null;
    if (!updatedAt) return false; // no timestamp → treat as fresh (backward compat)
    return (now - new Date(updatedAt).getTime()) > STALE_VOLUME_THRESHOLD_MS;
  };
  const hasFreshData = activeData.some((m) => !isStaleMarket(m as Record<string, unknown>));
  const totalVolume24h = activeData.reduce(
    (sum, m) => {
      // GH#2083: Only skip stale markets if at least one market has fresh data.
      // If ALL markets are stale, include them all to avoid returning 0.
      if (hasFreshData && isStaleMarket(m as Record<string, unknown>)) return sum;
      return sum + toUsd(m.volume_24h ?? 0, m);
    },
    0
  );
  // GH#1297: Phantom OI guard — mirrors /api/markets isPhantomOI logic.
  // Markets with accounts_count=0 or vault<1M are stale/orphaned; their raw OI atoms
  // are not backed by real positions. Without this filter, the $1 fallback (GH#1265)
  // inflated /api/stats totalOpenInterest to $117K vs /api/markets sum of $64K.
  const totalOpenInterest = activeData.reduce(
    (sum, m) => {
      // GH#1297: Skip phantom markets (no accounts or dust/empty vault) — same guard as /api/markets.
      // GH#1438: Now uses shared isPhantomOpenInterest() from lib/phantom-oi.ts (MIN_VAULT_FOR_OI = 1_000_000, strict <).
      const accountsCount = (m as Record<string, unknown>).total_accounts as number ?? 0;
      const vaultBal = (m as Record<string, unknown>).vault_balance as number ?? 0;
      // REDUCED SCHEMA (2026-07): open_interest_long/short and total_open_interest
      // were dropped from market_stats — this tertiary Supabase-only fallback path
      // (the primary /api/markets-aggregation path above and the on-chain-discovery
      // path both compute real OI directly and are always tried first) has no OI
      // source left. rawOi is always 0 here, so this reduce contributes nothing —
      // an honest degrade rather than a stale/fabricated number.
      const rawOi = 0;
      if (!isSaneMarketValue(rawOi)) return sum;
      if (isPhantomOpenInterest(accountsCount, vaultBal)) return sum;
      // GH#1318: No $1 fallback — markets without a valid oracle price have indeterminate
      // USD OI and must NOT contribute to totalOpenInterest.
      // Previously (GH#1265) a $1/token fallback was used for admin-mode devnet markets
      // not yet cranked. This caused 33 vault=1M creation-deposit markets with stale
      // non-zero OI and no oracle price to each contribute ~$2K phantom OI (~$47K total).
      // Those markets are not being actively cranked (StatsCollector no longer processes
      // them), so their raw OI is stale and their USD value is indeterminate.
      // usdEkK5G and MOLTBOT (vault=1M, real positions, valid prices) are unaffected —
      // they have valid last_price values and continue to contribute correctly.
      // GH#1321: MAX_SANE_PRICE_USD raised from $10K → $1M (matches /api/markets).
      // MOLTBOT last_price ~$210K was rejected by the old $10K cap, causing its OI to
      // be silently dropped (p=0 branch). $1M is the correct display-layer guard.
      const d = Math.min(Math.max((m as Record<string, unknown>).decimals as number ?? 6, 0), 18);
      const p = (m.last_price != null && m.last_price > 0 && m.last_price <= MAX_SANE_PRICE_USD)
        ? m.last_price
        : 0;
      if (p <= 0) return sum; // no valid price → unknown USD value → skip
      const usd = (rawOi / 10 ** d) * p;
      return sum + (usd > MAX_PER_MARKET_USD ? 0 : usd);
    },
    0
  );
  const uniqueTraders = new Set(
    (tradersData_raw ?? []).map((r) => r.trader)
  ).size;
  // GH#1265: trades table count query (head:true) returns 0 — likely a column name mismatch
  // or supabase HEAD count limitation. Use trade_count_24h from markets_with_stats instead,
  // which is the same source used by /api/markets and is reliable.
  // GH#1419: Also skip stale markets (>48h) for trade_count_24h to match volume filter.
  // GH#2083: Same hasFreshData fallback as volume — show stale trade counts rather than 0.
  const trades24h = activeData.reduce((sum, m) => {
    if (hasFreshData && isStaleMarket(m as Record<string, unknown>)) return sum;
    return sum + (m.trade_count_24h ?? 0);
  }, 0);

  // GH#1465: Align totalListedMarkets with /api/markets total by excluding zombie markets.
  // /api/markets excludes zombies (vault=0 or null+no-stats) from its `total` field.
  // Previously statsData.length included zombies, causing totalListedMarkets (195) to
  // diverge from /api/markets total (122) by exactly zombieCount (73).
  // Uses shared isZombieMarket() helper (GH#1420 + GH#1427 predicate, CodeRabbit #1466).
  //
  // GH#1518: Use price-cap-only data for the zombie filter — NOT phantomAwareData.
  // PR#1516 switched from statsData → phantomAwareData, but phantomAwareData zeroes ALL
  // stat fields (price, volume, OI) for phantom markets. isZombieMarket() then sees no
  // activity for 9 markets that /api/markets considers non-zombie (because they have
  // c_tot > 0 AND real activity in their raw data). /api/markets only applies a $1M
  // price cap (via sanitizePrice) before isZombieMarket(), not a full phantom zero-out.
  // Fix: mirror /api/markets exactly — apply only the $1M price cap and numeric coercion
  // before isZombieMarket(), preserving volume/OI/accounts for the activity check.
  const numericOrNull = (v: unknown): number | null => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const nonZombieListedMarkets = statsData.filter((m) => {
    const raw = m as Record<string, unknown>;
    const rawPrice = numericOrNull(raw.last_price);
    const sanitizedPrice = (rawPrice != null && rawPrice > 0 && rawPrice <= MAX_SANE_PRICE_FOR_ACTIVE)
      ? rawPrice
      : null;
    return !isZombieMarket({
      vault_balance: numericOrNull(raw.vault_balance),
      c_tot: numericOrNull(raw.c_tot),
      last_price: sanitizedPrice,
      volume_24h: numericOrNull(raw.volume_24h),
      total_open_interest: numericOrNull(raw.total_open_interest),
      total_accounts: numericOrNull(raw.total_accounts),
    });
  });
  const nonZombieCount = statsData.length - nonZombieListedMarkets.length;

  // GH#1535: Expose activeTotal matching /api/markets activeTotal exactly.
  // GH#1538: Must apply phantom OI zeroing before isActiveMarket(), otherwise phantom
  // markets with stale volume_24h/total_open_interest pass the sane-value check and
  // get over-counted (151 vs 115). /api/markets applies phantom zeroing in its sanitized
  // pipeline before isActiveMarket(); we must mirror that here.
  const activeTotal = nonZombieListedMarkets.filter((m) => {
    const raw = m as Record<string, unknown>;
    const accountsCount = Number(raw.total_accounts) || 0;
    const vaultBal = Number(raw.vault_balance) || 0;
    const isPhantom = isPhantomOpenInterest(accountsCount, vaultBal);
    // Build a view with phantom fields zeroed, mirroring /api/markets sanitization
    const checked = {
      last_price: (() => {
        const p = numericOrNull(raw.last_price);
        return (p != null && p > 0 && p <= MAX_SANE_PRICE_FOR_ACTIVE) ? p : null;
      })(),
      volume_24h: isPhantom ? 0 : numericOrNull(raw.volume_24h),
      total_open_interest: isPhantom ? 0 : numericOrNull(raw.total_open_interest),
      open_interest_long: isPhantom ? 0 : numericOrNull(raw.open_interest_long),
      open_interest_short: isPhantom ? 0 : numericOrNull(raw.open_interest_short),
    };
    return isActiveMarket(checked as Parameters<typeof isActiveMarket>[0]);
  }).length;

  return NextResponse.json({
    // GH#1529: totalMarkets is now aligned with /api/markets total (non-zombie, non-blocked).
    // Previously totalMarkets=69 was the active-market subset (at least one sane stat),
    // which diverged from totalListedMarkets=168 without any documented distinction.
    // totalListedMarkets (deprecated alias) is kept for backward compat.
    // GH#1535: activeTotal matches /api/markets activeTotal (zombie-excluded + isActiveMarket).
    // GH#1563: Removed activeMarkets (was 69 — the all-market active subset from phantomAwareData).
    // It diverged from activeTotal (115 = zombie-excluded isActiveMarket) with no clear definition,
    // causing API consumer confusion. activeTotal is the canonical "active" count going forward.
    totalMarkets: nonZombieListedMarkets.length,
    activeTotal,
    // #1172: totalListedMarkets includes all non-blocked, non-zombie markets.
    // GH#1465: Previously this was statsData.length (included zombies), diverging
    // from /api/markets total. Now aligned by applying the same zombie filter.
    // GH#1529: Deprecated — use totalMarkets (now identical). Kept for compatibility.
    totalListedMarkets: nonZombieListedMarkets.length,
    totalVolume24h,
    totalOpenInterest,
    totalTraders: uniqueTraders,
    trades24h,
    updatedAt: new Date().toISOString(),
    live: true,
  }, {
    headers: {
      "Cache-Control": "public, s-maxage=15, stale-while-revalidate=45",
    },
  });
}
