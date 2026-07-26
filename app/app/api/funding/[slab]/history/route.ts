import { type NextRequest, NextResponse } from "next/server";
import { proxyToApi } from "@/lib/api-proxy";
import { validateSlabParam } from "@/lib/route-validators";
import { BLOCKED_SLAB_ADDRESSES } from "@/lib/blocklist";
import { hasIndexerDb, queryFundingHistory } from "@/lib/indexer-db";

export const dynamic = "force-dynamic";

/**
 * Blocked slab set: hardcoded list + env var runtime overrides.
 * Mirrors the guard in /api/markets/route.ts and /api/funding/[slab]/route.ts.
 */
const BLOCKED_MARKET_ADDRESSES: ReadonlySet<string> = new Set([
  ...BLOCKED_SLAB_ADDRESSES,
  ...(process.env.BLOCKED_MARKET_ADDRESSES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
]);

const HISTORY_LIMIT_DEFAULT = 100;
const HISTORY_LIMIT_MAX     = 500;

/**
 * GET /api/funding/[slab]/history
 *
 * Read path (in priority order):
 *  1. Direct Postgres query when INDEXER_DATABASE_URL is set — reads from the
 *     v17 indexer's database (no Supabase SDK required, playground self-contained).
 *     Response shape matches what FundingRateChart.tsx expects:
 *       `timestamp` is unix milliseconds (number), not an ISO string.
 *       `hourlyRatePercent` is pre-computed (rateBpsPerSlot * 9000 / 100).
 *  2. Proxy to percolator-api (Railway) — legacy path when the indexer DB is
 *     not configured.
 *
 * GH#1357: Return 404 for blocklisted slabs.
 * MEDIUM-003: slab parameter validation.
 *
 * REDUCED SCHEMA (2026-07): `funding_history` was dropped from the indexer DB
 * (history-only reduction) — queryFundingHistory() is now a stable no-op that
 * always returns []. The direct-Postgres branch below therefore always yields
 * an empty `history: []` payload rather than erroring; the current funding
 * rate should be read live from chain, not from this historical series.
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

  if (BLOCKED_MARKET_ADDRESSES.has(validSlab)) {
    return NextResponse.json(
      { error: "Market not found" },
      { status: 404 }
    );
  }

  // Parse query params
  const qs = req.nextUrl.searchParams;
  const sinceParam = qs.get("since") ?? undefined;
  const limitRaw   = qs.get("limit");
  const limit = limitRaw
    ? Math.min(Math.max(1, parseInt(limitRaw, 10) || HISTORY_LIMIT_DEFAULT), HISTORY_LIMIT_MAX)
    : HISTORY_LIMIT_DEFAULT;

  // Direct Postgres path — used when the v17 indexer DB is configured.
  if (hasIndexerDb()) {
    try {
      // Normalise `since` to an ISO string (accept epoch seconds, epoch ms, or ISO 8601)
      let sinceIso: string | undefined;
      if (sinceParam) {
        const num = Number(sinceParam);
        if (!Number.isNaN(num) && num > 0) {
          const ms  = num > 1e12 ? num : num * 1000;
          sinceIso  = new Date(ms).toISOString();
        } else {
          const d = new Date(sinceParam);
          if (!Number.isNaN(d.getTime())) sinceIso = d.toISOString();
        }
      }

      const points = await queryFundingHistory(validSlab, limit, sinceIso);

      return NextResponse.json(
        {
          slabAddress: validSlab,
          count:   points.length,
          history: points.map((p) => ({
            // Fields used by FundingRateChart.tsx
            timestamp:         p.timestamp,         // unix ms (number)
            hourlyRatePercent: p.hourlyRatePercent, // pre-computed
            // Extra fields (informational / future use)
            slot:              p.slot,
            rateBpsPerSlot:    p.rateBpsPerSlot,
            netLpPos:          p.netLpPos,
            priceE6:           p.priceE6,
            fundingIndexQpbE6: p.fundingIndexQpbE6,
          })),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (err) {
      console.error("[funding/history] indexer DB query failed, falling through to proxy:", err);
    }
  }

  return proxyToApi(req, `/funding/${validSlab}/history`);
}
