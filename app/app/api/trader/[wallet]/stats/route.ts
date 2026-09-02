import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { getClientIp } from "@/lib/get-client-ip";
import { createUpstashRateLimiter } from "@/lib/upstash-rate-limit";
import { hasIndexerDb, queryTraderStatsRows } from "@/lib/indexer-db";

/**
 * GET /api/trader/:wallet/stats
 *
 * Returns aggregate trade statistics for a wallet address.
 * P0 fix: reads from local indexer Postgres when INDEXER_DATABASE_URL is set.
 * Falls back to Supabase (guarded) or returns empty stats on failure.
 */
export const dynamic = "force-dynamic";

const RATE_LIMIT = 30;
// GH#2487: was createMemoryRateLimiter — a per-process Map, so on serverless the
// limit is per instance and a client spread across warm instances multiplies it
// by the instance count. createUpstashRateLimiter shares the window through
// Redis when configured and falls back to the same in-memory behaviour when it
// is not, so dev/CI are unchanged while production becomes global.
const rateLimiter = createUpstashRateLimiter({ limit: RATE_LIMIT, windowMs: 60_000, prefix: "rl:trader-stats" });

/**
 * #2510: the trade scan is capped. Making the cap a named constant keeps the
 * query, the truncation test and the response field from drifting apart — the
 * bug was that `totalTrades` reported `rows.length` (i.e. the CAPPED count) with
 * nothing telling the caller it was a floor rather than a total.
 */
export const TRADER_STATS_MAX_ROWS = 10_000;

export interface TraderStatsResponse {
  totalTrades: number;
  /**
   * True when the scan hit TRADER_STATS_MAX_ROWS, i.e. every aggregate here is a
   * LOWER BOUND computed over the oldest TRADER_STATS_MAX_ROWS trades, not the
   * wallet's full history. Additive, so existing consumers are unaffected.
   */
  truncated: boolean;
  longTrades: number;
  shortTrades: number;
  totalVolume: string;
  totalFees: string;
  uniqueMarkets: number;
  firstTradeAt: string | null;
  lastTradeAt: string | null;
}

function aggregateRows(rows: { side: string; size: string; price: string; fee: string; slab_address: string; created_at: string }[]): TraderStatsResponse {
  let longTrades = 0;
  let shortTrades = 0;
  let totalVolume = 0n;
  let totalFees = 0n;
  const markets = new Set<string>();
  let firstTradeAt: string | null = null;
  let lastTradeAt: string | null = null;

  for (const row of rows) {
    if (row.side === "long") longTrades++;
    else shortTrades++;

    try {
      const rawSize = BigInt(String(row.size).split(".")[0]);
      const absSize = rawSize < 0n ? -rawSize : rawSize;
      const priceE6 = BigInt(Math.round(Number(row.price) * 1_000_000));
      totalVolume += (absSize * priceE6) / 1_000_000n;
    } catch { /* skip malformed */ }

    try {
      totalFees += BigInt(Math.round(Number(row.fee)));
    } catch { /* skip */ }

    if (row.slab_address) markets.add(String(row.slab_address));

    if (row.created_at) {
      if (!firstTradeAt) firstTradeAt = String(row.created_at);
      lastTradeAt = String(row.created_at);
    }
  }

  return {
    totalTrades: rows.length,
    // #2510: >= the cap means the DB had at least this many and probably more.
    truncated: rows.length >= TRADER_STATS_MAX_ROWS,
    longTrades,
    shortTrades,
    totalVolume: totalVolume.toString(),
    totalFees: totalFees.toString(),
    uniqueMarkets: markets.size,
    firstTradeAt,
    lastTradeAt,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ wallet: string }> },
) {
  const ip = getClientIp(request);
  const rl = await rateLimiter.check(ip);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests — max 30 per minute" },
      { status: 429, headers: { "Retry-After": "60", "X-RateLimit-Limit": String(RATE_LIMIT), "X-RateLimit-Window": "60s" } },
    );
  }

  const { wallet } = await params;

  let walletKey: string;
  try {
    walletKey = new PublicKey(wallet).toBase58();
  } catch {
    return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
  }

  // P0: prefer local indexer
  if (hasIndexerDb()) {
    try {
      const rows = await queryTraderStatsRows(walletKey);
      const stats = aggregateRows(rows);
      return NextResponse.json(stats, {
        headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" },
      });
    } catch (err) {
      console.warn("[trader-stats] indexer-db error:", err instanceof Error ? err.message : String(err));
      // fall through to Supabase
    }
  }

  // Supabase fallback (guarded)
  try {
    const { getServiceClient, getServerNetwork } = await import("@/lib/supabase");
    const supabase = getServiceClient();

    let { data, error } = await supabase
      .from("trades")
      .select("side, size, price, fee, slab_address, created_at")
      .eq("trader", walletKey)
      .eq("network", getServerNetwork())
      .order("created_at", { ascending: true })
      .limit(TRADER_STATS_MAX_ROWS);

    if (error && error.message?.includes("network")) {
      const fallback = await supabase
        .from("trades")
        .select("side, size, price, fee, slab_address, created_at")
        .eq("trader", walletKey)
        .order("created_at", { ascending: true })
        .limit(TRADER_STATS_MAX_ROWS);
      data = fallback.data;
      error = fallback.error;
    }

    if (error) throw error;

    const rows = (data ?? []).map((r) => ({
      side: String(r.side),
      size: String(r.size),
      price: String(r.price),
      fee: String(r.fee),
      slab_address: String(r.slab_address),
      created_at: String(r.created_at),
    }));

    const stats = aggregateRows(rows);
    return NextResponse.json(stats, {
      headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" },
    });
  } catch (err) {
    // Supabase unavailable — return empty stats, never 500
    console.warn("[trader-stats] supabase unavailable:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({
      totalTrades: 0,
      truncated: false,
      longTrades: 0,
      shortTrades: 0,
      totalVolume: "0",
      totalFees: "0",
      uniqueMarkets: 0,
      firstTradeAt: null,
      lastTradeAt: null,
    } satisfies TraderStatsResponse, {
      headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" },
    });
  }
}
