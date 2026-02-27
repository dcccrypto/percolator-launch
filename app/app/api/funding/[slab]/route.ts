import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * GET /api/funding/[slab]
 *
 * Returns current funding rate data for a market.
 * Reads from market_stats + funding_history tables.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slab: string }> }
) {
  try {
    const { slab } = await params;
    if (!slab || slab.length < 20) {
      return NextResponse.json({ error: "Invalid slab address" }, { status: 400 });
    }

    const db = getServiceClient();

    // Get current funding rate from market_stats
    const { data: stats, error: statsError } = await db
      .from("market_stats")
      .select("funding_rate, last_crank_slot, slab_address")
      .eq("slab_address", slab)
      .single();

    if (statsError || !stats) {
      return NextResponse.json({ error: "Market not found" }, { status: 404 });
    }

    const rateBpsPerSlot = Number(stats.funding_rate ?? 0);
    // ~9000 slots per hour on Solana (400ms slot time)
    const slotsPerHour = 9000;
    const hourlyRatePercent = (rateBpsPerSlot * slotsPerHour) / 10000;
    const aprPercent = hourlyRatePercent * 24 * 365;

    // Determine direction
    const direction = rateBpsPerSlot > 0
      ? "long_pays_short"
      : rateBpsPerSlot < 0
        ? "short_pays_long"
        : "neutral";

    // Get latest funding history entry for next funding slot / net LP position
    const { data: latestFunding } = await db
      .from("funding_history")
      .select("slot, net_lp_pos")
      .eq("market_slab", slab)
      .order("timestamp", { ascending: false })
      .limit(1);

    const netLpPosition = latestFunding?.[0]?.net_lp_pos
      ? String(latestFunding[0].net_lp_pos)
      : "0";
    const currentSlot = Number(stats.last_crank_slot ?? 0);

    return NextResponse.json({
      currentRateBpsPerSlot: rateBpsPerSlot,
      hourlyRatePercent,
      aprPercent,
      direction,
      nextFundingSlot: 0, // continuous funding — no discrete epochs
      netLpPosition,
      currentSlot,
    });
  } catch (e) {
    console.error("[/api/funding] Error:", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
