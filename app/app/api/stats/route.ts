import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import type { Database } from "@/lib/database.types";
export const dynamic = "force-dynamic";

type MarketWithStats = Database['public']['Views']['markets_with_stats']['Row'];

/**
 * GET /api/stats — Platform-wide aggregated statistics
 */
export async function GET() {
  const supabase = getServiceClient();

  const [marketsRes, statsRes, tradersRes, recentTradesRes] = await Promise.all([
    supabase.from("markets").select("slab_address", { count: "exact", head: true }),
    supabase.from("markets_with_stats").select("volume_24h, open_interest_long, open_interest_short, last_price").limit(500),
    supabase.from("markets").select("deployer").limit(500),
    supabase
      .from("trades")
      .select("id", { count: "exact", head: true })
      .gte("created_at", new Date(Date.now() - 86400000).toISOString()),
  ]);

  const totalMarkets = marketsRes.count ?? 0;
  const statsData = statsRes.data ?? [];

  const totalVolume24h = statsData.reduce(
    (sum, m) => sum + (m.volume_24h ?? 0),
    0
  );
  const totalOpenInterest = statsData.reduce(
    (sum, m) => sum + ((m.open_interest_long ?? 0) + (m.open_interest_short ?? 0)),
    0
  );
  const uniqueTraders = new Set(
    (tradersRes.data ?? []).map((r) => r.deployer)
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
