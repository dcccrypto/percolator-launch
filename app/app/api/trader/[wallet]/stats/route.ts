import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { getClientIp } from "@/lib/get-client-ip";
import { createUpstashRateLimiter } from "@/lib/upstash-rate-limit";
import { hasIndexerDb, queryTraderStatsAggregate } from "@/lib/indexer-db";

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

export interface TraderStatsResponse {
  totalTrades: number;
  longTrades: number;
  shortTrades: number;
  totalVolume: string;
  totalFees: string;
  uniqueMarkets: number;
  firstTradeAt: string | null;
  lastTradeAt: string | null;
  /**
   * GH#2510: true when these numbers describe only part of the wallet's history.
   *
   * The primary (indexer) path aggregates in the database over the full history
   * and never sets this. The Supabase fallback cannot aggregate without a
   * server-side function, so it still reads rows under a cap — when it hits that
   * cap the sums below are partial, and saying so is the difference between an
   * approximate answer and a wrong one. Absent/false means complete.
   */
  truncated?: boolean;
}

/** Row cap on the Supabase fallback path. See TraderStatsResponse.truncated. */
const SUPABASE_ROW_CAP = 10_000;

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
      // GH#2510: aggregated in SQL over the FULL history — no row cap, no
      // JavaScript reduce, and one row on the wire instead of up to 10 000.
      const stats: TraderStatsResponse = await queryTraderStatsAggregate(walletKey);
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
      .limit(SUPABASE_ROW_CAP);

    if (error && error.message?.includes("network")) {
      const fallback = await supabase
        .from("trades")
        .select("side, size, price, fee, slab_address, created_at")
        .eq("trader", walletKey)
        .order("created_at", { ascending: true })
        .limit(SUPABASE_ROW_CAP);
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

    // GH#2510: this path reads rows under a cap, so when it is hit the totals
    // below describe only the OLDEST SUPABASE_ROW_CAP trades (the query orders
    // by created_at ASC). Flag it rather than presenting a partial sum as a
    // total. Making this path exact needs a server-side aggregate function,
    // which is a schema change and out of scope here.
    const stats: TraderStatsResponse = aggregateRows(rows);
    if (rows.length >= SUPABASE_ROW_CAP) stats.truncated = true;
    return NextResponse.json(stats, {
      headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" },
    });
  } catch (err) {
    // Supabase unavailable — return empty stats, never 500
    console.warn("[trader-stats] supabase unavailable:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({
      totalTrades: 0,
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
