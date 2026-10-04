/**
 * Which price series the chart shows: Mark (default) / Oracle / Last trade.
 * A tiny external store so the toggle, the TradingView datafeed and the lightweight chart all
 * read ONE value; persisted per browser (a convenience only: every read/write is guarded).
 */
import { PERP_SERIES, isPerpSeries, type PerpSeries } from "./perp-types";

export const SERIES_STORAGE_KEY = "perc:chart:series";
export const DEFAULT_SERIES: PerpSeries = "mark";

export const SERIES_LABEL: Record<PerpSeries, string> = { mark: "Mark", oracle: "Oracle", last: "Last" };
export const SERIES_HINT: Record<PerpSeries, string> = {
  mark: "The on-chain mark price the keeper pushes (what liquidations and PnL use)",
  oracle: "The raw pool price the keeper reads, before smoothing",
  last: "The last executed Percolator trade",
};

export interface SeriesStore {
  get(): PerpSeries;
  set(next: PerpSeries): void;
  subscribe(fn: (s: PerpSeries) => void): () => void;
}

export function createSeriesStore(storage?: Pick<Storage, "getItem" | "setItem"> | null): SeriesStore {
  let current: PerpSeries = DEFAULT_SERIES;
  try {
    const raw = storage?.getItem(SERIES_STORAGE_KEY);
    if (isPerpSeries(raw)) current = raw;
  } catch {
    /* storage can throw (private window, blocked site data) */
  }
  const listeners = new Set<(s: PerpSeries) => void>();
  return {
    get: () => current,
    set(next) {
      if (!PERP_SERIES.includes(next) || next === current) return;
      current = next;
      try { storage?.setItem(SERIES_STORAGE_KEY, next); } catch { /* ignore */ }
      for (const l of [...listeners]) l(next);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}

let shared: SeriesStore | null = null;
/** The app-wide store (browser only). */
export function getSeriesStore(): SeriesStore {
  if (!shared) {
    let storage: Storage | null = null;
    try { storage = typeof window !== "undefined" ? window.localStorage : null; } catch { storage = null; }
    shared = createSeriesStore(storage);
  }
  return shared;
}
