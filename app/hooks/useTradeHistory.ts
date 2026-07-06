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
  const requestSeqRef = useRef(0);

  const fetchPage = useCallback(
    async (currentOffset: number, append: boolean, requestSeq = requestSeqRef.current) => {
      if (!wallet) return;

      const isCurrentRequest = () => requestSeqRef.current === requestSeq;

      setLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams({
          limit: String(limit),
          offset: String(currentOffset),
        });

        if (slabFilter) params.set("slab", slabFilter);

        const res = await fetch(`/api/trader/${wallet}/trades?${params}`);

        if (!isCurrentRequest()) return;

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));

          if (!isCurrentRequest()) return;

          throw new Error(body.error ?? `HTTP ${res.status}`);
        }

        const data = await res.json();

        if (!isCurrentRequest()) return;

        setTotal(data.total ?? 0);
        setTrades((prev) => (append ? [...prev, ...(data.trades ?? [])] : (data.trades ?? [])));
        setOffset(currentOffset);
      } catch (err) {
        if (!isCurrentRequest()) return;

        setError(err instanceof Error ? err.message : "Failed to load history");
      } finally {
        if (isCurrentRequest()) {
          setLoading(false);
        }
      }
    },
    [wallet, limit, slabFilter],
  );

  // Initial load / wallet or market-filter change
  useEffect(() => {
    requestSeqRef.current += 1;
    const requestSeq = requestSeqRef.current;

    setTrades([]);
    setTotal(0);
    setOffset(0);
    setError(null);

    if (wallet) {
      fetchPage(0, false, requestSeq);
    } else {
      setLoading(false);
    }

    return () => {
      requestSeqRef.current += 1;
    };
  }, [wallet, slabFilter, fetchPage]);

  const loadMore = useCallback(() => {
    const nextOffset = offset + limit;

    if (nextOffset < total) {
      fetchPage(nextOffset, true, requestSeqRef.current);
    }
  }, [offset, limit, total, fetchPage]);

  const refresh = useCallback(() => {
    requestSeqRef.current += 1;
    const requestSeq = requestSeqRef.current;

    setTrades([]);
    setTotal(0);
    setOffset(0);
    setError(null);

    if (wallet) {
      fetchPage(0, false, requestSeq);
    } else {
      setLoading(false);
    }
  }, [wallet, fetchPage]);

  const hasMore = trades.length < total;

  return { trades, total, loading, error, hasMore, loadMore, refresh };
}
