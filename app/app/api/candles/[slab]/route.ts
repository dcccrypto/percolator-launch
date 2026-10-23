import { NextRequest, NextResponse } from "next/server";
import { validateSlabParam } from "@/lib/route-validators";
import * as Sentry from "@sentry/nextjs";
import {
  hasIndexerDb,
  queryCandlesAggregated,
  queryLastTradePriceBefore,
  candleWindow,
  fillCandleGaps,
  emptyUdf,
  RES_TO_SECONDS,
} from "@/lib/indexer-db";

export const dynamic = "force-dynamic";

const NO_STORE  = { "Cache-Control": "private, no-store" } as const;
/** A window that reaches the forming bucket: new trades can still land in it. */
const LIVE_CACHE = { "Cache-Control": "public, max-age=10, s-maxage=10, stale-while-revalidate=30" } as const;
/**
 * A window whose last bucket closed: trades are stamped with their insert time, so nothing new can
 * land in it. Long at the edge (clients round from/to to the bucket, so the URL repeats).
 */
const HISTORICAL_CACHE = { "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400" } as const;
/** Indexer lag margin: a window that closed less than this long ago is still treated as live. */
const CLOSED_MARGIN_SEC = 120;

/**
 * GET /api/candles/[slab]?resolution=1|5|15|60|240|1D&from=<sec>&to=<sec>
 *
 * TradingView UDF response: { s, t, o, h, l, c, v }.
 *
 * Aggregates the indexer's trades into OHLCV IN POSTGRES (INDEXER_DATABASE_URL), so only bars
 * cross the wire (review E3: it used to pull up to 50,000 raw trades per call). `from`/`to` are
 * rounded to the bucket (the first and last buckets are complete), and closed historical windows
 * are cached at the edge. The percolator-api fallback is gone (that service is retired):
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
    const nowSec = Math.floor(Date.now() / 1000);
    const win = candleWindow(fromSec, toSec, bucketSeconds);
    const agg = await queryCandlesAggregated(validSlab, bucketSeconds, win.firstBucket, win.endExclusive);
    let udf = agg.udf;
    if (q.get("fill") === "1") {
      // A result at the bar ceiling has lost its OLDEST buckets: seeding from before `from` would draw
      // the old price flat across that lost stretch, a level that was not in force. Start at the first
      // bar we do hold instead. (Same rule as the old raw-row ceiling.)
      const seedClose = agg.truncated ? null : await queryLastTradePriceBefore(validSlab, win.firstBucket);
      udf = fillCandleGaps(udf, bucketSeconds, {
        fromSec: win.firstBucket,
        toSec: Math.min(toSec, nowSec),
        seedClose,
      });
    }
    if (udf.s === "error") return NextResponse.json(udf, { headers: NO_STORE });
    const closed = win.endExclusive + CLOSED_MARGIN_SEC <= nowSec;
    return NextResponse.json(udf, { headers: closed ? HISTORICAL_CACHE : LIVE_CACHE });
  } catch (err) {
    console.error("[candles] indexer DB query failed:", err);
    Sentry.captureException(err, { tags: { endpoint: "/api/candles/[slab]", path: "indexer-db" } });
    return NextResponse.json(
      emptyUdf("error", "Candles temporarily unavailable"),
      { status: 503, headers: { ...NO_STORE, "Retry-After": "5" } },
    );
  }
}
