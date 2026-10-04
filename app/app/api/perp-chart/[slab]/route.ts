import { type NextRequest, NextResponse } from "next/server";
import { validateSlabParam } from "@/lib/route-validators";
import { isBlockedSlab } from "@/lib/blocklist";
import { registeredPoolForSlab } from "@/lib/registered-pool";
import { getPgCandleStore } from "@/lib/chart/pg-store";
import { ensureOracleBackfill } from "@/lib/chart/gecko-backfill";
import { loadHistory, type HistoryResult } from "@/lib/chart/history";
import { isTickSeries, resolutionToMinutes } from "@/lib/chart/perp-types";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
/** The live tail is shared by every viewer of a market: one DB read per second is plenty. */
const TAIL_CACHE = { "Cache-Control": "public, s-maxage=1, stale-while-revalidate=4" } as const;
/** A page that ends well in the past is closed history. */
const PAST_CACHE = { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=900" } as const;

const MAX_BARS = 1_500;
const memo = new Map<string, { at: number; p: Promise<HistoryResult> }>();
const MEMO_MS = 1_000;

/**
 * GET /api/perp-chart/[slab]?series=mark|oracle&resolution=1|5|15|60|240|1D&to=<sec>&countBack=<n>
 *
 * History of the market's own MARK or ORACLE candles (the perp chart), newest `countBack` bars
 * ending before `to`. The live forming candle is NOT served here: the browser builds it from the
 * pushed ticks (price-ws) and repairs gaps with the tick replay.
 * `last` (last trade) is served by /api/candles/[slab].
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ slab: string }> }) {
  const { slab } = await params;
  const v = validateSlabParam(slab);
  if (!v.valid) return v.response;
  if (isBlockedSlab(v.slab)) return NextResponse.json({ error: "Market not found" }, { status: 404, headers: NO_STORE });

  const q = req.nextUrl.searchParams;
  const series = q.get("series") ?? "mark";
  if (!isTickSeries(series)) {
    return NextResponse.json({ error: "series must be mark or oracle" }, { status: 400, headers: NO_STORE });
  }
  const res = resolutionToMinutes(q.get("resolution") ?? "1");
  if (res === null) return NextResponse.json({ error: "unsupported resolution" }, { status: 400, headers: NO_STORE });

  const nowSec = Math.floor(Date.now() / 1000);
  const toRaw = parseInt(q.get("to") ?? "", 10);
  const toSec = Number.isFinite(toRaw) && toRaw > 0 ? Math.min(toRaw, nowSec + 1) : nowSec + 1;
  const cbRaw = parseInt(q.get("countBack") ?? "", 10);
  const limit = Number.isFinite(cbRaw) ? Math.min(Math.max(cbRaw, 1), MAX_BARS) : 300;

  const store = getPgCandleStore();
  if (!store) {
    return NextResponse.json({ error: "chart history store is not configured" }, { status: 503, headers: NO_STORE });
  }

  const key = `${v.slab}|${series}|${res}|${Math.floor(toSec / 5)}|${limit}`;
  const cached = memo.get(key);
  let p: Promise<HistoryResult>;
  if (cached && Date.now() - cached.at < MEMO_MS) {
    p = cached.p;
  } else {
    p = loadHistory(v.slab, series, res, toSec, limit, {
      store,
      backfill: (slabAddr, r) =>
        ensureOracleBackfill(slabAddr, r, {
          store,
          poolForSlab: async (s) => (await registeredPoolForSlab(s))?.pool ?? null,
        }),
    });
    if (memo.size > 200) memo.delete(memo.keys().next().value as string);
    memo.set(key, { at: Date.now(), p });
  }

  try {
    const h = await p;
    const headers = toSec < nowSec - 600 ? PAST_CACHE : TAIL_CACHE;
    return NextResponse.json(
      { s: h.bars.length > 0 ? "ok" : "no_data", series, resolution: q.get("resolution") ?? "1", ...h },
      { headers },
    );
  } catch (err) {
    memo.delete(key);
    console.error("[perp-chart] history failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "history unavailable" }, { status: 502, headers: NO_STORE });
  }
}
