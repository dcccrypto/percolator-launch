import { NextResponse } from "next/server";
import {
  hasIndexerDb,
  queryLeaderboard,
} from "@/lib/indexer-db";

// Bug: `export const revalidate = 30` was INERT here — this handler reads
// request.url search params (period/limit), which makes the route dynamic;
// Next.js route handlers are uncached by default and don't honor
// `revalidate` once a request is dynamic. No Cache-Control was set either,
// so every visitor re-ran the full query (the Supabase fallback pulls up to
// 100k rows). Fix: set real CDN cache headers instead, mirroring the sibling
// pattern in app/api/stats/route.ts (STATS_CACHE_HEADERS).
const LEADERBOARD_CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60",
} as const;

export interface LeaderboardEntry {
  rank: number;
  trader: string;
  tradeCount: number;
  /**
   * C: real USD dollars as a plain number — NOT a scaled bigint/string. This
   * is the ONE convention both the indexer and Supabase paths below now
   * agree on: the API always returns dollars; the client (leaderboard/page.tsx)
   * formats for display and must NEVER rescale by a divisor derived from
   * base-asset or collateral decimals (that was the root cause of a
   * $250,000 trader rendering as "0.25" — three incompatible conventions
   * were colliding: this route's indexer path returned real dollars, its
   * Supabase path returned dollars×1e6 "atoms", and the client divided
   * AGAIN by a divisor derived from the wrong token's decimals).
   */
  totalVolume: number;
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
        // Already real USD dollars (see LeaderboardRow.totalVolume's doc comment).
        totalVolume: row.totalVolume,
        lastTradeAt: row.lastTradeAt,
      }));
      return NextResponse.json(
        { leaderboard, period, generatedAt: new Date().toISOString() },
        { headers: LEADERBOARD_CACHE_HEADERS },
      );
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
      .select("trader, size, price, created_at")
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
      let fallbackQuery = supabase.from("trades").select("trader, size, price, created_at");
      if (period === "24h") fallbackQuery = fallbackQuery.gte("created_at", new Date(Date.now() - 86_400_000).toISOString());
      else if (period === "7d") fallbackQuery = fallbackQuery.gte("created_at", new Date(Date.now() - 7 * 86_400_000).toISOString());
      fallbackQuery = fallbackQuery.limit(100_000);
      const fallback = await fallbackQuery;
      data = fallback.data;
      error = fallback.error;
    }

    if (error) throw error;

    // C: accumulate in a precision-safe bigint scale internally (micro-USD,
    // i.e. dollars×1e6 — same scale computeMarkPnlCollateral-style code uses
    // elsewhere) so the ranking sort never hits float precision issues, then
    // convert to real USD dollars ONCE at the very end (see the `.map` below)
    // — never re-scaled again downstream. This is what LeaderboardEntry.totalVolume
    // documents as the one convention both this route's paths must agree on.
    const traderMap = new Map<string, { tradeCount: number; totalVolumeMicroUsd: bigint; lastTradeAt: string }>();
    for (const row of data ?? []) {
      const rowCreatedAt = row.created_at ?? new Date().toISOString();
      const entry = traderMap.get(row.trader) ?? { tradeCount: 0, totalVolumeMicroUsd: 0n, lastTradeAt: rowCreatedAt };
      entry.tradeCount += 1;
      // Dollar notional = abs(size) * price, computed BEFORE summing/ranking —
      // otherwise Σabs(size) alone ranks by raw contract quantity across
      // heterogeneous markets (a $50 PENGU trade would outrank a $10k SOL
      // trade). Matches the trader-stats convention (absSize * priceE6 / 1e6)
      // in /api/trader/[wallet]/stats/route.ts. `size` is a raw base-asset "Q"
      // quantity (fixed-point, scale 1e6); `row.price` is a real USD float
      // (not price_e6) — both branches below produce the SAME micro-USD scale
      // (dollars × 1e6).
      try {
        const rawSize = BigInt(String(row.size).split(".")[0]);
        const absSize = rawSize < 0n ? -rawSize : rawSize;
        const priceE6 = BigInt(Math.round((Number(row.price) || 0) * 1_000_000));
        entry.totalVolumeMicroUsd += (absSize * priceE6) / 1_000_000n;
      } catch {
        const size = Math.abs(parseFloat(String(row.size)) || 0);
        const price = Math.abs(parseFloat(String(row.price)) || 0);
        entry.totalVolumeMicroUsd += BigInt(Math.round(size * price));
      }
      if (rowCreatedAt > entry.lastTradeAt) entry.lastTradeAt = rowCreatedAt;
      traderMap.set(row.trader, entry);
    }

    const sorted = [...traderMap.entries()]
      .sort(([, a], [, b]) => {
        if (b.totalVolumeMicroUsd > a.totalVolumeMicroUsd) return 1;
        if (b.totalVolumeMicroUsd < a.totalVolumeMicroUsd) return -1;
        return b.tradeCount - a.tradeCount;
      })
      .slice(0, limit);

    const leaderboard: LeaderboardEntry[] = sorted.map(([trader, stats], i) => ({
      rank: i + 1,
      trader,
      tradeCount: stats.tradeCount,
      // Convert the internal micro-USD accumulator to real USD dollars —
      // the ONE convention LeaderboardEntry.totalVolume documents.
      totalVolume: Number(stats.totalVolumeMicroUsd) / 1_000_000,
      lastTradeAt: stats.lastTradeAt,
    }));

    return NextResponse.json(
      { leaderboard, period, generatedAt: new Date().toISOString() },
      { headers: LEADERBOARD_CACHE_HEADERS },
    );
  } catch (err) {
    // Supabase unavailable (playground) — return empty leaderboard, never 500
    console.warn("[leaderboard] supabase unavailable:", err instanceof Error ? err.message : String(err));
    return NextResponse.json(
      { leaderboard: [], period, generatedAt: new Date().toISOString() },
      { headers: LEADERBOARD_CACHE_HEADERS },
    );
  }
}
