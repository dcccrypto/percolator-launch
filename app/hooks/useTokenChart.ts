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
const chartCache = new Map<string, { candles: CandleData[]; poolAddress: string | null; status: ChartDataStatus }>();

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
  // Mirrors `candles` so the error branch below can check "do we already
  // have data" without taking a stale closure over `candles` state.
  const candlesRef = useRef<CandleData[]>([]);

  const fetchData = useCallback(
    async (mint: string, tf: Timeframe) => {
      const key = `${mint}:${tf}`;
      fetchKeyRef.current = key;

      // Stale-while-revalidate: paint any cached bars for this (mint,
      // timeframe) instantly, then refetch in the background — without this,
      // every repeat timeframe switch blanked the chart to "loading" for a
      // fresh round trip even though we fetched this exact pair moments ago.
      const cached = chartCache.get(key);
      if (cached) {
        candlesRef.current = cached.candles;
        setCandles(cached.candles);
        setPoolAddress(cached.poolAddress);
        setStatus(cached.status);
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
          setCandles(fetchedCandles);
          setPoolAddress(pool);
          setStatus("success");
          // Only successful (non-empty) batches are cached — see the empty
          // branch below for why an empty must never be cached.
          boundedSet(
            chartCache,
            key,
            { candles: fetchedCandles, poolAddress: pool, status: "success" },
            CACHE_MAX_ENTRIES,
          );
        } else {
          // Empty response. GeckoTerminal rate-limits (~30 req/min), so an
          // empty batch is almost always a transient 429 while switching
          // timeframes quickly — NOT "this token has no chart". Two rules,
          // mirroring the keep-last-good error branch below:
          //   1. NEVER cache an empty. A cached empty would be repainted by the
          //      stale-while-revalidate branch above on every later visit to
          //      this (mint,timeframe), leaving that one timeframe stuck blank
          //      for the whole session even though the data is available — the
          //      exact "1h/1d show empty" bug. Not caching it means the next
          //      poll / timeframe switch refetches fresh.
          //   2. If we already have candles for this key, KEEP them (don't
          //      blank a chart that was populated a moment ago); otherwise
          //      surface "empty" so the chart falls back to the oracle line,
          //      and let the 60s poll refill it once GT responds.
          if (pool) setPoolAddress(pool); // pool can resolve even on an empty batch
          if (candlesRef.current.length > 0) {
            setStatus("success");
          } else {
            setStatus("empty");
          }
        }
      } catch (err) {
        if (fetchKeyRef.current !== key) return;
        console.warn("[useTokenChart] fetch error:", err);
        setError(err instanceof Error ? err.message : "Unknown error");
        // Keep-last-good: a transient repoll failure shouldn't blank a chart
        // that already has candles retained — only surface "error" when we
        // genuinely have nothing to show.
        setStatus(candlesRef.current.length > 0 ? "success" : "error");
      }
    },
    []
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
  }, [mintAddress, timeframe, fetchData]);

  const refresh = useCallback(() => {
    if (mintAddress) fetchData(mintAddress, timeframe);
  }, [mintAddress, timeframe, fetchData]);

  return { candles, poolAddress, status, error, refresh };
}
