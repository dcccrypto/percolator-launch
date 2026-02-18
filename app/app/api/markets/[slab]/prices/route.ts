import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * GET /api/markets/[slab]/prices
 *
 * Returns price history for a market slab address.
 * Reads from the market_stats table which is populated by the StatsCollector service.
 * Falls back to an empty array if no data is available (chart builds from live on-chain data).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slab: string }> }
) {
  try {
    const { slab } = await params;

    if (!slab || slab.length < 20) {
      return NextResponse.json({ prices: [] });
    }

    // Try to get price history from market_stats
    const db = getServiceClient();
    if (!db) {
      return NextResponse.json({ prices: [] });
    }

    // Query oracle_prices table if it exists, otherwise fall back to market_stats
    const { data: oraclePrices, error: oracleError } = await (db as any)
      .from("oracle_prices")
      .select("price_e6, timestamp")
      .eq("slab_address", slab)
      .order("timestamp", { ascending: true })
      .limit(500);

    if (!oracleError && oraclePrices && oraclePrices.length > 0) {
      return NextResponse.json({
        prices: oraclePrices.map((p: any) => ({
          price_e6: String(p.price_e6),
          timestamp: p.timestamp,
        })),
      });
    }

    // Fallback: try market_stats for the most recent price
    const { data: stats } = await (db as any)
      .from("market_stats")
      .select("mark_price_e6, last_updated")
      .eq("slab_address", slab)
      .order("last_updated", { ascending: false })
      .limit(1);

    if (stats && stats.length > 0) {
      return NextResponse.json({
        prices: [
          {
            price_e6: String(stats[0].mark_price_e6),
            timestamp: new Date(stats[0].last_updated).getTime(),
          },
        ],
      });
    }

    // No data — chart will build from live on-chain data
    return NextResponse.json({ prices: [] });
  } catch (err) {
    console.error("[prices] Error:", err);
    return NextResponse.json({ prices: [] });
  }
}
