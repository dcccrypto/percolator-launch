// PUBLIC endpoint — no auth required. Intentionally unauthenticated.
// IMPORTANT: Only add aggregate, non-user-specific fields here.
// Any user-specific or admin-sensitive data MUST go behind requireAuth().
// (Security issue #1031)

import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { isActiveMarket, isSaneMarketValue } from "@/lib/activeMarketFilter";
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

  const [statsRes, tradersRes, recentTradesRes] = await Promise.all([
    supabase.from("markets_with_stats").select("volume_24h, open_interest_long, open_interest_short, total_open_interest, last_price, decimals").limit(500),
    supabase.from("trades").select("trader").limit(5000),
    supabase
      .from("trades")
      .select("id", { count: "exact", head: true })
      .gte("created_at", new Date(Date.now() - 86400000).toISOString()),
  ]);

  const statsData = statsRes.data ?? [];

  // Count only active markets using shared filter (consistent with homepage & markets page)
  const activeData = statsData.filter(isActiveMarket);
  const totalMarkets = activeData.length;

  // Convert raw on-chain token micro-units to USD using decimals + price
  // Without this, sentinel-like values (2e12) leak through as $2T (#1154)
  const MAX_PER_MARKET_USD = 10_000_000_000; // $10B cap — no single market should exceed this
  // GH#1191: corrupt devnet last_price values (e.g. $7.9T/token) multiply small but
  // legitimate token amounts into billions. Cap price at $10K/token — no Percolator
  // collateral token should legitimately exceed this. Same fix applied to page.tsx in PR #1190 (GH#1187).
  const MAX_SANE_PRICE_USD = 10_000; // $10K — reject as corrupt above this
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
  const totalOpenInterest = activeData.reduce(
    (sum, m) => {
      const rawOi = isSaneMarketValue(m.total_open_interest)
        ? m.total_open_interest!
        : (isSaneMarketValue((m.open_interest_long ?? 0) + (m.open_interest_short ?? 0))
            ? (m.open_interest_long ?? 0) + (m.open_interest_short ?? 0)
            : 0);
      return sum + toUsd(rawOi, m);
    },
    0
  );
  const uniqueTraders = new Set(
    (tradersRes.data ?? []).map((r) => r.trader)
  ).size;
  const trades24h = recentTradesRes.count ?? 0;

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
