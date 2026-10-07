import { NextRequest, NextResponse } from "next/server";
import { validateSlabParam } from "@/lib/route-validators";
import * as Sentry from "@sentry/nextjs";
import {
  hasIndexerDb,
  queryTradesForCandles,
  queryLastTradePriceBefore,
  bucketCandles,
  fillCandleGaps,
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
 * Reads raw trades from the indexer's Postgres (INDEXER_DATABASE_URL) and buckets them into
 * OHLCV in-process. The percolator-api fallback is gone (that service is retired):
 *  - no indexer DB configured -> 404, which usePercolatorCandles treats as "no candle source on
 *    this deployment" and stops asking for the session
 *  - indexer DB query fails   -> 503 (retryable; the hook keeps any bars it already has)
 *
 * When the direct path returns < 10 bars, TradingChart falls back to the DEX
 * (GeckoTerminal) series automatically — no empty-state handling needed here.
 *
 * `&fill=1` (the chart's "Last" series only): a quiet market has minutes with no trade, and a
 * last-trade chart built from trades alone renders as scattered dashes with gaps. With fill, each
 * empty bucket carries the previous close (the last trade price IS unchanged until the next
 * trade), seeded from the last trade before `from` and extended to now. Other callers omit it
 * and get the trade buckets exactly as before.
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

  const bucketSeconds = RES_TO_SECONDS[resolution];
  if (!bucketSeconds) {
    return NextResponse.json(
      emptyUdf("error", `Unsupported resolution '${resolution}'`),
      { status: 400, headers: NO_STORE },
    );
  }
  if (!Number.isFinite(fromSec) || !Number.isFinite(toSec) || toSec <= fromSec) {
    return NextResponse.json(emptyUdf("error", "Invalid from/to"), { status: 400, headers: NO_STORE });
  }

  if (!hasIndexerDb()) {
    return NextResponse.json(
      emptyUdf("error", "Candles are not available on this deployment"),
      { status: 404, headers: NO_STORE },
    );
  }

  try {
    const rows = await queryTradesForCandles(validSlab, fromSec, toSec);
    let udf    = bucketCandles(rows, bucketSeconds);
    if (q.get("fill") === "1") {
      const seedClose = await queryLastTradePriceBefore(validSlab, fromSec);
      udf = fillCandleGaps(udf, bucketSeconds, {
        fromSec,
        toSec: Math.min(toSec, Math.floor(Date.now() / 1000)),
        seedClose,
      });
    }
    return NextResponse.json(udf, {
      headers: udf.s === "ok" ? SWR_CACHE : NO_STORE,
    });
  } catch (err) {
    console.error("[candles] indexer DB query failed:", err);
    Sentry.captureException(err, { tags: { endpoint: "/api/candles/[slab]", path: "indexer-db" } });
    return NextResponse.json(
      emptyUdf("error", "Candles temporarily unavailable"),
      { status: 503, headers: { ...NO_STORE, "Retry-After": "5" } },
    );
  }
}
