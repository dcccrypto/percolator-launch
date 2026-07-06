import { type NextRequest, NextResponse } from "next/server";
import { proxyToApi } from "@/lib/api-proxy";
import { validateNumericParam, validateSlabParam } from "@/lib/route-validators";
import { hasIndexerDb, queryTrades } from "@/lib/indexer-db";

export const dynamic = "force-dynamic";

/** Matches percolator-api / README contract for GET /markets/:slab/trades */
const TRADES_LIMIT_MAX = 200;

/**
 * GET /api/markets/[slab]/trades
 *
 * Read path (in priority order):
 *  1. Direct Postgres query when INDEXER_DATABASE_URL is set — reads from the
 *     v17 indexer's database (no Supabase SDK required, playground self-contained).
 *  2. Proxy to percolator-api (Railway) — legacy path when the indexer DB is
 *     not configured.
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

  const qs = new URLSearchParams(req.nextUrl.searchParams);
  const limitRaw = qs.get("limit");
  let limit = 25;
  if (limitRaw !== null) {
    const lim = validateNumericParam(limitRaw, { min: 1, max: TRADES_LIMIT_MAX });
    if (!lim.valid) {
      return lim.response;
    }
    limit = lim.value;
    qs.set("limit", String(lim.value));
  }

  // Direct Postgres path — used when the v17 indexer DB is configured.
  if (hasIndexerDb()) {
    try {
      const trades = await queryTrades(validSlab, limit);
      return NextResponse.json(
        { trades },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (err) {
      // Log and fall through to proxy so a misconfigured INDEXER_DATABASE_URL
      // doesn't silently break the trade history table.
      console.error("[trades] indexer DB query failed, falling through to proxy:", err);
    }
  }

  return proxyToApi(req, `/markets/${validSlab}/trades`, undefined, {
    queryString: qs.toString(),
  });
}
