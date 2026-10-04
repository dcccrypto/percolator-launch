/**
 * History assembly for GET /api/perp-chart/[slab] (mark / oracle series).
 * Pure over a CandleStore + backfill function, so the route stays a thin shell.
 */
import type { CandleStore, StoredCandle } from "./candle-store";
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
  /** 'live' = our own ticks; 'dex' = GeckoTerminal pool history (pre-launch backfill). */
  src: "live" | "dex";
}

export interface HistoryResult {
  bars: HistoryBar[];
  /**
   * For the mark series: bars with t < this come from the ORACLE series (pool price), because
   * there was no mark yet. null when every bar is a real mark.
   */
  proxyBeforeSec: number | null;
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

function toBar(c: StoredCandle): HistoryBar {
  return { t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: 0, src: c.src === "gecko" ? "dex" : "live" };
}

async function withBudget<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((r) => { timer = setTimeout(() => r(null), ms); });
  try { return await Promise.race([p, timeout]); } finally { if (timer) clearTimeout(timer); }
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
  // `to` is exclusive in the datafeed contract; a live request passes now+1.
  const read = async (s: TickSeries, before: number, n: number) => store.before(slab, s, res, before, n);

  let own = await read(series, toSec, limit);
  let oracle: StoredCandle[] = [];
  let proxyBeforeSec: number | null = null;
  let backfill: BackfillResult["status"] | null = null;

  const need = limit - own.length;
  if (need > 0) {
    // Not enough of our own history for this window: the oracle series (pool price) fills the older part.
    if (series === "mark") {
      const oldest = own.length > 0 ? own[0].t : toSec;
      oracle = await read("oracle", oldest, need);
      if (oracle.length < need) {
        const r = await withBudget(deps.backfill(slab, res), budget);
        backfill = r?.status ?? null;
        if (r?.status === "pulled") oracle = await read("oracle", oldest, need);
      }
      if (oracle.length > 0) proxyBeforeSec = oldest;
    } else {
      const r = await withBudget(deps.backfill(slab, res), budget);
      backfill = r?.status ?? null;
      if (r?.status === "pulled") own = await read(series, toSec, limit);
    }
  }

  const bars = [...oracle.map(toBar), ...own.map(toBar)].sort((a, b) => a.t - b.t);
  const stillShort = bars.length < limit;
  // Only claim "no more history" when the backfill actually ran (or is fresh): a rate-limited
  // or failed pull must not cap the chart at the few bars we happen to hold.
  const settled = backfill === "pulled" || backfill === "fresh" || backfill === "no-pool";
  return { bars, proxyBeforeSec, noMoreHistory: stillShort && settled, backfill };
}
