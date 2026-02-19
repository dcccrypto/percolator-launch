import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * GET /api/markets/[slab]/trades
 *
 * Returns recent trades for a market from Supabase trades table.
 * Reads from Supabase trades table.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slab: string }> }
) {
  try {
    const { slab } = await params;
    if (!slab || slab.length < 20) {
      return NextResponse.json({ trades: [] });
    }

    const limit = Math.min(
      parseInt(req.nextUrl.searchParams.get("limit") ?? "25", 10),
      100
    );

    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("trades")
      .select("*")
      .eq("slab_address", slab)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      console.error("[/api/trades] Supabase error:", error);
      return NextResponse.json({ trades: [] });
    }

    return NextResponse.json({ trades: data ?? [] });
  } catch (e) {
    console.error("[/api/trades] Error:", e);
    return NextResponse.json({ trades: [] });
  }
}
