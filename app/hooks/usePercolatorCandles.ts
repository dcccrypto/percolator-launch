"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { Timeframe } from "./usePythChart";
import { boundedSet } from "@/lib/bounded-map";

export type PercolatorCandleStatus = "idle" | "loading" | "success" | "empty" | "error";

export interface PercolatorCandle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface UsePercolatorCandlesResult {
  candles: PercolatorCandle[];
  status: PercolatorCandleStatus;
  error: string | null;
  refresh: () => void;
}

const RESOLUTION_MAP: Record<Timeframe, { resolution: string; bucketSec: number; lookbackSec: number }> = {
  "1m":  { resolution: "1",   bucketSec: 60,            lookbackSec: 2 * 3600 },
  "5m":  { resolution: "5",   bucketSec: 5 * 60,        lookbackSec: 8 * 3600 },
  "15m": { resolution: "15",  bucketSec: 15 * 60,       lookbackSec: 24 * 3600 },
  "1h":  { resolution: "60",  bucketSec: 60 * 60,       lookbackSec: 7 * 86400 },
  "4h":  { resolution: "240", bucketSec: 4 * 60 * 60,   lookbackSec: 30 * 86400 },
  "1d":  { resolution: "1D",  bucketSec: 24 * 60 * 60,  lookbackSec: 180 * 86400 },
  "7d":  { resolution: "1D",  bucketSec: 24 * 60 * 60,  lookbackSec: 365 * 86400 },
  "30d": { resolution: "1D",  bucketSec: 24 * 60 * 60,  lookbackSec: 5 * 365 * 86400 },
};

function deriveWsUrl(): string | null {
  const explicit = process.env.NEXT_PUBLIC_WS_URL;
  if (explicit) return explicit;
  const api = process.env.NEXT_PUBLIC_API_URL;
  if (!api) return null;
  return api.replace(/^http/, "ws");
}

// Module-level (not per-component-instance) so it survives a slab switch and
// a timeframe switch-and-back within the same page session — resets only on
// a full reload. Bounded to a handful of timeframes x a handful of markets;
// see lib/bounded-map.ts for the eviction rationale.
const CACHE_MAX_ENTRIES = 30;
const candleCache = new Map<string, { candles: PercolatorCandle[]; status: PercolatorCandleStatus }>();

// `from`/`to` are quantized to this grid (see fetchData) so repeated calls
// within the window reuse the exact same URL and actually hit the route's
// `max-age=10` HTTP cache instead of missing on every click because Date.now()
// makes every URL unique.
const QUANTIZE_SEC = 10;

// After the first failure (404/error) this session, /api/candles/[slab] is
// assumed unconfigured for this deployment (no indexer wired up) — skip the
// network call entirely on subsequent fetches rather than repeating a
// request that will never succeed (dead-weight request + console noise).
let endpointUnavailable = false;

/**
 * Internal-trade OHLCV for a Percolator slab. Loads historical bars from
 * /api/candles/:slab (bucketed server-side) and updates the open bar live
 * via the existing WS trades:<slab> channel.
 *
 * Preferred data source for markets with active Percolator volume. The
 * TradingChart component cascades to Pyth when this returns < 10 bars.
 */
export function usePercolatorCandles(
  slabAddress: string | null | undefined,
  timeframe: Timeframe = "1h",
): UsePercolatorCandlesResult {
  const [candles, setCandles] = useState<PercolatorCandle[]>([]);
  const [status, setStatus] = useState<PercolatorCandleStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const fetchKeyRef = useRef<string>("");
  const wsRef = useRef<WebSocket | null>(null);

  const fetchData = useCallback(async (slab: string, tf: Timeframe) => {
    const key = `${slab}:${tf}`;
    fetchKeyRef.current = key;

    // Stale-while-revalidate: paint any cached bars for this (slab, timeframe)
    // instantly, then refetch in the background — without this, every repeat
    // timeframe switch blanked the chart to "loading" for a fresh ~300ms-1s
    // round trip even though we fetched this exact pair moments ago.
    const cached = candleCache.get(key);
    if (cached) {
      setCandles(cached.candles);
      setStatus(cached.status);
      setError(null);
    } else {
      setStatus((prev) => (prev === "success" ? "success" : "loading"));
      setError(null);
    }

    if (endpointUnavailable) {
      // Known-unconfigured for this deployment/session — skip straight to
      // the empty state so TradingChart's Pyth/DEX fallback cascade engages
      // without wasting a network round trip on a route that will 404 again.
      if (!cached) {
        setCandles([]);
        setStatus("empty");
      }
      return;
    }

    const { resolution, lookbackSec } = RESOLUTION_MAP[tf];
    const nowSec = Math.floor(Date.now() / 1000);
    const to = Math.floor(nowSec / QUANTIZE_SEC) * QUANTIZE_SEC;
    const from = to - lookbackSec;

    try {
      const res = await fetch(`/api/candles/${slab}?resolution=${resolution}&from=${from}&to=${to}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as {
        s: "ok" | "no_data" | "error";
        t?: number[]; o?: number[]; h?: number[]; l?: number[]; c?: number[]; v?: number[];
        errmsg?: string;
      };
      if (fetchKeyRef.current !== key) return; // stale guard
      if (body.s === "error") throw new Error(body.errmsg ?? "backend error");
      if (body.s === "no_data") {
        setCandles([]);
        setStatus("empty");
        boundedSet(candleCache, key, { candles: [], status: "empty" }, CACHE_MAX_ENTRIES);
        return;
      }
      const bars: PercolatorCandle[] = (body.t ?? []).map((t, i) => ({
        time: t,
        open: body.o![i],
        high: body.h![i],
        low: body.l![i],
        close: body.c![i],
        volume: body.v![i],
      }));
      const status: PercolatorCandleStatus = bars.length > 0 ? "success" : "empty";
      setCandles(bars);
      setStatus(status);
      boundedSet(candleCache, key, { candles: bars, status }, CACHE_MAX_ENTRIES);
    } catch (err) {
      // Any failure (404, network error, backend error payload) marks the
      // endpoint unavailable for the rest of this session — see the flag's
      // declaration comment.
      endpointUnavailable = true;
      if (fetchKeyRef.current !== key) return;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[usePercolatorCandles] fetch error:", msg);
      setError(msg);
      // Keep-last-good: don't blank a chart that already has cached bars
      // over a transient failure.
      if (!cached) setStatus("error");
    }
  }, []);

  // Historical fetch on (slab, timeframe) change.
  useEffect(() => {
    if (!slabAddress) {
      setCandles([]);
      setStatus("idle");
      return;
    }
    fetchData(slabAddress, timeframe);
  }, [slabAddress, timeframe, fetchData]);

  // Live updates: subscribe to trades:<slab>, mutate the open bar on each trade.
  useEffect(() => {
    if (!slabAddress) return;
    const url = deriveWsUrl();
    if (!url) return;

    const { bucketSec } = RESOLUTION_MAP[timeframe];
    let closed = false;
    let ws: WebSocket | null = null;

    try {
      ws = new WebSocket(url);
    } catch {
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      if (closed) return;
      ws?.send(JSON.stringify({ type: "subscribe", channels: [`trades:${slabAddress}`] }));
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as {
          type?: string;
          slab?: string;
          price?: number;
          size?: string | number;
          timestamp?: number;
        };
        if (msg.type !== "trade" || msg.slab !== slabAddress) return;
        const price = Number(msg.price);
        const size = Math.abs(Number(msg.size));
        const ts = Math.floor((msg.timestamp ?? Date.now()) / 1000);
        const bucket = Math.floor(ts / bucketSec) * bucketSec;
        if (!Number.isFinite(price) || !Number.isFinite(size)) return;

        setCandles((prev) => {
          const last = prev[prev.length - 1];
          if (!last || last.time < bucket) {
            return [...prev, { time: bucket, open: price, high: price, low: price, close: price, volume: size }];
          }
          if (last.time === bucket) {
            const next = prev.slice();
            next[next.length - 1] = {
              time: last.time,
              open: last.open,
              high: Math.max(last.high, price),
              low: Math.min(last.low, price),
              close: price,
              volume: last.volume + size,
            };
            return next;
          }
          return prev; // stale trade, ignore
        });
      } catch {
        /* swallow — malformed msg */
      }
    };

    return () => {
      closed = true;
      try { ws?.close(); } catch { /* ignore */ }
      if (wsRef.current === ws) wsRef.current = null;
    };
  }, [slabAddress, timeframe]);

  const refresh = useCallback(() => {
    if (slabAddress) fetchData(slabAddress, timeframe);
  }, [slabAddress, timeframe, fetchData]);

  return { candles, status, error, refresh };
}
