import { NextResponse } from "next/server";
import { validateSlabParam } from "@/lib/route-validators";
import { isBlockedSlab } from "@/lib/blocklist";
import { readCurrentWrapperSlab } from "@/lib/current-wrapper-slab";
import { unsupportedLayoutBody } from "@/lib/v22/layout";
import { readV17MaxAbsFunding } from "@/lib/v17-engine-config";

export const dynamic = "force-dynamic";

/**
 * GET /api/funding/[slab] — the current funding rate (FundingRateCard).
 *
 * Was a proxy to percolator-api (retired: "Application not found"). Now read from the slab:
 * a market whose `max_abs_funding_e9_per_slot` is 0 has funding structurally OFF (the engine
 * clamps the applied rate to exactly 0 on every crank; every wizard market is created this way,
 * lib/create-market-args.ts), so its current rate IS 0 — answered exactly. A market with funding
 * on: the per-asset applied rate is not decoded by this app yet, so the route says so (404) and
 * the card keeps its own on-chain fallback rather than showing an invented 0.
 *
 * Response (the shape the card maps): { currentRateBpsPerSlot, hourlyRatePercent,
 * annualizedPercent, netLpPosition, fundingEnabled, source }.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ slab: string }> }) {
  const { slab } = await params;
  const v = validateSlabParam(slab);
  if (!v.valid) return v.response;
  if (isBlockedSlab(v.slab)) return NextResponse.json({ error: "Market not found" }, { status: 404 });

  const read = await readCurrentWrapperSlab(v.slab);
  if (!read.ok) {
    if (read.reason === "unsupported-layout") return NextResponse.json(unsupportedLayoutBody(null, read.version), { status: 422 });
    return read.reason === "rpc"
      ? NextResponse.json({ error: "Could not read the market right now" }, { status: 503, headers: { "Retry-After": "5" } })
      : NextResponse.json({ error: "Market not found" }, { status: 404 });
  }
  const maxAbs = readV17MaxAbsFunding(read.data);
  if (maxAbs !== 0n) {
    return NextResponse.json({ error: "Funding rate not available for this market" }, { status: 404 });
  }
  return NextResponse.json(
    {
      slabAddress: v.slab,
      currentRateBpsPerSlot: 0,
      hourlyRatePercent: 0,
      annualizedPercent: 0,
      netLpPosition: "0",
      fundingEnabled: false,
      source: "on-chain",
    },
    { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" } },
  );
}
