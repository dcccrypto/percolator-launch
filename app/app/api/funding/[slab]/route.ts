import { NextResponse } from "next/server";

/**
 * GET /api/funding/[slab]
 *
 * Stub route — the FundingRateCard component falls back to on-chain data
 * via useEngineState() when this fails. Returning a minimal valid response
 * prevents 404 spam in the console while the real funding API is built.
 */
export async function GET() {
  return NextResponse.json({
    currentRateBpsPerSlot: 0,
    hourlyRatePercent: 0,
    aprPercent: 0,
    direction: "neutral",
    nextFundingSlot: 0,
    netLpPosition: "0",
    currentSlot: 0,
  });
}
