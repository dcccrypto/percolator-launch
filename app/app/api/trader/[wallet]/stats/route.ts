import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { PublicKey } from "@solana/web3.js";

/**
 * GET /api/trader/:wallet/stats
 *
 * Returns aggregate trade statistics for a wallet address.
 * Computed from the `trades` table — all on-chain trades are public.
 *
 * PERC-481: Trade statistics panel on portfolio page.
 *
 * Response:
 * {
 *   totalTrades: number,
 *   longTrades: number,
 *   shortTrades: number,
 *   totalVolume: string,   // raw bigint string (size * price / 1e6, in token units × 1e6)
 *   totalFees: string,     // raw bigint string (sum of fee column, already in token units × 1e6)
 *   uniqueMarkets: number,
 *   firstTradeAt: string | null,  // ISO timestamp of oldest trade
 *   lastTradeAt: string | null,   // ISO timestamp of most recent trade
 * }
 */
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Rate limiter — 30 req/min per IP (stats endpoint is heavier than paginated list)
// ---------------------------------------------------------------------------
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

const rateMap = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  if (entry.count >= RATE_LIMIT) return true;
  entry.count++;
  return false;
}

export interface TraderStatsResponse {
  totalTrades: number;
  longTrades: number;
  shortTrades: number;
  /** Sum of |size| × price for each trade, as raw string (already in e6 units due to price being e0 and size in e6) */
  totalVolume: string;
  /** Sum of fee column as raw string (token units × 1e6) */
  totalFees: string;
  /** Number of distinct markets this wallet has traded */
  uniqueMarkets: number;
  /** ISO timestamp of oldest trade */
  firstTradeAt: string | null;
  /** ISO timestamp of most recent trade */
  lastTradeAt: string | null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ wallet: string }> },
) {
  // Rate limiting
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown";
  if (isRateLimited(ip)) {
    return NextResponse.json(
      { error: "Too many requests — max 30 per minute" },
      {
        status: 429,
        headers: {
          "Retry-After": "60",
          "X-RateLimit-Limit": String(RATE_LIMIT),
          "X-RateLimit-Window": "60s",
        },
      },
    );
  }

  const { wallet } = await params;

  // Validate wallet address
  let walletKey: string;
  try {
    walletKey = new PublicKey(wallet).toBase58();
  } catch {
    return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
  }

  try {
    const supabase = getServiceClient();

    // Fetch all trade rows for this wallet (size, side, price, fee, slab_address, created_at).
    // We select only the fields needed for aggregation to minimise data transfer.
    // Limit to 10 000 rows — sufficient for any realistic trader history;
    // avoids pathological queries on a future high-volume wallet.
    const { data, error } = await supabase
      .from("trades")
      .select("side, size, price, fee, slab_address, created_at")
      .eq("trader", walletKey)
      .order("created_at", { ascending: true })
      .limit(10_000);

    if (error) throw error;

    const rows = data ?? [];

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

      // size is stored as a raw string representing token units × 1e6 (can be negative for short).
      // price is a float (USD per token, not scaled).
      // Volume = |size| × price gives USD-denominated volume but size is in e6.
      // We keep everything in e6 token units so the frontend can format consistently.
      try {
        const rawSize = BigInt(String(row.size).split(".")[0]);
        const absSize = rawSize < 0n ? -rawSize : rawSize;
        // price is float — convert to e6 integer for lossless BigInt multiply, then divide back
        const priceE6 = BigInt(Math.round(Number(row.price) * 1_000_000));
        // volume contribution: (absSize in e6) × (priceE6 / 1e6) = absSize × priceE6 / 1e6
        // Keep in e12 precision then normalise to e6
        totalVolume += (absSize * priceE6) / 1_000_000n;
      } catch {
        // Malformed row — skip
      }

      try {
        totalFees += BigInt(Math.round(Number(row.fee)));
      } catch {
        // Skip
      }

      if (row.slab_address) markets.add(String(row.slab_address));

      if (row.created_at) {
        if (!firstTradeAt) firstTradeAt = String(row.created_at);
        lastTradeAt = String(row.created_at);
      }
    }

    const stats: TraderStatsResponse = {
      totalTrades: rows.length,
      longTrades,
      shortTrades,
      totalVolume: totalVolume.toString(),
      totalFees: totalFees.toString(),
      uniqueMarkets: markets.size,
      firstTradeAt,
      lastTradeAt,
    };

    return NextResponse.json(stats, {
      headers: {
        // Cache for 30s — stats are aggregate so slightly stale is fine
        "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60",
      },
    });
  } catch (err) {
    console.error("[trader-stats] error:", err);
    return NextResponse.json(
      {
        error: "Failed to fetch trade statistics",
        ...(process.env.NODE_ENV !== "production" && {
          details: err instanceof Error ? err.message : String(err),
        }),
      },
      { status: 500 },
    );
  }
}
