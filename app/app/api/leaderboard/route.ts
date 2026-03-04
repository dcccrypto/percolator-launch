import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
export const dynamic = "force-dynamic";

export interface LeaderboardEntry {
  rank: number;
  trader: string;
  tradeCount: number;
  totalVolume: string; // Raw bigint as string (sum of abs(size))
  lastTradeAt: string;
}

/**
 * GET /api/leaderboard?period=24h|alltime&limit=50
 *
 * Returns top traders ranked by cumulative volume (sum of |size|).
 * Volume unit matches the `size` column in `trades` — raw token base units.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const period = url.searchParams.get("period") ?? "alltime";
  const rawLimit = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Math.min(Math.max(1, Number.isNaN(rawLimit) ? 50 : rawLimit), 200);

  try {
    const supabase = getServiceClient();

    let query = supabase
      .from("trades")
      .select("trader, size, created_at");

    if (period === "24h") {
      const since = new Date(Date.now() - 86_400_000).toISOString();
      query = query.gte("created_at", since);
    } else if (period === "7d") {
      const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
      query = query.gte("created_at", since);
    }

    // Cap to 100k rows (devnet won't exceed this for a while)
    query = query.limit(100_000);

    const { data, error } = await query;
    if (error) throw error;

    // Aggregate by trader in JS
    const traderMap = new Map<
      string,
      { tradeCount: number; totalVolume: bigint; lastTradeAt: string }
    >();

    for (const row of data ?? []) {
      const rowCreatedAt = row.created_at ?? new Date().toISOString();
      const entry = traderMap.get(row.trader) ?? {
        tradeCount: 0,
        totalVolume: 0n,
        lastTradeAt: rowCreatedAt,
      };

      entry.tradeCount += 1;

      // Parse size safely — stored as string or number
      try {
        const raw = BigInt(String(row.size).split(".")[0]); // strip decimal if any
        entry.totalVolume += raw < 0n ? -raw : raw;
      } catch {
        // Fallback: numeric parse
        const n = Math.abs(parseFloat(String(row.size)) || 0);
        entry.totalVolume += BigInt(Math.round(n));
      }

      if (rowCreatedAt > entry.lastTradeAt) {
        entry.lastTradeAt = rowCreatedAt;
      }

      traderMap.set(row.trader, entry);
    }

    // Sort by volume descending, then trade count as tiebreak
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

    return NextResponse.json(
      { leaderboard, period, generatedAt: new Date().toISOString() },
      {
        headers: {
          "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60",
        },
      },
    );
  } catch (err) {
    console.error("[leaderboard] error:", err);
    return NextResponse.json(
      {
        error: "Failed to fetch leaderboard",
        ...(process.env.NODE_ENV !== "production" && {
          details: err instanceof Error ? err.message : String(err),
        }),
      },
      { status: 500 },
    );
  }
}
