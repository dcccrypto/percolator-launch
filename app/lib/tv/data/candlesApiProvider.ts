/**
 * ChartDataProvider #1: the app's existing sources.
 *
 *   history  GET /api/candles/:slab (indexer trades bucketed server-side, UDF shape)
 *   live     trades:<slab> on NEXT_PUBLIC_WS_URL (lib/tv/data/tradeStream.ts)
 *   fallback when a market has no indexed trades, the series is built in-session
 *            from live mark-price ticks (lib/priceStore) — the same "oracle"
 *            fallback the lightweight-charts chart uses. No mark history exists
 *            server-side, so this series starts empty on every page load.
 *   symbol   GET /api/markets/:slab, GET /api/markets (search)
 *
 * Replaced later by a hosted OHLCV provider via ./index.ts — chart code does
 * not change.
 */
import {
  RESOLUTION_SECONDS,
  applyMarkTick,
  applyTrade,
  normalizeBars,
  type BarSource,
  type BarsPage,
  type BarsRequest,
  type ChartDataProvider,
  type ChartSymbolMeta,
  type LiveHandlers,
  type ProviderBar,
  type ProviderResolution,
} from "./provider";
import type { TradeStream } from "./tradeStream";

type FetchLike = (input: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** Live mark-price ticks for a slab (lib/priceStore in the app). */
export interface MarkStream {
  subscribe(slab: string, onTick: (priceUsd: number, tsSec: number) => void): () => void;
  latest(slab: string): number | null;
}

export interface CandlesApiProviderDeps {
  fetchImpl: FetchLike;
  trades: TradeStream;
  marks: MarkStream;
  now?: () => number;
}

/** While the series is mark-built, how often to check whether real history exists yet. */
export const HISTORY_PROBE_INTERVAL_MS = 60_000;
const HISTORY_PROBE_LOOKBACK_SEC = 7 * 86_400;

/**
 * How far back to look, in multiples of the requested span, when a window
 * comes back empty — one widening step, then the provider reports "no more
 * history". Indexer history starts at the market's launch, so an empty
 * widened window means there is nothing older.
 */
export const WIDEN_FACTOR = 8;

interface UdfBody {
  s?: unknown;
  t?: unknown;
  o?: unknown;
  h?: unknown;
  l?: unknown;
  c?: unknown;
  v?: unknown;
  errmsg?: unknown;
}

const num = (a: unknown, i: number): number => (Array.isArray(a) ? Number(a[i]) : NaN);

/** UDF { s, t, o, h, l, c, v } -> normalized bars. "no_data" -> []. Throws on "error". */
export function parseUdf(body: unknown): ProviderBar[] {
  if (typeof body !== "object" || body === null) throw new Error("candles: malformed response");
  const b = body as UdfBody;
  if (b.s === "no_data") return [];
  if (b.s !== "ok") throw new Error(typeof b.errmsg === "string" ? b.errmsg : "candles: backend error");
  const t = Array.isArray(b.t) ? b.t : [];
  const bars: ProviderBar[] = t.map((_, i) => ({
    timeSec: num(b.t, i),
    open: num(b.o, i),
    high: num(b.h, i),
    low: num(b.l, i),
    close: num(b.c, i),
    volume: num(b.v, i),
  }));
  return normalizeBars(bars);
}

export function createCandlesApiProvider(deps: CandlesApiProviderDeps): ChartDataProvider {
  const { fetchImpl, trades, marks } = deps;
  const now = deps.now ?? Date.now;
  /** Set on a definitive 404: this deployment has no indexer — skip the call for the session. */
  let candlesUnavailable = false;

  async function fetchWindow(slab: string, res: ProviderResolution, fromSec: number, toSec: number): Promise<ProviderBar[]> {
    if (candlesUnavailable) return [];
    // fill=1: empty buckets carry the previous close, so a quiet market's last-trade chart is a
    // continuous line, not scattered dashes with gaps (see /api/candles fillCandleGaps).
    const url = `/api/candles/${encodeURIComponent(slab)}?resolution=${res}&from=${Math.floor(fromSec)}&to=${Math.floor(toSec)}&fill=1`;
    const r = await fetchImpl(url);
    if (r.status === 404) {
      candlesUnavailable = true;
      return [];
    }
    if (!r.ok) throw new Error(`candles HTTP ${r.status}`);
    return parseUdf(await r.json());
  }

  return {
    id: "candles-api",

    async resolveSymbol(slab: string): Promise<ChartSymbolMeta> {
      let symbol: string | null = null;
      let name: string | null = null;
      let price: number | null = null;
      try {
        const r = await fetchImpl(`/api/markets/${encodeURIComponent(slab)}`);
        if (r.ok) {
          const body = (await r.json()) as { market?: { symbol?: unknown; name?: unknown; mark_price?: unknown; last_price?: unknown } };
          const m = body.market;
          if (m) {
            symbol = typeof m.symbol === "string" && m.symbol.trim() ? m.symbol.trim() : null;
            name = typeof m.name === "string" && m.name.trim() ? m.name.trim() : null;
            const p = Number(m.mark_price ?? m.last_price);
            price = Number.isFinite(p) && p > 0 ? p : null;
          }
        }
      } catch {
        /* fall through to the defaults below */
      }
      const clean = (symbol ?? "").replace(/-PERP$/i, "").toUpperCase();
      const display = clean || `${slab.slice(0, 4)}…${slab.slice(-4)}`;
      return {
        slab,
        symbol: display,
        description: name ?? `${display} perpetual`,
        referencePrice: price ?? marks.latest(slab),
        hasVolume: true,
      };
    },

    async getBars(req: BarsRequest): Promise<BarsPage> {
      const size = RESOLUTION_SECONDS[req.resolution];
      const toSec = req.toSec;
      const fromSec = Math.min(req.fromSec, toSec - Math.max(1, req.countBack) * size);
      let bars: ProviderBar[];
      let exhausted = false;
      try {
        bars = await fetchWindow(req.slab, req.resolution, fromSec, toSec);
        if (bars.length === 0) {
          // One widening step before declaring the start of history.
          const span = Math.max(toSec - fromSec, size);
          bars = await fetchWindow(req.slab, req.resolution, fromSec - WIDEN_FACTOR * span, fromSec);
          exhausted = bars.length === 0;
        }
      } catch (err) {
        // Candles temporarily down (503/network): on the first request, chart the
        // live mark instead of an error; subscribeBars keeps probing history and
        // resets the chart once it answers. Scroll-back failures stay errors (TV retries).
        if (!req.firstRequest) throw err;
        return { bars: [], noMoreHistory: true, source: "oracle" };
      }
      const source: BarSource = bars.length > 0 ? "percolator" : req.firstRequest ? "oracle" : "percolator";
      return { bars, noMoreHistory: exhausted, source };
    },

    subscribeBars(
      slab: string,
      resolution: ProviderResolution,
      handlers: LiveHandlers,
      lastBar: ProviderBar | null,
      source: BarSource | null,
    ): () => void {
      let last = lastBar;
      let flipped = false;
      const offTrades = trades.subscribe(slab, (t) => {
        if (source === "oracle") {
          // The series is mark-built; the first real fill means indexed candles
          // now exist (or soon will). Ask the chart to refetch history once.
          if (!flipped) {
            flipped = true;
            handlers.onReset?.();
          }
          return;
        }
        const bar = applyTrade(last, t, resolution);
        if (bar) {
          last = bar;
          handlers.onBar(bar);
        }
      });
      const offMarks =
        source === "oracle"
          ? marks.subscribe(slab, (priceUsd, tsSec) => {
              const bar = applyMarkTick(source, last, { price: priceUsd, tsSec }, resolution);
              if (bar) {
                last = bar;
                handlers.onBar(bar);
              }
            })
          : () => {};
      // Mark-built series: keep asking whether real history exists now (first
      // indexed fill, or the candles route recovering) and reset once it does.
      let probe: ReturnType<typeof setInterval> | null = null;
      if (source === "oracle" && !candlesUnavailable) {
        probe = setInterval(() => {
          if (flipped || candlesUnavailable) return;
          if (typeof document !== "undefined" && document.hidden) return;
          const nowSec = Math.floor(now() / 1000);
          fetchWindow(slab, resolution, nowSec - HISTORY_PROBE_LOOKBACK_SEC, nowSec).then(
            (bars) => {
              if (bars.length > 0 && !flipped) {
                flipped = true;
                handlers.onReset?.();
              }
            },
            () => {
              /* still down */
            },
          );
        }, HISTORY_PROBE_INTERVAL_MS);
      }
      return () => {
        offTrades();
        offMarks();
        if (probe) clearInterval(probe);
      };
    },

    async searchSymbols(query: string): Promise<ChartSymbolMeta[]> {
      const q = query.trim().toUpperCase();
      try {
        const r = await fetchImpl("/api/markets");
        if (!r.ok) return [];
        const body = (await r.json()) as { markets?: unknown };
        const list = Array.isArray(body.markets) ? body.markets : [];
        const out: ChartSymbolMeta[] = [];
        for (const raw of list) {
          if (typeof raw !== "object" || raw === null) continue;
          const m = raw as { slab_address?: unknown; symbol?: unknown; name?: unknown; mark_price?: unknown };
          if (typeof m.slab_address !== "string") continue;
          const sym = typeof m.symbol === "string" ? m.symbol.replace(/-PERP$/i, "").toUpperCase() : "";
          if (!sym) continue;
          if (q && !sym.includes(q) && !m.slab_address.toUpperCase().startsWith(q)) continue;
          const p = Number(m.mark_price);
          out.push({
            slab: m.slab_address,
            symbol: sym,
            description: typeof m.name === "string" && m.name ? m.name : `${sym} perpetual`,
            referencePrice: Number.isFinite(p) && p > 0 ? p : null,
            hasVolume: true,
          });
        }
        return out.slice(0, 50);
      } catch {
        return [];
      }
    },
  };
}
