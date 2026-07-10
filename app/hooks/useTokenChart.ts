"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import type { CandleData } from "@/app/api/chart/[mint]/route";

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

  const fetchData = useCallback(
    async (mint: string, tf: Timeframe) => {
      const { timeframe: apiTf, aggregate, limit } = TIMEFRAME_TO_API[tf];
      const url = `/api/chart/${mint}?timeframe=${apiTf}&aggregate=${aggregate}&limit=${limit}`;
      const key = `${mint}:${tf}`;
      fetchKeyRef.current = key;

      setStatus("loading");
      setError(null);

      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();

        // Guard stale updates: only apply if this is still the current fetch
        if (fetchKeyRef.current !== key) return;

        const fetchedCandles: CandleData[] = json.candles ?? [];
        setCandles(fetchedCandles);
        setPoolAddress(json.poolAddress ?? null);
        setStatus(fetchedCandles.length > 0 ? "success" : "empty");
      } catch (err) {
        if (fetchKeyRef.current !== key) return;
        console.warn("[useTokenChart] fetch error:", err);
        setError(err instanceof Error ? err.message : "Unknown error");
        setStatus("error");
      }
    },
    []
  );

  // Initial fetch + timeframe changes
  useEffect(() => {
    if (!mintAddress) {
      setCandles([]);
      setPoolAddress(null);
      setStatus("idle");
      setError(null);
      return;
    }

    fetchData(mintAddress, timeframe);

    // Phase 2: Poll for fresh data every 60 seconds (only short timeframes benefit)
    const POLLING_TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d"];
    if (POLLING_TIMEFRAMES.includes(timeframe)) {
      const interval = setInterval(() => {
        fetchData(mintAddress, timeframe);
      }, POLL_INTERVAL_MS);
      return () => clearInterval(interval);
    }
  }, [mintAddress, timeframe, fetchData]);

  const refresh = useCallback(() => {
    if (mintAddress) fetchData(mintAddress, timeframe);
  }, [mintAddress, timeframe, fetchData]);

  return { candles, poolAddress, status, error, refresh };
}
