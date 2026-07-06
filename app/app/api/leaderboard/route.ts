import { NextResponse } from "next/server";
import {
  hasIndexerDb,
  queryLeaderboard,
} from "@/lib/indexer-db";

/**
 * ISR: recompute at most once every 30 seconds.
 */
export const revalidate = 30;

export interface LeaderboardEntry {
  rank: number;
  trader: string;
  tradeCount: number;
  totalVolume: string; // Raw bigint as string (sum of abs(size))
  lastTradeAt: string;
}

/**
 * GET /api/leaderboard?period=24h|7d|alltime&limit=50
 *
 * Self-contained path: reads from local indexer Postgres when INDEXER_DATABASE_URL is set.
 * Falls back to Supabase (guarded) or returns empty list on failure.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const period = url.searchParams.get("period") ?? "alltime";
  const rawLimit = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Math.min(Math.max(1, Number.isNaN(rawLimit) ? 50 : rawLimit), 200);

  // P0: prefer local indexer when INDEXER_DATABASE_URL is configured
  if (hasIndexerDb()) {
    try {
      const rows = await queryLeaderboard(period, limit);
      const leaderboard: LeaderboardEntry[] = rows.map((row, i) => ({
        rank: i + 1,
        trader: row.trader,
        tradeCount: row.tradeCount,
        totalVolume: row.totalVolume.toString(),
        lastTradeAt: row.lastTradeAt,
      }));
      return NextResponse.json({ leaderboard, period, generatedAt: new Date().toISOString() });
    } catch (err) {
      console.warn("[leaderboard] indexer-db error, falling back:", err instanceof Error ? err.message : String(err));
      // fall through to Supabase path
    }
  }

  // Supabase fallback (guarded — absent in playground)
  try {
    const { getSupabase, getServerNetwork } = await import("@/lib/supabase");
    const supabase = getSupabase();

    let query = supabase
      .from("trades")
      .select("trader, size, created_at")
      .eq("network", getServerNetwork());

    if (period === "24h") {
      const since = new Date(Date.now() - 86_400_000).toISOString();
      query = query.gte("created_at", since);
    } else if (period === "7d") {
      const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
      query = query.gte("created_at", since);
    }
    query = query.limit(100_000);

    let { data, error } = await query;

    if (error && error.message?.includes("network")) {
      let fallbackQuery = supabase.from("trades").select("trader, size, created_at");
      if (period === "24h") fallbackQuery = fallbackQuery.gte("created_at", new Date(Date.now() - 86_400_000).toISOString());
      else if (period === "7d") fallbackQuery = fallbackQuery.gte("created_at", new Date(Date.now() - 7 * 86_400_000).toISOString());
      fallbackQuery = fallbackQuery.limit(100_000);
      const fallback = await fallbackQuery;
      data = fallback.data;
      error = fallback.error;
    }

    if (error) throw error;

    const traderMap = new Map<string, { tradeCount: number; totalVolume: bigint; lastTradeAt: string }>();
    for (const row of data ?? []) {
      const rowCreatedAt = row.created_at ?? new Date().toISOString();
      const entry = traderMap.get(row.trader) ?? { tradeCount: 0, totalVolume: 0n, lastTradeAt: rowCreatedAt };
      entry.tradeCount += 1;
      try {
        const raw = BigInt(String(row.size).split(".")[0]);
        entry.totalVolume += raw < 0n ? -raw : raw;
      } catch {
        const n = Math.abs(parseFloat(String(row.size)) || 0);
        entry.totalVolume += BigInt(Math.round(n));
      }
      if (rowCreatedAt > entry.lastTradeAt) entry.lastTradeAt = rowCreatedAt;
      traderMap.set(row.trader, entry);
    }

    const sorted = [...traderMap.entries()]
      .sort(([, a], [, b]) => {
        if (b.totalVolume > a.totalVolume) return 1;
        if (b.totalVolume < a.totalVolume) return -1;
        return b.tradeCount - a.tradeCount;
      })
      .slice(0, limit);

    const leaderboard: LeaderboardEntry[] = sorted.map(([trader, stats], i) => ({
      rank: i + 1,
      trader,
      tradeCount: stats.tradeCount,
      totalVolume: stats.totalVolume.toString(),
      lastTradeAt: stats.lastTradeAt,
    }));

    return NextResponse.json({ leaderboard, period, generatedAt: new Date().toISOString() });
  } catch (err) {
    // Supabase unavailable (playground) — return empty leaderboard, never 500
    console.warn("[leaderboard] supabase unavailable:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ leaderboard: [], period, generatedAt: new Date().toISOString() });
  }
}
