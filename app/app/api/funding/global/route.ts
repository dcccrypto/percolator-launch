import { type NextRequest, NextResponse } from "next/server";
import { proxyToApi } from "@/lib/api-proxy";
import { isBlockedSlab } from "@/lib/blocklist";
import { hasIndexerDb, queryFundingGlobal } from "@/lib/indexer-db";

export const dynamic = "force-dynamic";

/**
 * Re-exported for backwards-compat: components that import this type from this
 * route module continue to compile after the route became a proxy (GH#1066).
 */
export interface FundingGlobalEntry {
  slabAddress: string;
  baseSymbol: string | null;
  // GH#funding-display: this route is a thin proxy (GH#1066) — the primary
  // path forwards percolator-api's GET /funding/global response verbatim,
  // which uses `currentRateBpsPerSlot`. The local indexer-db fallback path
  // (queryFundingGlobal in lib/indexer-db.ts) uses `rateBpsPerSlot` instead.
  // Both are optional here so consumers must read whichever is present
  // rather than assuming one name always exists.
  rateBpsPerSlot?: number;
  currentRateBpsPerSlot?: number;
  hourlyRatePercent: number;
  dailyRatePercent: number;
  dailyRateAbs?: number;
  netLpPos?: number;
}

/**
 * GET /api/funding/global
 *
 * Primary path: proxy to percolator-api GET /funding/global.
 * Fallback (playground / Railway dead): read latest funding rate per market
 * from the local indexer Postgres (INDEXER_DATABASE_URL).
 * Returns graceful {} if both unavailable.
 *
 * GH#1461: blocked slabs are stripped from the response at this layer.
 */
export async function GET(req: NextRequest) {
  // ── 1. Try Railway proxy ───────────────────────────────────────────────────
  let upstream: Response | null = null;
  try {
    upstream = await proxyToApi(req, "/funding/global");
  } catch {
    // proxyToApi itself shouldn't throw but guard anyway
  }

  if (upstream && upstream.ok) {
    let data: Record<string, unknown>;
    try {
      data = await upstream.clone().json();
    } catch {
      return upstream as unknown as NextResponse;
    }

    // Strip blocked slabs
    if (Array.isArray(data.markets)) {
      const filtered = (data.markets as Array<{ slabAddress?: string }>).filter(
        (m) => !isBlockedSlab(m.slabAddress)
      );
      data = { ...data, markets: filtered, count: filtered.length };
    }

    const upstreamCacheControl =
      upstream.headers.get("Cache-Control") ?? "no-store, max-age=0";

    return NextResponse.json(data, {
      status: upstream.status,
      headers: { "Cache-Control": upstreamCacheControl },
    });
  }

  // ── 2. Fallback: local indexer Postgres ────────────────────────────────────
  if (hasIndexerDb()) {
    try {
      const rows = await queryFundingGlobal();
      const markets: FundingGlobalEntry[] = rows
        .filter((r) => !isBlockedSlab(r.slabAddress))
        .map((r) => ({
          slabAddress: r.slabAddress,
          baseSymbol: null,
          rateBpsPerSlot: r.rateBpsPerSlot,
          hourlyRatePercent: r.hourlyRatePercent,
          dailyRatePercent: r.dailyRatePercent,
          netLpPos: r.netLpPos,
        }));
      return NextResponse.json(
        { markets, count: markets.length },
        { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" } },
      );
    } catch (err) {
      console.warn("[funding/global] indexer-db fallback failed:", err instanceof Error ? err.message : String(err));
    }
  }

  // ── 3. Graceful empty response ─────────────────────────────────────────────
  return NextResponse.json(
    { markets: [], count: 0 },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
