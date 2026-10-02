import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { validateNumericParam } from "@/lib/route-validators";
import { getClientIp } from "@/lib/get-client-ip";
import { createUpstashRateLimiter } from "@/lib/upstash-rate-limit";
import { hasIndexerDb, queryTraderTradesPage } from "@/lib/indexer-db";
import { getRetiredSlabs } from "@/lib/retired-slabs";

/**
 * GET /api/trader/:wallet/trades?limit=20&offset=0&slab=<optional>
 *
 * P0 fix: reads from local indexer Postgres when INDEXER_DATABASE_URL is set.
 * Falls back to Supabase (guarded) or returns empty list on failure.
 */
export const dynamic = "force-dynamic";

const RATE_LIMIT = 60;
// GH#2487: was createMemoryRateLimiter — a per-process Map, so on serverless the
// limit is per instance and a client spread across warm instances multiplies it
// by the instance count. createUpstashRateLimiter shares the window through
// Redis when configured and falls back to the same in-memory behaviour when it
// is not, so dev/CI are unchanged while production becomes global.
const rateLimiter = createUpstashRateLimiter({ limit: RATE_LIMIT, windowMs: 60_000, prefix: "rl:trader-trades" });

export interface TraderTradeEntry {
  id: string;
  slab_address: string;
  trader: string;
  side: "long" | "short";
  size: string;
  price: number;
  fee: number;
  tx_signature: string | null;
  created_at: string;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ wallet: string }> },
) {
  const ip = getClientIp(_request);
  const rl = await rateLimiter.check(ip);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests — max 60 per minute" },
      {
        status: 429,
        headers: {
          "Retry-After": "60",
          "X-RateLimit-Limit": String(RATE_LIMIT),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Window": "60s",
        },
      },
    );
  }

  const { wallet } = await params;
  const url = new URL(_request.url);

  let walletKey: string;
  try {
    walletKey = new PublicKey(wallet).toBase58();
  } catch {
    return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
  }

  const MAX_LIMIT = 100;
  const MAX_OFFSET = 1_000_000;
  const DEFAULT_LIMIT = 20;

  const limitParam = url.searchParams.get("limit");
  const limitValidation = validateNumericParam(limitParam ?? String(DEFAULT_LIMIT), { min: 1, max: MAX_LIMIT });
  const limit = !limitValidation.valid ? DEFAULT_LIMIT : limitValidation.value;

  const offsetParam = url.searchParams.get("offset");
  const offsetValidation = validateNumericParam(offsetParam ?? "0", { min: 0, max: MAX_OFFSET });
  const offset = !offsetValidation.valid ? 0 : offsetValidation.value;

  const slabFilter = url.searchParams.get("slab");
  const safeSlab = slabFilter && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(slabFilter) ? slabFilter : undefined;

  // No data source configured (the contributor setup in PLAYGROUND.md): an empty list is the true
  // answer, not an outage. Same env check as getServiceClient().
  if (!hasIndexerDb() && !(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)) {
    return NextResponse.json({ trades: [], total: 0, limit, offset });
  }

  // GH#2795: fills on markets of an abandoned wrapper (the ones /api/markets no longer lists)
  // are left out of both paths, so `total` and paging stay consistent. [] = no filter.
  const retired = await getRetiredSlabs();

  // P0: prefer local indexer
  if (hasIndexerDb()) {
    try {
      const { trades: rawTrades, total } = await queryTraderTradesPage(walletKey, limit, offset, safeSlab, retired);
      const trades: TraderTradeEntry[] = rawTrades.map((r) => ({
        id: r.id,
        slab_address: r.slab_address,
        trader: r.trader,
        side: r.side as "long" | "short",
        size: r.size,
        price: Number(r.price),
        fee: Number(r.fee),
        tx_signature: r.tx_signature || null,
        created_at: r.created_at,
      }));
      return NextResponse.json(
        { trades, total, limit, offset },
        {
          headers: {
            "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30",
            "X-RateLimit-Limit": String(RATE_LIMIT),
            "X-RateLimit-Remaining": String(rl.remaining),
            "X-RateLimit-Window": "60s",
          },
        },
      );
    } catch (err) {
      console.warn("[trader-trades] indexer-db error:", err instanceof Error ? err.message : String(err));
      // fall through to Supabase
    }
  }

  // Supabase fallback (guarded)
  try {
    const { getServiceClient, getServerNetwork } = await import("@/lib/supabase");
    const supabase = getServiceClient();

    let query = supabase
      .from("trades")
      .select("id, slab_address, trader, side, size, price, fee, tx_signature, created_at", { count: "exact" })
      .eq("trader", walletKey)
      .eq("network", getServerNetwork())
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (safeSlab) query = query.eq("slab_address", safeSlab);
    if (retired.length > 0) query = query.not("slab_address", "in", `(${retired.join(",")})`);

    let { data, error, count } = await query;

    if (error && error.message?.includes("network")) {
      let fallbackQuery = supabase
        .from("trades")
        .select("id, slab_address, trader, side, size, price, fee, tx_signature, created_at", { count: "exact" })
        .eq("trader", walletKey)
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);
      if (safeSlab) fallbackQuery = fallbackQuery.eq("slab_address", safeSlab);
      if (retired.length > 0) fallbackQuery = fallbackQuery.not("slab_address", "in", `(${retired.join(",")})`);
      const fallback = await fallbackQuery;
      data = fallback.data;
      error = fallback.error;
      count = fallback.count;
    }

    if (error) throw error;

    const trades: TraderTradeEntry[] = (data ?? []).map((row) => ({
      id: String(row.id),
      slab_address: String(row.slab_address),
      trader: String(row.trader),
      side: row.side as "long" | "short",
      size: String(row.size),
      price: Number(row.price),
      fee: Number(row.fee),
      tx_signature: row.tx_signature ? String(row.tx_signature) : null,
      created_at: String(row.created_at),
    }));

    return NextResponse.json(
      { trades, total: count ?? 0, limit, offset },
      {
        headers: {
          "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30",
          "X-RateLimit-Limit": String(RATE_LIMIT),
          "X-RateLimit-Remaining": String(rl.remaining),
          "X-RateLimit-Window": "60s",
        },
      },
    );
  } catch (err) {
    // A configured source failed. A cached 200 [] here reads as "no trades" and hides the outage,
    // so say so (503, not cached); the client's !res.ok branch shows the failure. Same shape as #2711.
    console.warn("[trader-trades] supabase unavailable:", err instanceof Error ? err.message : String(err));
    return NextResponse.json(
      { error: "Trade history temporarily unavailable", unavailable: true, trades: [], total: 0, limit, offset },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
          "X-RateLimit-Limit": String(RATE_LIMIT),
          "X-RateLimit-Remaining": String(rl.remaining),
          "X-RateLimit-Window": "60s",
        },
      },
    );
  }
}
