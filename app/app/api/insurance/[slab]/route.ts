import { NextResponse } from "next/server";
import { parseWrapperConfigV17, V17_HEADER_LEN } from "@percolatorct/sdk";
import { validateSlabParam } from "@/lib/route-validators";
import { isBlockedSlab } from "@/lib/blocklist";
import { readCurrentWrapperSlab } from "@/lib/current-wrapper-slab";
import { sanitizeOnChainValue } from "@/lib/health";
import { isUnsupportedLayout, parseMarketOI, unsupportedLayoutBody } from "@/lib/v22/layout";

export const dynamic = "force-dynamic";

/** Mark prices above this (micro-USD) are an unset sentinel, not a price (lib/live-market-state). */
const MAX_SANE_PRICE_E6 = 1_000_000_000_000n;

/**
 * GET /api/insurance/[slab] — the market's insurance fund (InsuranceDashboard).
 *
 * Was a proxy to percolator-api (retired: "Application not found"). Now read from the slab:
 *   balance    insurance balance, collateral atoms (parseMarketGroupV17OI);
 *   totalRisk  open interest valued at the mark, collateral atoms (OI is engine Q, 1e6-scaled
 *              base units: atoms = OI_Q * markE6 / 1e6), so coverage = balance / totalRisk is a
 *              ratio of like units; "0" when there is no mark yet;
 *   feeRevenue / dailyAccumulationRate / historicalBalance: no on-chain or indexer source on v18
 *              (the history tables were dropped), so they are "0" / 0 / [] — never invented.
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
  let balance: bigint;
  let oiQ: bigint;
  try {
    const oi = parseMarketOI(read.data);
    balance = sanitizeOnChainValue(oi.insuranceBalance);
    oiQ = sanitizeOnChainValue(oi.totalLongOiQ) + sanitizeOnChainValue(oi.totalShortOiQ);
  } catch (e) {
    if (isUnsupportedLayout(e)) return NextResponse.json(unsupportedLayoutBody(e), { status: 422 });
    return NextResponse.json({ error: "Market data unreadable" }, { status: 404 });
  }
  let markE6 = 0n;
  try {
    const e6 = parseWrapperConfigV17(read.data, V17_HEADER_LEN).markEwmaE6;
    if (e6 > 0n && e6 < MAX_SANE_PRICE_E6) markE6 = e6;
  } catch {
    markE6 = 0n;
  }
  const totalRisk = (oiQ * markE6) / 1_000_000n;
  return NextResponse.json(
    {
      slabAddress: v.slab,
      balance: balance.toString(),
      totalRisk: totalRisk.toString(),
      totalOpenInterestQ: oiQ.toString(),
      // No on-chain or indexer source on v18: null (unknown), never an invented 0.
      feeRevenue: null,
      dailyAccumulationRate: null,
      historicalBalance: [],
      source: "on-chain",
    },
    { headers: { "Cache-Control": "public, s-maxage=15, stale-while-revalidate=60" } },
  );
}
