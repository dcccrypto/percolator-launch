import { type NextRequest, NextResponse } from "next/server";
import { validateNumericParam, validateSlabParam } from "@/lib/route-validators";
import { hasIndexerDb, queryTrades } from "@/lib/indexer-db";

export const dynamic = "force-dynamic";

/** Row cap for GET /markets/:slab/trades (the TradeHistory tape asks for 25). */
const TRADES_LIMIT_MAX = 200;

/**
 * GET /api/markets/[slab]/trades
 *
 * Read from the indexer's Postgres (INDEXER_DATABASE_URL) — the only store of trades.
 * The percolator-api fallback is gone (that service is retired: "Application not found"):
 *  - no indexer DB configured -> 404 (this deployment has no trade tape)
 *  - indexer DB query fails   -> 503 (retryable)
 * TradeHistory keeps its last-good rows on a non-OK answer and shows its "unavailable" state
 * when it has none, so neither answer invents an empty tape.
 *
 * **Slab:** `validateSlabParam` (base58 pubkey) — parameterised in the SQL query,
 * never concatenated. **`limit`:** optional, integers **1–200**; invalid → 400.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slab: string }> }
) {
  const { slab } = await params;

  // Validate slab parameter format
  const validation = validateSlabParam(slab);
  if (!validation.valid) {
    return validation.response;
  }
  const validSlab = validation.slab;

  const limitRaw = req.nextUrl.searchParams.get("limit");
  let limit = 25;
  if (limitRaw !== null) {
    const lim = validateNumericParam(limitRaw, { min: 1, max: TRADES_LIMIT_MAX });
    if (!lim.valid) {
      return lim.response;
    }
    limit = lim.value;
  }

  if (!hasIndexerDb()) {
    return NextResponse.json(
      { error: "Trade history is not available on this deployment" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const trades = await queryTrades(validSlab, limit);
    // Review E5: TradeHistory polls this every 15 s per open tab; a 2 s edge copy collapses the
    // viewers of one market onto one indexer read without delaying a fill noticeably.
    return NextResponse.json({ trades }, { headers: { "Cache-Control": "public, s-maxage=2, stale-while-revalidate=10" } });
  } catch (err) {
    console.error("[trades] indexer DB query failed:", err);
    return NextResponse.json(
      { error: "Trade history temporarily unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "5" } },
    );
  }
}
