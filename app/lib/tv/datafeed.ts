/**
 * Adapts a `ChartDataProvider` (lib/tv/data/provider.ts) to the TradingView
 * JS Datafeed API. Knows TradingView's conventions (ms timestamps, async
 * callbacks, resolution strings, noData); knows nothing about where the data
 * comes from.
 */
import {
  isProviderResolution,
  type BarSource,
  type ChartDataProvider,
  type ChartSymbolMeta,
  type ProviderBar,
  type ProviderResolution,
} from "./data/provider";
import { perpPricePrecision } from "@/lib/chart/precision";
import type { TvBar, TvDatafeed, TvDatafeedConfiguration, TvResolution, TvSymbolInfo } from "./types";

/** Every resolution offered in the UI. 30 and 1W are built by the library from 15 and 1D. */
export const TV_SUPPORTED_RESOLUTIONS: TvResolution[] = ["1", "5", "15", "30", "60", "240", "1D", "1W"];
export const TV_EXCHANGE = "Percolator";

export const TV_DATAFEED_CONFIG: TvDatafeedConfiguration = {
  supported_resolutions: TV_SUPPORTED_RESOLUTIONS,
  exchanges: [{ value: TV_EXCHANGE, name: TV_EXCHANGE, desc: "Percolator devnet" }],
  symbols_types: [{ name: "Perpetual", value: "crypto" }],
  supports_marks: false,
  supports_timescale_marks: false,
  supports_time: false,
};

/** TradingView sometimes says "D"/"1D", "W"/"1W". */
export function normalizeResolution(res: string): string {
  if (res === "D") return "1D";
  if (res === "W") return "1W";
  return res;
}

/**
 * Price-axis scale for a reference price: 10^decimals with the decimals the perp chart uses
 * (lib/chart/precision.ts: 4 significant digits, 2 to 8 dp, bounded by the e6 mark grid), so a
 * sub-cent memecoin never renders as 0.00 and the two chart engines agree on the axis.
 */
export function tvPriceScale(ref: number | null | undefined): number {
  return 10 ** perpPricePrecision(ref).precision;
}

export function toSymbolInfo(meta: ChartSymbolMeta): TvSymbolInfo {
  return {
    name: `${meta.symbol}/USD`,
    ticker: meta.slab,
    description: meta.description,
    type: "crypto",
    session: "24x7",
    timezone: "Etc/UTC",
    exchange: TV_EXCHANGE,
    listed_exchange: TV_EXCHANGE,
    format: "price",
    pricescale: tvPriceScale(meta.referencePrice),
    minmov: 1,
    has_intraday: true,
    intraday_multipliers: ["1", "5", "15", "60", "240"],
    has_daily: true,
    daily_multipliers: ["1"],
    has_weekly_and_monthly: false,
    supported_resolutions: TV_SUPPORTED_RESOLUTIONS,
    volume_precision: 2,
    visible_plots_set: meta.hasVolume ? "ohlcv" : "ohlc",
    data_status: "streaming",
  };
}

export function toTvBar(b: ProviderBar): TvBar {
  return { time: b.timeSec * 1000, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
}

export interface DatafeedHooks {
  /** The history source for a ticker became known or changed. */
  onSource?(ticker: string, source: BarSource | null): void;
  /** Bars on screen came (partly) from GeckoTerminal / CoinGecko: attribution is required. */
  onDexData?(ticker: string): void;
  /** A live bar was just handed to the chart (latency probes hook the next frame here). */
  onBarDelivered?(ticker: string, bar: ProviderBar): void;
  /** A history page was delivered to the chart (any page, empty or not): any earlier data error is over. */
  onBarsLoaded?(ticker: string): void;
  /** The provider asked for a history refetch — call activeChart().resetData() after this. */
  onResetRequested?(ticker: string): void;
  /** Errors worth surfacing to telemetry. */
  onError?(where: "resolve" | "bars", err: unknown): void;
}

/** Run `fn` in its own macrotask — the library requires async callbacks. */
const later = (fn: () => void) => setTimeout(fn, 0);

export function createTvDatafeed(provider: ChartDataProvider, hooks: DatafeedHooks = {}): TvDatafeed {
  const lastBars = new Map<string, ProviderBar | null>();
  const sources = new Map<string, BarSource | null>();
  const subs = new Map<string, () => void>();
  const key = (ticker: string, res: string) => `${ticker}|${res}`;
  const tickerOf = (s: TvSymbolInfo) => s.ticker ?? s.name;

  return {
    onReady(cb) {
      later(() => cb(TV_DATAFEED_CONFIG));
    },

    searchSymbols(userInput, _exchange, _type, onResult) {
      provider.searchSymbols(userInput).then(
        (items) =>
          later(() =>
            onResult(
              items.map((m) => ({
                symbol: `${m.symbol}/USD`,
                full_name: m.slab,
                ticker: m.slab,
                description: m.description,
                exchange: TV_EXCHANGE,
                type: "crypto",
              })),
            ),
          ),
        () => later(() => onResult([])),
      );
    },

    resolveSymbol(symbolName, onResolve, onError) {
      provider.resolveSymbol(symbolName).then(
        (meta) => later(() => onResolve(toSymbolInfo(meta))),
        (err: unknown) => {
          hooks.onError?.("resolve", err);
          later(() => onError("unknown_symbol"));
        },
      );
    },

    getBars(symbolInfo, resolution, period, onResult, onError) {
      const res = normalizeResolution(resolution);
      if (!isProviderResolution(res)) {
        later(() => onError(`unsupported resolution ${resolution}`));
        return;
      }
      const ticker = tickerOf(symbolInfo);
      provider
        .getBars({
          slab: ticker,
          resolution: res,
          fromSec: period.from,
          toSec: period.to,
          countBack: period.countBack,
          firstRequest: period.firstDataRequest,
        })
        .then(
          (page) => {
            const k = key(ticker, res);
            if (period.firstDataRequest) {
              lastBars.set(k, page.bars[page.bars.length - 1] ?? null);
              if (sources.get(ticker) !== page.source) {
                sources.set(ticker, page.source);
                hooks.onSource?.(ticker, page.source);
              }
            }
            if (page.dexThroughSec != null) hooks.onDexData?.(ticker);
            hooks.onBarsLoaded?.(ticker);
            const bars = page.bars.map(toTvBar);
            later(() => onResult(bars, { noData: bars.length === 0 || page.noMoreHistory }));
          },
          (err: unknown) => {
            hooks.onError?.("bars", err);
            later(() => onError(err instanceof Error ? err.message : String(err)));
          },
        );
    },

    subscribeBars(symbolInfo, resolution, onTick, guid, onResetCacheNeeded) {
      const res = normalizeResolution(resolution);
      if (!isProviderResolution(res)) return;
      const ticker = tickerOf(symbolInfo);
      const k = key(ticker, res);
      subs.get(guid)?.();
      const off = provider.subscribeBars(
        ticker,
        res as ProviderResolution,
        {
          onBar(bar) {
            lastBars.set(k, bar);
            onTick(toTvBar(bar));
            hooks.onBarDelivered?.(ticker, bar);
          },
          onReset() {
            onResetCacheNeeded();
            hooks.onResetRequested?.(ticker);
          },
        },
        lastBars.get(k) ?? null,
        sources.get(ticker) ?? null,
      );
      subs.set(guid, off);
    },

    unsubscribeBars(guid) {
      subs.get(guid)?.();
      subs.delete(guid);
    },
  };
}
