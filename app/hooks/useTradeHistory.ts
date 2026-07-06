"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { TraderTradeEntry } from "@/app/api/trader/[wallet]/trades/route";

export interface UseTradeHistoryOptions {
  wallet: string | null | undefined;
  limit?: number;
  slabFilter?: string;
}

export interface UseTradeHistoryResult {
  trades: TraderTradeEntry[];
  total: number;
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  refresh: () => void;
}

/**
 * Hook to fetch paginated trade history for a wallet address.
 * PERC-420: Trade history for portfolio page.
 */
export function useTradeHistory({
  wallet,
  limit = 20,
  slabFilter,
}: UseTradeHistoryOptions): UseTradeHistoryResult {
  const [trades, setTrades] = useState<TraderTradeEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);

  // Monotonically-increasing request id. Bumped on every fetchPage call and on
  // every wallet/slabFilter change (effect cleanup), so a response that resolves
  // after the wallet has since switched is recognized as stale and its setState
  // calls are skipped — otherwise a delayed response for wallet A could land
  // after wallet B's request and overwrite B's history with A's trades.
  const requestIdRef = useRef(0);

  const fetchPage = useCallback(
    async (currentOffset: number, append: boolean) => {
      if (!wallet) return;
      const requestId = ++requestIdRef.current;
      setLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams({
          limit: String(limit),
          offset: String(currentOffset),
        });
        if (slabFilter) params.set("slab", slabFilter);

        const res = await fetch(`/api/trader/${wallet}/trades?${params}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const data = await res.json();

        if (requestId !== requestIdRef.current) return; // stale — a newer request superseded this one

        setTotal(data.total ?? 0);
        setTrades((prev) =>
          append ? [...prev, ...(data.trades ?? [])] : (data.trades ?? []),
        );
        setOffset(currentOffset);
      } catch (err) {
        if (requestId !== requestIdRef.current) return; // stale — ignore error from a superseded request
        setError(err instanceof Error ? err.message : "Failed to load history");
      } finally {
        if (requestId === requestIdRef.current) setLoading(false);
      }
    },
    [wallet, limit, slabFilter],
  );

  // Initial load / wallet change
  useEffect(() => {
    setTrades([]);
    setTotal(0);
    setOffset(0);
    if (wallet) {
      fetchPage(0, false);
    }
    return () => {
      // Invalidate any request still in flight for the previous wallet/slabFilter
      // (including on unmount) so its response can no longer commit state.
      requestIdRef.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, slabFilter]);

  const loadMore = useCallback(() => {
    const nextOffset = offset + limit;
    if (nextOffset < total) {
      fetchPage(nextOffset, true);
    }
  }, [offset, limit, total, fetchPage]);

  const refresh = useCallback(() => {
    setTrades([]);
    setTotal(0);
    setOffset(0);
    if (wallet) fetchPage(0, false);
  }, [wallet, fetchPage]);

  const hasMore = trades.length < total;

  return { trades, total, loading, error, hasMore, loadMore, refresh };
}
