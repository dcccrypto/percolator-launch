import { lotExpOf } from "@/lib/v22/lot";
import { type NextRequest, NextResponse } from "next/server";
import { validateSlabParam } from "@/lib/route-validators";
import { isBlockedSlab } from "@/lib/blocklist";
import { readCurrentWrapperSlab } from "@/lib/current-wrapper-slab";
import { isUnsupportedLayout, isWrapperMarketAccount, parseMarketOI, unsupportedLayoutBody } from "@/lib/v22/layout";

export const dynamic = "force-dynamic";

/**
 * GET /api/open-interest/[slab]
 *
 * Read on-chain only: the slab account of a market owned by the CURRENT wrapper, OI parsed from
 * its per-asset slot fields. Returns { totalOi, longOi, shortOi, netLpPosition, insuranceBalance,
 * historicalOi: [], isV17: true }; OI fields are base-asset Q quantities (scale 1e6), not USD.
 *
 *  - not a market (no account, another program's account, a non-market wrapper account, or a
 *    plain system / mint account)            -> 404 (permanent, not "temporarily unavailable")
 *  - RPC failure                              -> 503 (retryable; the card falls back to on-chain OI)
 *  - a market whose OI cannot be parsed       -> 503
 *  - blocked slabs (GH#1462)                  -> 404
 *
 * MEDIUM-003: slab parameter validated before any downstream use.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slab: string }> },
) {
  const { slab } = await params;

  const validation = validateSlabParam(slab);
  if (!validation.valid) {
    return validation.response;
  }
  const validSlab = validation.slab;

  if (isBlockedSlab(validSlab)) {
    return NextResponse.json({ error: "Market not found" }, { status: 404 });
  }

  const read = await readCurrentWrapperSlab(validSlab);
  if (!read.ok) {
    if (read.reason === "unsupported-layout") return NextResponse.json(unsupportedLayoutBody(null, read.version), { status: 422 });
    return read.reason === "rpc"
      ? degraded(validSlab, "chain read")
      : NextResponse.json({ error: "Market not found" }, { status: 404 });
  }
  if (!isWrapperMarketAccount(read.data)) {
    return NextResponse.json({ error: "Market not found" }, { status: 404 });
  }

  try {
    const oi = parseMarketOI(read.data);
    const totalOi = oi.totalLongOiQ + oi.totalShortOiQ;
    return NextResponse.json(
      {
        totalOi: totalOi.toString(),
        longOi: oi.totalLongOiQ.toString(),
        shortOi: oi.totalShortOiQ.toString(),
        // Not aggregated server-side; the client hides it when isV17 (OpenInterestCard.tsx).
        netLpPosition: "0",
        insuranceBalance: oi.insuranceBalance.toString(),
        historicalOi: [],
        // H12: OI above is base-asset Q (scale 1e6); the client multiplies by the live price.
        isV17: true,
        // v2.2 lot market: OI above is in LOTS (the client prices it with the per-LOT live price, so USD is exact).
        // Tokens = lots * 10^lotExp. Absent on a market without lots (flag off / v2.1): the response is unchanged.
        ...(lotExpOf(read.data) > 0 ? { lotExp: lotExpOf(read.data) } : {}),
      },
      { headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30" } },
    );
  } catch (err) {
    if (isUnsupportedLayout(err)) return NextResponse.json(unsupportedLayoutBody(err), { status: 422 });
    console.warn(`[/api/open-interest/${validSlab}] v17 OI parse failed:`, err);
    return degraded(validSlab, "OI parse");
  }
}

/**
 * Retryable failure: a 5xx, never a fabricated $0 (OpenInterestCard throws on !res.ok and falls
 * back to the on-chain engine OI it holds). The zero fields + `unavailable` keep the shape valid.
 */
function degraded(slab: string, what: string): NextResponse {
  console.warn(`[/api/open-interest/${slab}] ${what} failed — returning 503 (degraded)`);
  return NextResponse.json(
    {
      error: "Open interest temporarily unavailable",
      unavailable: true,
      totalOi: "0",
      longOi: "0",
      shortOi: "0",
      netLpPosition: "0",
      historicalOi: [],
    },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}
