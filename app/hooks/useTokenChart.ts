"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import type { CandleData } from "@/app/api/chart/[mint]/route";
import { pollWhenVisible } from "@/lib/pollWhenVisible";
import { boundedSet } from "@/lib/bounded-map";

export type ChartDataStatus = "idle" | "loading" | "success" | "error" | "empty";

export interface UseTokenChartResult {
  candles: CandleData[];
  poolAddress: string | null;
  status: ChartDataStatus;
  error: string | null;
  refresh: () => void;
}

// Phase 2: 15m added
type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d" | "7d" | "30d";

/**
 * Timeframe → GeckoTerminal request. The selector means CANDLE SIZE (like
 * every trading terminal), not window length: "1h" = 1-hour candles with as
 * much history as one request allows, NOT "one hour of data".
 *
 * The previous mapping used window semantics with 12–42 bar limits — "1h"
 * fetched twelve 5-minute bars — so every chart was a couple of lines with
 * nothing to scroll back into (user report). GeckoTerminal serves up to
 * 1000 bars per request at no extra call cost; ask for the full depth.
 * (GT aggregates: minute 1/5/15, hour 1/4/12, day 1.)
 */
const TIMEFRAME_TO_API: Record<
  Timeframe,
  { timeframe: "minute" | "hour" | "day"; aggregate: number; limit: number }
> = {
  "1m":  { timeframe: "minute", aggregate: 1,  limit: 1000 }, // ~16h of history
  "5m":  { timeframe: "minute", aggregate: 5,  limit: 1000 }, // ~3.5d
  "15m": { timeframe: "minute", aggregate: 15, limit: 1000 }, // ~10d
  "1h":  { timeframe: "hour",   aggregate: 1,  limit: 1000 }, // ~41d
  "4h":  { timeframe: "hour",   aggregate: 4,  limit: 1000 }, // ~5.5mo
  "1d":  { timeframe: "day",    aggregate: 1,  limit: 365 },  // 1y
  "7d":  { timeframe: "day",    aggregate: 1,  limit: 730 },  // 2y of daily bars
  "30d": { timeframe: "day",    aggregate: 1,  limit: 1000 }, // ~3y of daily bars
};

/** Fetch interval: 60s for short timeframes, 5min for daily */
const POLL_INTERVAL_MS = 60 * 1000;

// Module-level (not per-component-instance) so switching timeframe and back
// within the same page session repaints instantly from cache instead of
// re-fetching. Bounded to a handful of mints x timeframes; see
// lib/bounded-map.ts for the eviction rationale. (This route's URL has no
// from/to — it's already deterministic per mint+timeframe, so no
// quantization is needed to hit its server-side/CDN cache.)
const CACHE_MAX_ENTRIES = 30;
/** How old a cached batch may be and still be PAINTED on a repeat visit.
 *  The cache is a paint accelerator, not a source of truth — every read still
 *  revalidates in the background — but painting a hours-old batch for a
 *  round-trip is misleading, so stale entries fall back to the loading state. */
const CACHE_PAINT_MAX_AGE_MS = 10 * 60_000;
/** Retry cadence for timeframes excluded from the normal poll (7d/30d) while
 *  they have no data — see the poll block for why. */
const EMPTY_RETRY_INTERVAL_MS = 20_000;
/** Only SUCCESSFUL, non-empty batches are ever cached. Caching an empty result
 *  (which is what a transient GeckoTerminal 429 looks like — the route turns
 *  an upstream 429 into an empty 200) made a timeframe render blank from cache
 *  on every revisit until the background revalidation landed, and on the
 *  non-polling timeframes (7d/30d) it never healed at all. */
const chartCache = new Map<string, { candles: CandleData[]; poolAddress: string | null; at: number }>();

/**
 * PERC-512: Hook that fetches external OHLCV candle data for a Solana token.
 *
 * Data source: /api/chart/[mint] → GeckoTerminal (free, no API key)
 * Falls back gracefully when no data is available (chart shows oracle prices).
 *
 * @param mintAddress - SPL token mint address (null/undefined = no fetch)
 * @param timeframe   - Chart timeframe (controls candle size and count)
 */
export function useTokenChart(
  mintAddress: string | null | undefined,
  timeframe: Timeframe = "1d"
): UseTokenChartResult {
  const [candles, setCandles] = useState<CandleData[]>([]);
  const [poolAddress, setPoolAddress] = useState<string | null>(null);
  const [status, setStatus] = useState<ChartDataStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  // Track current mint+timeframe to avoid stale updates
  const fetchKeyRef = useRef<string>("");
  // Mirrors `candles` so the empty/error branches can check "do we already
  // have data" without taking a stale closure over `candles` state.
  const candlesRef = useRef<CandleData[]>([]);
  // WHICH key `candlesRef` holds data for. Without this, keep-last-good is
  // cross-key and renders the WRONG chart: on 1h (3 bars) → switch to 4h →
  // 4h fails/returns empty → the retained 1h bars were shown under the 4h
  // selector with a "success" status. Keep-last-good must be per-key.
  const lastGoodKeyRef = useRef<string>("");
  // Non-reactive mirror of `status` for the retry loop below (a dep on `status`
  // would tear down and re-arm the interval on every status change).
  const statusRef = useRef<ChartDataStatus>("idle");
  statusRef.current = status;

  /** Empty batch or fetch failure: keep the retained candles ONLY if they
   *  belong to this exact key; otherwise show an honest empty/error state
   *  rather than another timeframe's data. */
  const applyEmptyOrError = useCallback((key: string, errMsg: string | null) => {
    setError(errMsg);
    if (lastGoodKeyRef.current === key && candlesRef.current.length > 0) {
      setStatus("success"); // transient blip over data we already have for THIS key
      return;
    }
    candlesRef.current = [];
    setCandles([]);
    setStatus(errMsg ? "error" : "empty");
  }, []);

  const fetchData = useCallback(
    async (mint: string, tf: Timeframe) => {
      const key = `${mint}:${tf}`;
      fetchKeyRef.current = key;

      // Stale-while-revalidate: paint any cached bars for this (mint,
      // timeframe) instantly, then refetch in the background — without this,
      // every repeat timeframe switch blanked the chart to "loading" for a
      // fresh round trip even though we fetched this exact pair moments ago.
      const cached = chartCache.get(key);
      if (cached && Date.now() - cached.at < CACHE_PAINT_MAX_AGE_MS) {
        candlesRef.current = cached.candles;
        lastGoodKeyRef.current = key;
        setCandles(cached.candles);
        setPoolAddress(cached.poolAddress);
        setStatus("success");
        setError(null);
      } else {
        // Don't flip to loading on a repoll that already has candles — keep
        // showing them to avoid flicker every 60s (mirrors usePythChart's
        // identical fix). Only the very first fetch for a key sees "loading".
        setStatus((prev) => (prev === "success" ? "success" : "loading"));
        setError(null);
      }

      const { timeframe: apiTf, aggregate, limit } = TIMEFRAME_TO_API[tf];
      const url = `/api/chart/${mint}?timeframe=${apiTf}&aggregate=${aggregate}&limit=${limit}`;

      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();

        // Guard stale updates: only apply if this is still the current fetch
        if (fetchKeyRef.current !== key) return;

        const fetchedCandles: CandleData[] = json.candles ?? [];
        const pool = json.poolAddress ?? null;

        if (fetchedCandles.length > 0) {
          candlesRef.current = fetchedCandles;
          lastGoodKeyRef.current = key;
          setCandles(fetchedCandles);
          setPoolAddress(pool);
          setStatus("success");
          boundedSet(chartCache, key, { candles: fetchedCandles, poolAddress: pool, at: Date.now() }, CACHE_MAX_ENTRIES);
          return;
        }

        // Empty batch — usually a transient upstream 429 (the route maps an
        // upstream failure to an empty 200), occasionally a genuinely
        // dataless timeframe. NEVER cache it (see chartCache's comment) and
        // keep-last-good only if the retained candles belong to THIS key.
        applyEmptyOrError(key, null);
      } catch (err) {
        if (fetchKeyRef.current !== key) return;
        console.warn("[useTokenChart] fetch error:", err);
        applyEmptyOrError(key, err instanceof Error ? err.message : "Unknown error");
      }
    },
    [applyEmptyOrError]
  );

  // Initial fetch + timeframe changes
  useEffect(() => {
    if (!mintAddress) {
      candlesRef.current = [];
      setCandles([]);
      setPoolAddress(null);
      setStatus("idle");
      setError(null);
      return;
    }

    fetchData(mintAddress, timeframe);

    // Phase 2: Poll for fresh data every 60 seconds (only short timeframes benefit).
    // Paused while the tab is hidden — a backgrounded trade tab shouldn't
    // keep re-fetching chart candles nobody is looking at.
    const POLLING_TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d"];
    if (POLLING_TIMEFRAMES.includes(timeframe)) {
      return pollWhenVisible(() => fetchData(mintAddress, timeframe), POLL_INTERVAL_MS);
    }
    // 7d/30d are excluded from the poll above (their candles barely move), but
    // that left them with NO recovery path: a transient upstream 429 (which the
    // route surfaces as an empty batch) blanked the chart until a hard refresh.
    // Retry only while we still have nothing to show — stops as soon as data
    // lands, so a genuinely-dataless timeframe settles after one retry cycle.
    return pollWhenVisible(() => {
      if (statusRef.current !== "success") fetchData(mintAddress, timeframe);
    }, EMPTY_RETRY_INTERVAL_MS);
  }, [mintAddress, timeframe, fetchData]);

  const refresh = useCallback(() => {
    if (mintAddress) fetchData(mintAddress, timeframe);
  }, [mintAddress, timeframe, fetchData]);

  return { candles, poolAddress, status, error, refresh };
}
