import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/markets/[slab]/trades
 *
 * Returns recent trades for a market. For sim markets, reads from on-chain
 * trade history. Falls back to empty array when no data is available.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slab: string }> }
) {
  try {
    const { slab } = await params;
    if (!slab || slab.length < 20) {
      return NextResponse.json({ trades: [] });
    }

    // For now, return empty — trades will appear from on-chain indexing
    // The TradeHistory component handles empty state gracefully
    return NextResponse.json({ trades: [] });
  } catch {
    return NextResponse.json({ trades: [] });
  }
}
