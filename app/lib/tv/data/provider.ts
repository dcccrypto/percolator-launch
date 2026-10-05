/**
 * The chart's data-provider seam.
 *
 * The TradingView widget never talks to a data source directly: it talks to
 * the datafeed adapter (lib/tv/datafeed.ts), which talks to ONE
 * `ChartDataProvider`. Swapping the market-data source (indexer candles today;
 * a hosted OHLCV provider later) means writing another implementation of this
 * interface and registering it in ./index.ts — no chart code changes.
 *
 * Units: times are SECONDS since epoch (UTC) throughout this interface. The
 * adapter converts to the milliseconds TradingView wants.
 */

/** Bar sizes a provider can be asked for. TradingView builds 30m from 15m and 1W from 1D itself. */
export const PROVIDER_RESOLUTIONS = ["1", "5", "15", "60", "240", "1D"] as const;
export type ProviderResolution = (typeof PROVIDER_RESOLUTIONS)[number];

export const RESOLUTION_SECONDS: Record<ProviderResolution, number> = {
  "1": 60,
  "5": 300,
  "15": 900,
  "60": 3_600,
  "240": 14_400,
  "1D": 86_400,
};

export function isProviderResolution(v: string): v is ProviderResolution {
  return (PROVIDER_RESOLUTIONS as readonly string[]).includes(v);
}

export interface ProviderBar {
  /** Bar open time, seconds since epoch, aligned to the resolution. */
  timeSec: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Where the bars came from — drives the source badge and the live-tick rule.
 * "perp-mark" / "perp-oracle" are the push-fed perp chart series (lib/chart): their live bar is
 * built from keeper ticks, never from DEX trades.
 */
export type BarSource = "percolator" | "dex" | "oracle" | "external" | "perp-mark" | "perp-oracle";

export interface ChartSymbolMeta {
  /** The slab address — the chart's ticker. */
  slab: string;
  /** Display symbol, e.g. "SOL". */
  symbol: string;
  description: string;
  /** A recent price, used to choose the price-axis precision. */
  referencePrice: number | null;
  /** False -> the chart hides the volume plot. */
  hasVolume: boolean;
  logoUrl?: string;
}

export interface BarsRequest {
  slab: string;
  resolution: ProviderResolution;
  /** Inclusive, seconds. */
  fromSec: number;
  /** Exclusive, seconds. */
  toSec: number;
  /** The chart wants at least this many bars ending at `toSec` (it may widen `fromSec` itself). */
  countBack: number;
  firstRequest: boolean;
}

export interface BarsPage {
  /** Ascending by time, de-duplicated, finite and priced (> 0). */
  bars: ProviderBar[];
  /** True when there is nothing older than what was returned. */
  noMoreHistory: boolean;
  source: BarSource | null;
  /**
   * Perp mark series only: the end of the newest stretch of bars that are the pool (oracle) price
   * standing in for a mark that does not exist (before the first mark, in a gap, or not yet
   * backfilled). Lets the UI say so instead of implying they are marks.
   */
  proxyBeforeSec?: number | null;
  /** Perp mark series only: open time of the oldest stand-in bar (with proxyBeforeSec it brackets them). */
  proxyFromSec?: number | null;
  /**
   * Perp series only: bars up to and including this time were sourced from GeckoTerminal / CoinGecko
   * (pre-launch pool history). CoinGecko's terms require visible attribution wherever that data shows.
   */
  dexThroughSec?: number | null;
}

export interface LiveHandlers {
  /** A new or updated latest bar. Must be at or after the last bar delivered. */
  onBar(bar: ProviderBar): void;
  /** History changed shape (e.g. the source flipped); the chart refetches. */
  onReset?(): void;
}

export interface ChartDataProvider {
  readonly id: string;
  resolveSymbol(slab: string): Promise<ChartSymbolMeta>;
  getBars(req: BarsRequest): Promise<BarsPage>;
  /**
   * Live updates for (slab, resolution). `lastBar` is the newest bar the chart
   * already holds (or null). Returns an unsubscribe function.
   */
  subscribeBars(
    slab: string,
    resolution: ProviderResolution,
    handlers: LiveHandlers,
    lastBar: ProviderBar | null,
    source: BarSource | null,
  ): () => void;
  searchSymbols(query: string): Promise<ChartSymbolMeta[]>;
}

// ---------------------------------------------------------------------------
// Pure helpers shared by providers.
// ---------------------------------------------------------------------------

export function bucketStart(tsSec: number, resolution: ProviderResolution): number {
  const size = RESOLUTION_SECONDS[resolution];
  return Math.floor(tsSec / size) * size;
}

function isPricedBar(b: ProviderBar): boolean {
  return (
    Number.isFinite(b.timeSec) &&
    [b.open, b.high, b.low, b.close].every((v) => Number.isFinite(v) && v > 0)
  );
}

/** Ascending, one bar per timestamp (the later one wins), only finite priced bars, volume coerced to a finite number. */
export function normalizeBars(bars: readonly ProviderBar[]): ProviderBar[] {
  const byTime = new Map<number, ProviderBar>();
  for (const b of bars) {
    if (!isPricedBar(b)) continue;
    byTime.set(b.timeSec, { ...b, volume: Number.isFinite(b.volume) && b.volume > 0 ? b.volume : 0 });
  }
  return [...byTime.values()].sort((a, b) => a.timeSec - b.timeSec);
}

/**
 * Fold one trade into the live bar. Returns the bar to emit, or null when the
 * trade is unusable (non-positive/non-finite price) or older than `last`.
 */
export function applyTrade(
  last: ProviderBar | null,
  trade: { price: number; size: number; tsSec: number },
  resolution: ProviderResolution,
): ProviderBar | null {
  const { price, size, tsSec } = trade;
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(tsSec)) return null;
  const vol = Number.isFinite(size) ? Math.abs(size) : 0;
  const t = bucketStart(tsSec, resolution);
  if (!last || last.timeSec < t) {
    return { timeSec: t, open: price, high: price, low: price, close: price, volume: vol };
  }
  if (last.timeSec === t) {
    return {
      timeSec: t,
      open: last.open,
      high: Math.max(last.high, price),
      low: Math.min(last.low, price),
      close: price,
      volume: last.volume + vol,
    };
  }
  return null;
}

/**
 * Fold a live mark-price tick into the live bar — ONLY when the series itself
 * is built from mark observations (`source === "oracle"`). A trade- or
 * DEX-derived series is never mutated by mark ticks (the mark is drawn as its
 * own line). Returns null when nothing should be emitted.
 */
export function applyMarkTick(
  source: BarSource | null,
  last: ProviderBar | null,
  tick: { price: number; tsSec: number },
  resolution: ProviderResolution,
): ProviderBar | null {
  if (source !== "oracle") return null;
  const bar = applyTrade(last, { price: tick.price, size: 0, tsSec: tick.tsSec }, resolution);
  return bar;
}
