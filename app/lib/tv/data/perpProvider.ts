/**
 * ChartDataProvider #2: the perp-standard chart (Mark / Oracle / Last), push-fed.
 *
 *   mark / oracle  history  GET /api/perp-chart/:slab (our own persisted candles, pool-price
 *                           backfill before the first mark)
 *                  live     keeper ticks over the price-ws socket (lib/chart/live-client.ts),
 *                           folded into the forming candle with the SAME pure code the server uses
 *   last           history  the wrapped base provider (/api/candles/:slab, indexer trades)
 *                  live     `trade` messages from the same socket
 *
 * Wraps a base provider for symbol metadata and last-trade history, so the TradingView datafeed
 * (#2983) and the lightweight-charts PerpChart share this ONE implementation. Switching series
 * calls the live handlers' onReset(), which makes the chart refetch history for the new series.
 */
import { foldTick } from "@/lib/chart/candles";
import type { LiveClient } from "@/lib/chart/live-client";
import { resolutionToMinutes, type PerpSeries } from "@/lib/chart/perp-types";
import type { SeriesStore } from "@/lib/chart/perp-series";
import { REPLAY_WINDOW_MS } from "@/lib/chart/tick-hub";
import {
  applyTrade,
  type BarSource,
  type BarsPage,
  type BarsRequest,
  type ChartDataProvider,
  type ChartSymbolMeta,
  type LiveHandlers,
  type ProviderBar,
  type ProviderResolution,
} from "./provider";

type FetchLike = (input: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface PerpProviderDeps {
  base: ChartDataProvider;
  live: LiveClient;
  fetchImpl: FetchLike;
  series: SeriesStore;
  now?: () => number;
}

export function sourceForSeries(s: PerpSeries): BarSource {
  return s === "mark" ? "perp-mark" : s === "oracle" ? "perp-oracle" : "percolator";
}

interface HistoryBody {
  s?: unknown;
  bars?: unknown;
  proxyBeforeSec?: unknown;
  noMoreHistory?: unknown;
}

export function parsePerpHistory(body: unknown): { bars: ProviderBar[]; proxyBeforeSec: number | null; noMoreHistory: boolean; dexThroughSec: number | null } {
  if (typeof body !== "object" || body === null) throw new Error("perp-chart: malformed response");
  const b = body as HistoryBody;
  const raw = Array.isArray(b.bars) ? b.bars : [];
  const bars: ProviderBar[] = [];
  let dexThroughSec: number | null = null;
  for (const x of raw) {
    if (typeof x !== "object" || x === null) continue;
    const r = x as Record<string, unknown>;
    const bar = { timeSec: Number(r.t), open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c), volume: 0 };
    if ([bar.timeSec, bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) && bar.open > 0 && bar.high > 0 && bar.low > 0 && bar.close > 0) {
      bars.push(bar);
      if (r.src === "dex" && (dexThroughSec === null || bar.timeSec > dexThroughSec)) dexThroughSec = bar.timeSec;
    }
  }
  bars.sort((a, c) => a.timeSec - c.timeSec);
  const proxy = typeof b.proxyBeforeSec === "number" && Number.isFinite(b.proxyBeforeSec) ? b.proxyBeforeSec : null;
  return { bars, proxyBeforeSec: proxy, noMoreHistory: b.noMoreHistory === true, dexThroughSec };
}

function toCandle(b: ProviderBar) {
  return { t: b.timeSec, o: b.open, h: b.high, l: b.low, c: b.close, n: 1 };
}

export function createPerpProvider(deps: PerpProviderDeps): ChartDataProvider {
  const { base, live, fetchImpl, series } = deps;
  const now = deps.now ?? Date.now;

  return {
    id: "perp-push",

    async resolveSymbol(slab: string): Promise<ChartSymbolMeta> {
      const m = await base.resolveSymbol(slab);
      return { ...m, hasVolume: series.get() === "last" && m.hasVolume };
    },

    async getBars(req: BarsRequest): Promise<BarsPage> {
      const s = series.get();
      if (s === "last") {
        const page = await base.getBars(req);
        // No trades yet is an honest empty "Last" chart, not a mark-built stand-in.
        return page.bars.length === 0 ? { bars: [], noMoreHistory: true, source: "percolator" } : page;
      }
      const url =
        `/api/perp-chart/${encodeURIComponent(req.slab)}?series=${s}&resolution=${req.resolution}` +
        `&to=${Math.floor(req.toSec)}&countBack=${Math.max(300, Math.floor(req.countBack))}`;
      const source = sourceForSeries(s);
      let r;
      try {
        r = await fetchImpl(url);
      } catch (err) {
        if (!req.firstRequest) throw err;
        return { bars: [], noMoreHistory: true, source }; // the live ticks still build the chart
      }
      if (r.status === 503 || r.status === 404) return { bars: [], noMoreHistory: true, source };
      if (!r.ok) {
        if (!req.firstRequest) throw new Error(`perp-chart HTTP ${r.status}`);
        return { bars: [], noMoreHistory: true, source };
      }
      const h = parsePerpHistory(await r.json());
      const bars = h.bars.filter((b) => b.timeSec >= req.fromSec - 1 || req.countBack > 0);
      return { bars, noMoreHistory: h.noMoreHistory, source, proxyBeforeSec: h.proxyBeforeSec, dexThroughSec: h.dexThroughSec };
    },

    subscribeBars(slab: string, resolution: ProviderResolution, handlers: LiveHandlers, lastBar: ProviderBar | null): () => void {
      const s = series.get();
      const resMin = resolutionToMinutes(resolution);
      if (resMin === null) return () => {};
      let last = lastBar;
      let lastLiveAt = now();

      const emitTick = (price: number | null, tsMs: number) => {
        if (price === null) return;
        const c = foldTick(last ? toCandle(last) : null, price, tsMs, resMin);
        if (!c) return;
        const bar: ProviderBar = { timeSec: c.t, open: c.o, high: c.h, low: c.l, close: c.c, volume: last && last.timeSec === c.t ? last.volume : 0 };
        last = bar;
        lastLiveAt = now();
        handlers.onBar(bar);
      };

      const off = live.subscribe(slab, {
        onTick: (m) => { if (s === "mark") emitTick(m.mark, m.landedMs); else if (s === "oracle") emitTick(m.oracle, m.landedMs); },
        onTrade: (t) => {
          if (s !== "last") return;
          const bar = applyTrade(last, { price: t.price, size: t.size, tsSec: Math.floor(t.ts / 1000) }, resolution);
          if (bar) { last = bar; lastLiveAt = now(); handlers.onBar(bar); }
        },
        onReconnect: () => {
          // The replay buffer repaired short gaps already; a long outage means the persisted tail has bars we never saw.
          if (now() - lastLiveAt > REPLAY_WINDOW_MS) handlers.onReset?.();
        },
      });
      // The user flipped Mark/Oracle/Last: the chart must refetch history for the new series.
      const offSeries = series.subscribe(() => handlers.onReset?.());
      return () => { off(); offSeries(); };
    },

    searchSymbols: (q) => base.searchSymbols(q),
  };
}
