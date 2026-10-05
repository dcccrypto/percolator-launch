/**
 * History assembly for GET /api/perp-chart/[slab] (mark / oracle series).
 * Pure over a CandleStore + backfill function, so the route stays a thin shell.
 */
import type { CandleStore, StoredCandle } from "./candle-store";
import { bucketStartSec } from "./candles";
import type { BackfillResult } from "./gecko-backfill";
import type { CandleResMinutes, TickSeries } from "./perp-types";

export interface HistoryBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Always 0 for tick series: they have no volume. Kept so the shape matches the UDF bars. */
  v: number;
  /** 'live' = our own ticks; 'chain' = mark rebuilt from PushAuthMark txs (a real mark); 'dex' = GeckoTerminal pool history. */
  src: "live" | "chain" | "dex";
  /**
   * Mark series only: this bar is the ORACLE (pool) price standing in for a bucket that has no mark
   * (before the first mark, in a gap between the Gecko history and the live feed, or while the
   * on-chain backfill has not reached it yet). Absent on real marks.
   */
  proxy?: true;
  /** True when the bar was rolled up from a finer resolution because none was stored at this one. */
  derived?: true;
  /**
   * Flat carry-forward bar (o=h=l=c=previous close) for a bucket in which the pool had no trade, so
   * GeckoTerminal published no candle. The price genuinely did not move; only dex bars get these.
   */
  flat?: true;
}

export interface HistoryResult {
  bars: HistoryBar[];
  /**
   * For the mark series: the end (exclusive) of the newest stretch of bars that come from the ORACLE
   * series (pool price) because there was no mark. null when every bar is a real mark.
   */
  proxyBeforeSec: number | null;
  /** Open time of the oldest stand-in bar (null when none). With proxyBeforeSec it brackets the pool-price part. */
  proxyFromSec: number | null;
  /** True when nothing older exists (or can be fetched), so the chart stops paging back. */
  noMoreHistory: boolean;
  backfill: BackfillResult["status"] | null;
}

export interface HistoryDeps {
  store: CandleStore;
  backfill(slab: string, res: CandleResMinutes): Promise<BackfillResult>;
  /** Max time to wait for a first-ever backfill before answering with what exists. */
  backfillBudgetMs?: number;
}

type SrcBar = StoredCandle & { derived?: true };

function toBar(c: SrcBar, proxy: boolean): HistoryBar {
  const bar: HistoryBar = { t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: 0, src: c.src === "gecko" ? "dex" : c.src };
  if (proxy) bar.proxy = true;
  if (c.derived) bar.derived = true;
  return bar;
}

async function withBudget<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((r) => { timer = setTimeout(() => r(null), ms); });
  try { return await Promise.race([p, timeout]); } finally { if (timer) clearTimeout(timer); }
}

/** The next finer stored resolution a bucket can be rolled up from. */
const FINER: Record<CandleResMinutes, CandleResMinutes | null> = { 1: null, 5: 1, 15: 5, 60: 15, 240: 60, 1440: 240 };
const RANGE_CAP = 20_000;

/** Roll finer bars up into `res` buckets, keeping the source of the newest finer bar. */
function aggregate(fine: readonly StoredCandle[], res: CandleResMinutes): SrcBar[] {
  const out: SrcBar[] = [];
  for (const c of fine) {
    const t = bucketStartSec(c.t, res);
    const last = out[out.length - 1];
    if (last && last.t === t) {
      last.h = Math.max(last.h, c.h);
      last.l = Math.min(last.l, c.l);
      last.c = c.c;
      last.n += c.n;
      last.src = c.src;
    } else {
      out.push({ t, o: c.o, h: c.h, l: c.l, c: c.c, n: c.n, src: c.src, derived: true });
    }
  }
  return out;
}

/**
 * Every bar of (series, res) with from <= t < to. A bucket with no stored bar at this resolution is
 * rolled up from the finer resolutions (recursively), so a series that was only written at some
 * resolutions (Gecko pulls only the resolutions somebody opened; a half-finished backfill) still has
 * continuous history at every resolution. A stored bar always wins over a derived one.
 */
async function fillRange(store: CandleStore, slab: string, series: TickSeries, res: CandleResMinutes, from: number, to: number): Promise<SrcBar[]> {
  const step = res * 60;
  const first = Math.max(0, Math.ceil(from / step) * step);
  if (first >= to) return [];
  const have: SrcBar[] = await store.range(slab, series, res, first, to, RANGE_CAP);
  const finer = FINER[res];
  if (!finer) return have;
  const present = new Set(have.map((c) => c.t));
  const spans: Array<[number, number]> = [];
  let open: number | null = null;
  for (let t = first; t < to; t += step) {
    if (!present.has(t)) { if (open === null) open = t; } else if (open !== null) { spans.push([open, t]); open = null; }
  }
  if (open !== null) spans.push([open, Math.ceil(to / step) * step]);
  if (spans.length === 0) return have;
  const derived: SrcBar[] = [];
  for (const [a, b] of spans) {
    const fine = await fillRange(store, slab, series, finer, a, b);
    for (const c of aggregate(fine, res)) if (c.t >= a && c.t < b && !present.has(c.t)) derived.push(c);
  }
  return [...have, ...derived].sort((x, y) => x.t - y.t);
}

/**
 * The newest `limit` bars of (series, res) before `toSec`, derived-filled. The window widens (x4,
 * twice) while it holds fewer than `limit` bars, then whatever older stored bars exist are appended,
 * so a hole in the data never stops the chart from paging back past it.
 */
async function collect(store: CandleStore, slab: string, series: TickSeries, res: CandleResMinutes, toSec: number, limit: number): Promise<SrcBar[]> {
  const step = res * 60;
  let span = limit;
  let from = 0;
  let bars: SrcBar[] = [];
  for (let attempt = 0; attempt < 3; attempt++, span *= 4) {
    from = Math.max(0, toSec - span * step);
    const prev = bars.length;
    bars = await fillRange(store, slab, series, res, from, toSec);
    if (bars.length >= limit || from === 0 || (attempt > 0 && bars.length === prev)) break;
  }
  if (bars.length < limit && from > 0) {
    const older = await store.before(slab, series, res, from, limit - bars.length);
    bars = [...older, ...bars];
  }
  return bars.slice(-limit);
}

/** A Gecko hole is carried forward only when it is short: 6 hours of buckets (at least 1). */
const FLAT_MAX_SEC = 6 * 3600;

/** Fill the interior no-trade holes of pool-price (dex) history with flat bars. Never extends past either end. */
function fillFlat(bars: HistoryBar[], res: CandleResMinutes, proxyKind: boolean): HistoryBar[] {
  const step = res * 60;
  const cap = Math.max(1, Math.floor(FLAT_MAX_SEC / step));
  const out: HistoryBar[] = [];
  for (let i = 0; i < bars.length; i++) {
    const a = bars[i];
    out.push(a);
    const b = bars[i + 1];
    if (!b || a.src !== "dex") continue;
    const holes = (b.t - a.t) / step - 1;
    if (holes < 1 || holes > cap) continue;
    for (let t = a.t + step; t < b.t; t += step) {
      const f: HistoryBar = { t, o: a.c, h: a.c, l: a.c, c: a.c, v: 0, src: "dex", flat: true };
      if (proxyKind) f.proxy = true;
      out.push(f);
    }
  }
  return out;
}

function contiguous(bars: readonly SrcBar[], res: CandleResMinutes): boolean {
  for (let i = 1; i < bars.length; i++) if (bars[i].t - bars[i - 1].t !== res * 60) return false;
  return true;
}

export async function loadHistory(
  slab: string,
  series: TickSeries,
  res: CandleResMinutes,
  toSec: number,
  limit: number,
  deps: HistoryDeps,
): Promise<HistoryResult> {
  const { store } = deps;
  const budget = deps.backfillBudgetMs ?? 5_000;
  const step = res * 60;

  let own = await collect(store, slab, series, res, toSec, limit);
  let oracle: SrcBar[] = [];
  let backfill: BackfillResult["status"] | null = null;

  // The pool-price stand-in, merged bucket by bucket: a real mark always wins, the oracle fills EVERY
  // bucket that has no mark (not just those before the first mark).
  const merge = (): HistoryBar[] => {
    const byT = new Map<number, HistoryBar>();
    for (const c of oracle) byT.set(c.t, toBar(c, true));
    for (const c of own) byT.set(c.t, toBar(c, false));
    return fillFlat([...byT.values()].sort((a, b) => a.t - b.t), res, series === "mark").slice(-limit);
  };

  if (series === "mark") {
    // A full, unbroken run of real marks needs no stand-in (the hot live-tail path stays one read).
    const complete = own.length >= limit && contiguous(own, res) && own[own.length - 1].t >= toSec - 2 * step;
    if (!complete) {
      oracle = await collect(store, slab, "oracle", res, toSec, limit);
      if (merge().length < limit) {
        const r = await withBudget(deps.backfill(slab, res), budget);
        backfill = r?.status ?? null;
        if (r?.status === "pulled") oracle = await collect(store, slab, "oracle", res, toSec, limit);
      }
    }
  } else if (own.length < limit) {
    const r = await withBudget(deps.backfill(slab, res), budget);
    backfill = r?.status ?? null;
    if (r?.status === "pulled") own = await collect(store, slab, series, res, toSec, limit);
  }

  const bars = merge();
  const proxyBars = bars.filter((b) => b.proxy);
  const proxyBeforeSec = proxyBars.length ? proxyBars[proxyBars.length - 1].t + step : null;
  const proxyFromSec = proxyBars.length ? proxyBars[0].t : null;
  const stillShort = bars.length < limit;
  // Only claim "no more history" when the backfill actually ran (or is fresh): a rate-limited
  // or failed pull must not cap the chart at the few bars we happen to hold.
  const settled = backfill === "pulled" || backfill === "fresh" || backfill === "no-pool";
  return { bars, proxyBeforeSec, proxyFromSec, noMoreHistory: stillShort && settled, backfill };
}
