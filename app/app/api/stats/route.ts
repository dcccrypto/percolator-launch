import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { isActiveMarket, isSaneMarketValue } from "@/lib/activeMarketFilter";
import type { Database } from "@/lib/database.types";
export const dynamic = "force-dynamic";

type MarketWithStats = Database['public']['Views']['markets_with_stats']['Row'];

// ---------------------------------------------------------------------------
// PERC-660: In-memory rate limiter — 60 req/min per IP (matches /api/trader pattern)
// ---------------------------------------------------------------------------
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;
const rateMap = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
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
    supabase.from("markets_with_stats").select("volume_24h, open_interest_long, open_interest_short, total_open_interest, last_price").limit(500),
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

  const totalVolume24h = activeData.reduce(
    (sum, m) => sum + (isSaneMarketValue(m.volume_24h) ? m.volume_24h! : 0),
    0
  );
  const totalOpenInterest = activeData.reduce(
    (sum, m) => {
      const oi = isSaneMarketValue(m.total_open_interest)
        ? m.total_open_interest!
        : (isSaneMarketValue((m.open_interest_long ?? 0) + (m.open_interest_short ?? 0))
            ? (m.open_interest_long ?? 0) + (m.open_interest_short ?? 0)
            : 0);
      return sum + oi;
    },
    0
  );
  const uniqueTraders = new Set(
    (tradersRes.data ?? []).map((r) => r.trader)
  ).size;
  const trades24h = recentTradesRes.count ?? 0;

  return NextResponse.json({
    totalMarkets,
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
