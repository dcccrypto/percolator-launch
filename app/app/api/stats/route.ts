import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
export const dynamic = "force-dynamic";

/**
 * GET /api/stats — Platform-wide aggregated statistics
 */
export async function GET() {
  const supabase = getServiceClient();

  const [marketsRes, statsRes, tradersRes, recentTradesRes] = await Promise.all([
    supabase.from("markets").select("slab_address", { count: "exact", head: true }),
    supabase.from("markets_with_stats").select("volume_24h, open_interest, last_price"),
    supabase.from("markets").select("deployer"),
    supabase
      .from("trades")
      .select("id", { count: "exact", head: true })
      .gte("created_at", new Date(Date.now() - 86400000).toISOString()),
  ]);

  const totalMarkets = marketsRes.count ?? 0;
  const statsData = statsRes.data ?? [];

  const totalVolume24h = statsData.reduce(
    (sum: number, m: Record<string, unknown>) => sum + ((m.volume_24h as number) ?? 0),
    0
  );
  const totalOpenInterest = statsData.reduce(
    (sum: number, m: Record<string, unknown>) => sum + ((m.open_interest as number) ?? 0),
    0
  );
  const uniqueTraders = new Set(
    ((tradersRes.data ?? []) as Array<Record<string, unknown>>).map((r) => r.deployer as string)
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
