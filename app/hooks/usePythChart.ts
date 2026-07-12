"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { PythCandleData } from "@/app/api/chart/pyth/route";
import { pollWhenVisible } from "@/lib/pollWhenVisible";
import { boundedSet } from "@/lib/bounded-map";

export type PythChartStatus = "idle" | "loading" | "success" | "empty" | "error";

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d" | "7d" | "30d";

/**
 * Each timeframe maps to (resolution, lookback-seconds). The lookback is
 * wider than the displayed range so the user can scroll back. Pyth returns
 * one bar per resolution step within [from, to].
 */
const TIMEFRAME_CONFIG: Record<
  Timeframe,
  { resolution: "1" | "5" | "15" | "60" | "240" | "D"; lookbackSecs: number }
> = {
  "1m":  { resolution: "1",   lookbackSecs: 2 * 3600 },        // 2 h of 1-min bars   (120 bars)
  "5m":  { resolution: "5",   lookbackSecs: 8 * 3600 },        // 8 h of 5-min bars   (96 bars)
  "15m": { resolution: "15",  lookbackSecs: 24 * 3600 },       // 24 h of 15-min bars (96 bars)
  "1h":  { resolution: "60",  lookbackSecs: 7 * 86400 },       // 7 d of 1-h bars     (168 bars)
  "4h":  { resolution: "240", lookbackSecs: 30 * 86400 },      // 30 d of 4-h bars    (180 bars)
  "1d":  { resolution: "D",   lookbackSecs: 180 * 86400 },     // 180 d of daily bars
  "7d":  { resolution: "D",   lookbackSecs: 365 * 86400 },     // 1 yr of daily bars
  "30d": { resolution: "D",   lookbackSecs: 5 * 365 * 86400 }, // 5 yrs of daily bars
};

const POLL_INTERVAL_MS = 30_000; // re-poll the in-progress bar every 30 s

// Module-level (not per-component-instance) so switching timeframe and back
// within the same page session repaints instantly from cache instead of
// re-fetching. Bounded to a handful of symbols x timeframes; see
// lib/bounded-map.ts for the eviction rationale.
const CACHE_MAX_ENTRIES = 30;
/** Successful batches only, with a paint-freshness stamp — see useTokenChart's
 *  chartCache comment for the empty-cache bug this avoids. */
const CACHE_PAINT_MAX_AGE_MS = 10 * 60_000;
const chartCache = new Map<string, { candles: PythCandleData[]; at: number }>();

// `to` is quantized to this grid so repeated requests within the window
// reuse the exact same URL and actually hit the route's `s-maxage=60` CDN
// cache instead of missing on every call because Date.now() mints a unique
// URL every time.
const QUANTIZE_SEC = 30;

export interface UsePythChartResult {
  candles: PythCandleData[];
  status: PythChartStatus;
  error: string | null;
  refresh: () => void;
}

/**
 * Canonical market-data chart for a Pyth feed symbol (e.g. "Crypto.SOL/USD").
 * This is the same data source Hyperliquid / Drift / Jupiter Perps use for
 * their historical chart — aggregated global spot price, with deep history.
 *
 * When no symbol is provided (e.g. a custom market without a Pyth feed
 * mapping) the hook stays idle and the caller should fall back to the
 * GeckoTerminal DEX-pool source via useTokenChart.
 */
export function usePythChart(
  pythSymbol: string | null | undefined,
  timeframe: Timeframe = "1h",
): UsePythChartResult {
  const [candles, setCandles] = useState<PythCandleData[]>([]);
  const [status, setStatus] = useState<PythChartStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const fetchKeyRef = useRef<string>("");
  // Mirrors `candles` so the error branch below can check "do we already
  // have data" without taking a stale closure over `candles` state.
  const candlesRef = useRef<PythCandleData[]>([]);
  // WHICH key candlesRef holds data for — keep-last-good must be per-key or a
  // failed/empty fetch on a NEW timeframe renders the PREVIOUS timeframe's
  // candles under the new selector with a "success" status. See useTokenChart.
  const lastGoodKeyRef = useRef<string>("");

  /** Empty batch or fetch failure: retain candles ONLY if they belong to this
   *  exact key; otherwise show an honest empty/error state. */
  const applyEmptyOrError = useCallback((key: string, errMsg: string | null) => {
    setError(errMsg);
    if (lastGoodKeyRef.current === key && candlesRef.current.length > 0) {
      setStatus("success");
      return;
    }
    candlesRef.current = [];
    setCandles([]);
    setStatus(errMsg ? "error" : "empty");
  }, []);

  const fetchData = useCallback(async (symbol: string, tf: Timeframe) => {
    const key = `${symbol}:${tf}`;
    fetchKeyRef.current = key;

    // Stale-while-revalidate: paint any cached bars for this (symbol,
    // timeframe) instantly, then refetch in the background — without this,
    // every repeat timeframe switch blanked the chart to "loading" for a
    // fresh round trip even though we fetched this exact pair moments ago.
    const cached = chartCache.get(key);
    if (cached && Date.now() - cached.at < CACHE_PAINT_MAX_AGE_MS) {
      candlesRef.current = cached.candles;
      lastGoodKeyRef.current = key;
      setCandles(cached.candles);
      setStatus("success");
      setError(null);
    } else {
      // Don't flip to loading on refreshes — keep showing cached data to avoid
      // flicker on the ~30 s repoll. Only go to loading on the very first fetch.
      setStatus((prev) => (prev === "success" ? "success" : "loading"));
      setError(null);
    }

    const { resolution, lookbackSecs } = TIMEFRAME_CONFIG[tf];
    const nowSec = Math.floor(Date.now() / 1000);
    const to = Math.floor(nowSec / QUANTIZE_SEC) * QUANTIZE_SEC;
    const from = to - lookbackSecs;
    const url = `/api/chart/pyth?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${from}&to=${to}`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: { candles?: PythCandleData[]; error?: string; empty?: boolean } = await res.json();
      if (fetchKeyRef.current !== key) return; // stale guard
      if (json.error) throw new Error(json.error);
      const bars = json.candles ?? [];
      if (bars.length > 0) {
        candlesRef.current = bars;
        lastGoodKeyRef.current = key;
        setCandles(bars);
        setStatus("success");
        // Only SUCCESSFUL batches are cached — an empty result (what a
        // transient upstream failure looks like) previously got cached and
        // repainted as a blank chart on every revisit.
        boundedSet(chartCache, key, { candles: bars, at: Date.now() }, CACHE_MAX_ENTRIES);
        return;
      }
      applyEmptyOrError(key, null);
    } catch (err) {
      if (fetchKeyRef.current !== key) return;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[usePythChart] fetch error:", msg);
      applyEmptyOrError(key, msg);
    }
  }, [applyEmptyOrError]);

  useEffect(() => {
    if (!pythSymbol) {
      candlesRef.current = [];
      setCandles([]);
      setStatus("idle");
      return;
    }
    fetchData(pythSymbol, timeframe);
    // Pause the ~30s repoll while the tab is hidden.
    return pollWhenVisible(() => fetchData(pythSymbol, timeframe), POLL_INTERVAL_MS);
  }, [pythSymbol, timeframe, fetchData]);

  const refresh = useCallback(() => {
    if (pythSymbol) fetchData(pythSymbol, timeframe);
  }, [pythSymbol, timeframe, fetchData]);

  return { candles, status, error, refresh };
}
