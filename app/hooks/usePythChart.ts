"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { PythCandleData } from "@/app/api/chart/pyth/route";

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

  const fetchData = useCallback(async (symbol: string, tf: Timeframe) => {
    const { resolution, lookbackSecs } = TIMEFRAME_CONFIG[tf];
    const to = Math.floor(Date.now() / 1000);
    const from = to - lookbackSecs;
    const url = `/api/chart/pyth?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${from}&to=${to}`;
    const key = `${symbol}:${tf}`;
    fetchKeyRef.current = key;

    // Don't flip to loading on refreshes — keep showing cached data to avoid
    // flicker on the ~30 s repoll. Only go to loading on the very first fetch.
    setStatus((prev) => (prev === "success" ? "success" : "loading"));
    setError(null);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: { candles?: PythCandleData[]; error?: string; empty?: boolean } = await res.json();
      if (fetchKeyRef.current !== key) return; // stale guard
      if (json.error) throw new Error(json.error);
      const bars = json.candles ?? [];
      setCandles(bars);
      setStatus(bars.length > 0 ? "success" : "empty");
    } catch (err) {
      if (fetchKeyRef.current !== key) return;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[usePythChart] fetch error:", msg);
      setError(msg);
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    if (!pythSymbol) {
      setCandles([]);
      setStatus("idle");
      return;
    }
    fetchData(pythSymbol, timeframe);
    const id = setInterval(() => fetchData(pythSymbol, timeframe), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [pythSymbol, timeframe, fetchData]);

  const refresh = useCallback(() => {
    if (pythSymbol) fetchData(pythSymbol, timeframe);
  }, [pythSymbol, timeframe, fetchData]);

  return { candles, status, error, refresh };
}
