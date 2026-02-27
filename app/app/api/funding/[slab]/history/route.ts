import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * GET /api/funding/[slab]/history
 *
 * Returns 24h funding rate history for a market from the funding_history table.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slab: string }> }
) {
  try {
    const { slab } = await params;
    if (!slab || slab.length < 20) {
      return NextResponse.json({ history: [] });
    }

    const db = getServiceClient();

    // Get 24h of funding history
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await db
      .from("funding_history")
      .select("slot, rate_bps_per_slot, timestamp, price_e6")
      .eq("market_slab", slab)
      .gte("timestamp", cutoff)
      .order("timestamp", { ascending: true })
      .limit(200);

    if (error) {
      console.error("[/api/funding/history] Supabase error:", error);
      return NextResponse.json({ history: [] });
    }

    const slotsPerHour = 9000;
    const history = (data ?? []).map((row: any) => ({
      slot: Number(row.slot),
      rateBpsPerSlot: Number(row.rate_bps_per_slot),
      timestamp: new Date(row.timestamp).getTime(),
      hourlyRatePercent: (Number(row.rate_bps_per_slot) * slotsPerHour) / 10000,
    }));

    return NextResponse.json({ history });
  } catch (e) {
    console.error("[/api/funding/history] Error:", e);
    return NextResponse.json({ history: [] });
  }
}
