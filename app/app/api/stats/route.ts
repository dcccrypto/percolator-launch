// PUBLIC endpoint — no auth required. Intentionally unauthenticated.
// IMPORTANT: Only add aggregate, non-user-specific fields here.
// Any user-specific or admin-sensitive data MUST go behind requireAuth().
// (Security issue #1031)

import { NextRequest, NextResponse } from "next/server";
import { getServiceClient, getServerNetwork } from "@/lib/supabase";
import { isActiveMarket, isSaneMarketValue, isZombieMarket } from "@/lib/activeMarketFilter";
import { isPhantomOpenInterest } from "@/lib/phantom-oi";
import { BLOCKED_SLAB_ADDRESSES } from "@/lib/blocklist";
import type { Database } from "@/lib/database.types";
export const dynamic = "force-dynamic";

type MarketWithStats = Database['public']['Views']['markets_with_stats']['Row'];

// ---------------------------------------------------------------------------
// PERC-660: In-memory rate limiter — 60 req/min per IP (matches /api/trader pattern)
// Note: per-process only (multi-instance: effective limit = 60 × N). At mainnet
// scale, replace with Redis-backed rate limiting. On Vercel (serverless) functions
// are short-lived so memory growth is bounded.
// ---------------------------------------------------------------------------
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;
const rateMap = new Map<string, { count: number; resetAt: number }>();

/** Prune expired entries to prevent unbounded memory growth on long-running instances. */
function pruneExpired(): void {
  const now = Date.now();
  for (const [ip, entry] of rateMap.entries()) {
    if (now > entry.resetAt) rateMap.delete(ip);
  }
}

function isRateLimited(ip: string): boolean {
  pruneExpired();
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  if (entry.count >= RATE_LIMIT) return true;
  entry.count++;
  return false;
}

/**
 * GET /api/stats — Platform-wide aggregated statistics
 *
 * Uses isActiveMarket() from shared activeMarketFilter for consistent
 * market counts across homepage, /api/stats, and markets page.
 *
 * Rate limited: 60 req/min per IP (PERC-660, security issue #1031).
 */
export async function GET(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? request.headers.get("x-real-ip")
    ?? "unknown";
  if (isRateLimited(ip)) {
    return NextResponse.json(
      { error: "Rate limited. Max 60 requests per minute." },
      { status: 429, headers: { "Retry-After": "60" } },
    );
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
    supabase.from("markets_with_stats").select("slab_address, volume_24h, trade_count_24h, open_interest_long, open_interest_short, total_open_interest, last_price, decimals, vault_balance, c_tot, total_accounts, stats_updated_at").eq("network", getServerNetwork()).neq("indexer_excluded", true).limit(500),
    supabase.from("trades").select("trader").eq("network", getServerNetwork()).limit(5000),
  ]);

  // GH#1874: Network column fallback — if the migration hasn't been applied yet,
  // the .eq("network", ...) filter causes Supabase to return an error (column not found).
  // Retry without the filter so the endpoint returns data rather than all zeros.
  // GH#1874: Network column fallback — if the migration hasn't been applied yet,
  // the .eq("network", ...) filter causes Supabase to return an error (column not found).
  // Retry without the filter so the endpoint returns data rather than all zeros.
  let statsData_raw = statsRes.data;
  let tradersData_raw = tradersRes.data;

  if (statsRes.error && statsRes.error.message?.includes("network")) {
    console.warn(
      "[/api/stats] PERC-8215: network column missing on markets_with_stats — falling back to unfiltered query. " +
      "Apply 20260329180000_add_network_column.sql to fix."
    );
    const fallback = await supabase.from("markets_with_stats").select("slab_address, volume_24h, trade_count_24h, open_interest_long, open_interest_short, total_open_interest, last_price, decimals, vault_balance, c_tot, total_accounts, stats_updated_at").neq("indexer_excluded", true).limit(500);
    statsData_raw = fallback.data;
  }
  if (tradersRes.error && tradersRes.error.message?.includes("network")) {
    console.warn(
      "[/api/stats] PERC-8215: network column missing on trades — falling back to unfiltered query."
    );
    const fallback = await supabase.from("trades").select("trader").limit(5000);
    tradersData_raw = fallback.data;
  }

  // GH#1218: filter blocked slabs before aggregating — mirrors /api/markets behaviour.
  // Previously this endpoint had no blocklist filter, allowing corrupt markets (e.g. NL
  // with 9e12 raw OI → $89.2M false open interest) to pollute global stats.
  // GH#1539: Use unified BLOCKED_SLAB_ADDRESSES (includes env var overrides).
  const statsData = (statsData_raw ?? []).filter(
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

  // GH#1419: Only include volume_24h from markets whose stats were updated within 48h.
  // A market with stats_updated_at > 48h ago has stale rolling stats — its volume_24h
  // no longer reflects actual 24h activity and will inflate the platform total.
  // 48h is intentionally generous: the StatsCollector runs every few minutes, so a
  // >48h gap means the market's indexer stopped (vault drained, market closed, etc).
  const STALE_VOLUME_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48 hours
  const now = Date.now();
  const totalVolume24h = activeData.reduce(
    (sum, m) => {
      const updatedAt = (m as Record<string, unknown>).stats_updated_at as string | null;
      if (updatedAt) {
        const ageMs = now - new Date(updatedAt).getTime();
        if (ageMs > STALE_VOLUME_THRESHOLD_MS) return sum; // skip stale volume
      }
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
      const rawOi = isSaneMarketValue(m.total_open_interest)
        ? m.total_open_interest!
        : (isSaneMarketValue((m.open_interest_long ?? 0) + (m.open_interest_short ?? 0))
            ? (m.open_interest_long ?? 0) + (m.open_interest_short ?? 0)
            : 0);
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
  const trades24h = activeData.reduce((sum, m) => {
    const updatedAt = (m as Record<string, unknown>).stats_updated_at as string | null;
    if (updatedAt) {
      const ageMs = now - new Date(updatedAt).getTime();
      if (ageMs > STALE_VOLUME_THRESHOLD_MS) return sum; // skip stale trade count
    }
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
  }, {
    headers: {
      "Cache-Control": "public, s-maxage=15, stale-while-revalidate=45",
    },
  });
}
