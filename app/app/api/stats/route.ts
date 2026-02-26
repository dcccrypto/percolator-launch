import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { isActiveMarket, isSaneMarketValue } from "@/lib/activeMarketFilter";
import type { Database } from "@/lib/database.types";
export const dynamic = "force-dynamic";

type MarketWithStats = Database['public']['Views']['markets_with_stats']['Row'];

/**
 * GET /api/stats — Platform-wide aggregated statistics
 *
 * Uses isActiveMarket() from shared activeMarketFilter for consistent
 * market counts across homepage, /api/stats, and markets page.
 */
export async function GET() {
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
  });
}
