import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * GET /api/markets/[slab]/prices
 *
 * Returns price history for a market slab address.
 * Reads from oracle_prices or market_stats tables.
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

    const db = getServiceClient();
    if (!db) {
      return NextResponse.json({ prices: [] });
    }

    // 1. Check oracle_prices (stats collector writes here)
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

    // 2. Fallback: market_stats for the most recent price
    const { data: stats } = await (db as any)
      .from("market_stats")
      .select("mark_price_e6, last_updated")
      .eq("slab_address", slab)
      .order("last_updated", { ascending: false })
      .limit(1);

    if (stats && stats.length > 0) {
      const markPriceE6 = stats[0].mark_price_e6 as number | null | undefined;
      if (
        typeof markPriceE6 !== "number" ||
        !Number.isFinite(markPriceE6) ||
        markPriceE6 <= 0
      ) {
        return NextResponse.json({ prices: [] }); // no valid mark price
      }
      return NextResponse.json({
        prices: [
          {
            price_e6: String(markPriceE6),
            timestamp: stats[0].last_updated
              ? new Date(stats[0].last_updated).getTime()
              : Date.now(),
          },
        ],
      });
    }

    return NextResponse.json({ prices: [] });
  } catch (err) {
    console.error("[prices] Error:", err);
    return NextResponse.json({ prices: [] });
  }
}
