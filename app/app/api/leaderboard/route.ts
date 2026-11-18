import { NextResponse } from "next/server";
import { toE6 } from "@/lib/format";
import {
  hasIndexerDb,
  queryLeaderboard,
} from "@/lib/indexer-db";
import { getRetiredSlabs } from "@/lib/retired-slabs";
import { isMissingColumnError } from "@/lib/supabase-missing-column";

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

const VALID_PERIODS = new Set(["24h", "7d", "alltime"]);

// PostgREST caps every response at its `max_rows` (1000 by default), so a single
// `.limit(100_000)` silently returned an arbitrary 1000 rows. Read in pages of
// PAGE_SIZE (<= max_rows) up to MAX_PAGES, i.e. a bounded 100k rows in total.
const PAGE_SIZE = 1000;
const MAX_PAGES = 100;

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
 * Falls back to Supabase. Empty list when neither is configured; 503 when a
 * configured source fails.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const period = url.searchParams.get("period") ?? "alltime";
  if (!VALID_PERIODS.has(period)) {
    return NextResponse.json(
      { error: "Invalid period: expected 24h, 7d or alltime" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const limitParam = url.searchParams.get("limit");
  if (limitParam !== null && !/^\d{1,9}$/.test(limitParam)) {
    return NextResponse.json(
      { error: "Invalid limit: expected a non-negative integer" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const limit = Math.min(Math.max(1, limitParam === null ? 50 : parseInt(limitParam, 10)), 200);

  // No data source configured (the contributor setup in PLAYGROUND.md): an empty
  // board is the true answer, not an outage. Same env check as getSupabase().
  if (!hasIndexerDb() && !(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)) {
    return NextResponse.json(
      { leaderboard: [], period, generatedAt: new Date().toISOString() },
      { headers: LEADERBOARD_CACHE_HEADERS },
    );
  }

  // GH#2795: fills on markets of an abandoned wrapper (the ones /api/markets no longer lists)
  // are left out of both paths. [] (no filter) when the set cannot be determined.
  const retired = await getRetiredSlabs();

  // P0: prefer local indexer when INDEXER_DATABASE_URL is configured
  if (hasIndexerDb()) {
    try {
      const rows = await queryLeaderboard(period, limit, retired);
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

    const since =
      period === "24h" ? new Date(Date.now() - 86_400_000).toISOString()
      : period === "7d" ? new Date(Date.now() - 7 * 86_400_000).toISOString()
      : null;

    // One page of the filtered read. Same filters as the indexer-DB path (queryLeaderboard):
    // network, period window, retired slabs, and is_liquidation IS NOT TRUE (liquidation markers
    // have NULL size/price and a portfolio address as trader). Ordered for stable paging.
    const readPage = (withNetwork: boolean, withLiqFilter: boolean, from: number) => {
      let q = supabase.from("trades").select("trader, size, price, created_at");
      if (withNetwork) q = q.eq("network", getServerNetwork());
      if (since) q = q.gte("created_at", since);
      if (retired.length > 0) q = q.not("slab_address", "in", `(${retired.join(",")})`);
      // The Supabase trades table may predate the column (the indexer DB has it); see retry below.
      if (withLiqFilter) q = q.not("is_liquidation", "is", true);
      return q.order("created_at", { ascending: false }).order("id", { ascending: true }).range(from, from + PAGE_SIZE - 1);
    };

    type TradeRow = { trader: string; size: unknown; price: unknown; created_at: string | null };
    const readAll = async (withNetwork: boolean, withLiqFilter: boolean) => {
      const rows: TradeRow[] = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const { data: chunk, error: pageError } = await readPage(withNetwork, withLiqFilter, page * PAGE_SIZE);
        if (pageError) return { rows, error: pageError };
        rows.push(...((chunk ?? []) as TradeRow[]));
        if ((chunk?.length ?? 0) < PAGE_SIZE) return { rows, error: null };
      }
      console.warn(`[leaderboard] supabase fallback hit the ${MAX_PAGES * PAGE_SIZE}-row bound; ranking the newest rows only`);
      return { rows, error: null };
    };

    let withNetwork = true;
    let withLiqFilter = true;
    let { rows: data, error } = await readAll(withNetwork, withLiqFilter);
    if (isMissingColumnError(error, "network")) {
      withNetwork = false;
      ({ rows: data, error } = await readAll(withNetwork, withLiqFilter));
    }
    if (isMissingColumnError(error, "is_liquidation")) {
      // No such column => no marker rows can exist (the loop below still skips NULL size/price).
      withLiqFilter = false;
      ({ rows: data, error } = await readAll(withNetwork, withLiqFilter));
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
      // Liquidation markers carry NULL size/price: never a fill, so never counted.
      if (row.size == null || row.price == null) continue;
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
        const priceE6 = toE6(Number(row.price) || 0);
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
    // GH#2709: a configured source failed. A 200 [] here renders "No trades this
    // period" and gets CDN-cached, hiding the outage. Same shape as GH#2489.
    console.warn("[leaderboard] supabase unavailable:", err instanceof Error ? err.message : String(err));
    return NextResponse.json(
      { error: "Leaderboard temporarily unavailable", unavailable: true, leaderboard: [], period, generatedAt: new Date().toISOString() },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
