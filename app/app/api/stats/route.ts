// PUBLIC endpoint — no auth required. Intentionally unauthenticated.
// IMPORTANT: Only add aggregate, non-user-specific fields here.
// Any user-specific or admin-sensitive data MUST go behind requireAuth().
// (Security issue #1031)

import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { isActiveMarket, isSaneMarketValue } from "@/lib/activeMarketFilter";
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
    supabase.from("markets_with_stats").select("slab_address, volume_24h, trade_count_24h, open_interest_long, open_interest_short, total_open_interest, last_price, decimals, vault_balance, total_accounts, oracle_authority").limit(500),
    supabase.from("trades").select("trader").limit(5000),
  ]);

  // GH#1218: filter blocked slabs before aggregating — mirrors /api/markets behaviour.
  // Previously this endpoint had no blocklist filter, allowing corrupt markets (e.g. NL
  // with 9e12 raw OI → $89.2M false open interest) to pollute global stats.
  const BLOCKED_MARKET_ADDRESSES: ReadonlySet<string> = new Set([
    ...BLOCKED_SLAB_ADDRESSES,
    ...(process.env.BLOCKED_MARKET_ADDRESSES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ]);
  // GH#1398: Filter out garbage markets with system program oracle_authority
  const ZERO_PUBKEY = "11111111111111111111111111111111";
  const statsData = (statsRes.data ?? []).filter(
    (m) => !BLOCKED_MARKET_ADDRESSES.has((m as Record<string, unknown>).slab_address as string ?? ""),
  ).filter(
    (m) => (m as Record<string, unknown>).oracle_authority !== ZERO_PUBKEY,
  );

  // GH#1337: Suppress phantom OI before counting active markets.
  // Previously isActiveMarket() was applied to raw data where phantom markets
  // (vault < 1M or accounts == 0) still had stale non-zero OI, causing them to
  // count as "active" here but not in /api/markets (which zeros OI post-sanitization).
  // This produced a 172 vs 135 mismatch. Now we zero phantom OI first, so both
  // endpoints agree on what counts as "active".
  const MIN_VAULT_FOR_ACTIVE = 1_000_000;
  const phantomAwareData = statsData.map((m) => {
    const accountsCount = (m as Record<string, unknown>).total_accounts as number ?? 0;
    const vaultBal = (m as Record<string, unknown>).vault_balance as number ?? 0;
    const isPhantom = accountsCount === 0 || vaultBal < MIN_VAULT_FOR_ACTIVE;
    if (!isPhantom) return m;
    // Zero out OI fields so isActiveMarket won't consider stale phantom OI as "active"
    return {
      ...m,
      total_open_interest: 0,
      open_interest_long: 0,
      open_interest_short: 0,
    };
  });
  const activeData = phantomAwareData.filter(isActiveMarket);
  const totalMarkets = activeData.length;

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

  const totalVolume24h = activeData.reduce(
    (sum, m) => sum + toUsd(m.volume_24h ?? 0, m),
    0
  );
  // GH#1297: Phantom OI guard — mirrors /api/markets isPhantomOI logic.
  // Markets with accounts_count=0 or vault<1M are stale/orphaned; their raw OI atoms
  // are not backed by real positions. Without this filter, the $1 fallback (GH#1265)
  // inflated /api/stats totalOpenInterest to $117K vs /api/markets sum of $64K.
  const MIN_VAULT_FOR_OI_STATS = 1_000_000;
  const totalOpenInterest = activeData.reduce(
    (sum, m) => {
      // GH#1297: Skip phantom markets (no accounts or dust/empty vault) — same guard as /api/markets
      const accountsCount = (m as Record<string, unknown>).total_accounts as number ?? 0;
      const vaultBal = (m as Record<string, unknown>).vault_balance as number ?? 0;
      // GH#1314: Mirror /api/markets phantom guard exactly — strict < 1M (not <=).
      // vault=1M (creation-deposit only) markets like usdEkK5G and MOLTBOT are NOT
      // phantom (strict < excludes only vault < 1M). PR #1303 used <= which incorrectly
      // filtered them; PR #1307 over-corrected with (vaultBal <= 1M && rawOi === 0)
      // which let through markets with vault < 1M + stale non-zero rawOi, causing the
      // residual $42K phantom OI. The /api/markets condition is the single source of truth.
      const rawOi = isSaneMarketValue(m.total_open_interest)
        ? m.total_open_interest!
        : (isSaneMarketValue((m.open_interest_long ?? 0) + (m.open_interest_short ?? 0))
            ? (m.open_interest_long ?? 0) + (m.open_interest_short ?? 0)
            : 0);
      if (!isSaneMarketValue(rawOi)) return sum;
      // Skip phantom markets: no accounts, OR vault below creation-deposit threshold.
      // Strict < mirrors /api/markets isPhantomOI exactly (vault=1M is NOT phantom).
      const isPhantomOI = accountsCount === 0 || vaultBal < MIN_VAULT_FOR_OI_STATS;
      if (isPhantomOI) return sum;
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
    (tradersRes.data ?? []).map((r) => r.trader)
  ).size;
  // GH#1265: trades table count query (head:true) returns 0 — likely a column name mismatch
  // or supabase HEAD count limitation. Use trade_count_24h from markets_with_stats instead,
  // which is the same source used by /api/markets and is reliable.
  const trades24h = activeData.reduce((sum, m) => sum + (m.trade_count_24h ?? 0), 0);

  return NextResponse.json({
    totalMarkets,
    // #1172: totalListedMarkets includes all non-blocked markets (even those with
    // zero stats). totalMarkets counts only "active" markets (at least one sane stat).
    totalListedMarkets: statsData.length,
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
