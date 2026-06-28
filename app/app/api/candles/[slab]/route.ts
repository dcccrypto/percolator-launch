import { NextRequest, NextResponse } from "next/server";
import { getBackendUrl } from "@/lib/config";
import { validateSlabParam } from "@/lib/route-validators";
import * as Sentry from "@sentry/nextjs";
import {
  hasIndexerDb,
  queryTradesForCandles,
  bucketCandles,
  emptyUdf,
  RES_TO_SECONDS,
} from "@/lib/indexer-db";

export const dynamic = "force-dynamic";

const NO_STORE  = { "Cache-Control": "private, no-store" } as const;
const SWR_CACHE = { "Cache-Control": "public, max-age=10, stale-while-revalidate=30" } as const;

/**
 * GET /api/candles/[slab]?resolution=1|5|15|60|240|1D&from=<sec>&to=<sec>
 *
 * TradingView UDF response: { s, t, o, h, l, c, v }.
 *
 * Read path (in priority order):
 *  1. Direct Postgres query when INDEXER_DATABASE_URL is set — reads raw trades
 *     from the v17 indexer's database and buckets them into OHLCV in-process
 *     (same algorithm as percolator-api/src/routes/candles.ts).
 *  2. Proxy to percolator-api backend — legacy path when the indexer DB is not set.
 *
 * When the direct path returns < 10 bars, usePercolatorCandles falls back to
 * Pyth chart data automatically — no empty-state handling needed here.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slab: string }> },
) {
  const { slab } = await params;
  const validation = validateSlabParam(slab);
  if (!validation.valid) return validation.response;
  const validSlab = validation.slab;

  const q          = req.nextUrl.searchParams;
  const resolution = q.get("resolution") ?? "1";
  const fromSec    = parseInt(q.get("from") ?? "0", 10);
  const toSec      = parseInt(q.get("to") ?? String(Math.floor(Date.now() / 1000)), 10);

  // Direct Postgres path — available when v17 indexer DB is configured.
  if (hasIndexerDb()) {
    try {
      const bucketSeconds = RES_TO_SECONDS[resolution];
      if (!bucketSeconds) {
        return NextResponse.json(
          emptyUdf("error", `Unsupported resolution '${resolution}'`),
          { status: 400, headers: NO_STORE },
        );
      }
      if (!Number.isFinite(fromSec) || !Number.isFinite(toSec) || toSec <= fromSec) {
        return NextResponse.json(
          emptyUdf("error", "Invalid from/to"),
          { status: 400, headers: NO_STORE },
        );
      }

      const rows = await queryTradesForCandles(validSlab, fromSec, toSec);
      const udf  = bucketCandles(rows, bucketSeconds);
      return NextResponse.json(udf, {
        headers: udf.s === "ok" ? SWR_CACHE : NO_STORE,
      });
    } catch (err) {
      console.error("[candles] indexer DB query failed, falling through to proxy:", err);
      Sentry.captureException(err, { tags: { endpoint: "/api/candles/[slab]", path: "indexer-db" } });
    }
  }

  // Proxy path — forwards to percolator-api (Railway).
  try {
    const backendUrl = getBackendUrl();
    const upstream   = `${backendUrl}/candles/${validSlab}?resolution=${encodeURIComponent(resolution)}&from=${encodeURIComponent(String(fromSec))}&to=${encodeURIComponent(String(toSec))}`;

    const res = await fetch(upstream, {
      headers: { "Content-Type": "application/json" },
      signal:  AbortSignal.timeout(5_000),
    });

    if (!res.ok) {
      return NextResponse.json(
        { s: "error", errmsg: `Backend ${res.status}` },
        { status: res.status, headers: NO_STORE },
      );
    }

    const body = await res.json();
    return NextResponse.json(body, {
      headers: body?.s === "ok" ? SWR_CACHE : NO_STORE,
    });
  } catch (err) {
    Sentry.captureException(err, { tags: { endpoint: "/api/candles/[slab]", path: "proxy" } });
    return NextResponse.json(
      { s: "error", errmsg: "Failed to fetch candles" },
      { status: 502, headers: NO_STORE },
    );
  }
}
