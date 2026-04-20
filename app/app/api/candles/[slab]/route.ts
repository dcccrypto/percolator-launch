import { NextRequest, NextResponse } from "next/server";
import { getBackendUrl } from "@/lib/config";
import { validateSlabParam } from "@/lib/route-validators";
import * as Sentry from "@sentry/nextjs";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;
const SWR_CACHE = { "Cache-Control": "public, max-age=10, stale-while-revalidate=30" } as const;

/**
 * GET /api/candles/[slab]?resolution=1|5|15|60|240|1D&from=<sec>&to=<sec>
 *
 * Proxies the backend /candles/:slab endpoint. Response is TradingView UDF:
 *   { s: "ok"|"no_data"|"error", t: number[], o/h/l/c/v: number[] }
 *
 * Data source: Percolator's internal trades table (populated by the indexer
 * from on-chain match events via Atlas WS and webhook paths).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slab: string }> },
) {
  try {
    const { slab } = await params;
    const validation = validateSlabParam(slab);
    if (!validation.valid) return validation.response;
    const validSlab = validation.slab;

    const q = req.nextUrl.searchParams;
    const resolution = q.get("resolution") ?? "1";
    const from = q.get("from") ?? "0";
    const to = q.get("to") ?? String(Math.floor(Date.now() / 1000));

    const backendUrl = getBackendUrl();
    const upstream = `${backendUrl}/candles/${validSlab}?resolution=${encodeURIComponent(resolution)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

    const res = await fetch(upstream, {
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) {
      return NextResponse.json(
        { s: "error", errmsg: `Backend ${res.status}` },
        { status: res.status, headers: NO_STORE },
      );
    }

    const body = await res.json();
    const status = body?.s === "ok" ? 200 : 200;
    return NextResponse.json(body, {
      status,
      headers: body?.s === "ok" ? SWR_CACHE : NO_STORE,
    });
  } catch (err) {
    Sentry.captureException(err, { tags: { endpoint: "/api/candles/[slab]" } });
    return NextResponse.json(
      { s: "error", errmsg: "Failed to fetch candles" },
      { status: 502, headers: NO_STORE },
    );
  }
}
