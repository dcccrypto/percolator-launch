"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { TraderStatsResponse } from "@/app/api/trader/[wallet]/stats/route";

export type { TraderStatsResponse };

export interface UseTraderStatsResult {
  stats: TraderStatsResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Fetches aggregate trade statistics for a wallet address.
 * PERC-481: Trade statistics panel on portfolio page.
 */
export function useTraderStats(wallet: string | null | undefined): UseTraderStatsResult {
  const [stats, setStats] = useState<TraderStatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeqRef = useRef(0);

  const fetch_ = useCallback(
    async (requestSeq = requestSeqRef.current) => {
      if (!wallet) {
        setStats(null);
        setLoading(false);
        return;
      }

      const isCurrentRequest = () => requestSeqRef.current === requestSeq;

      setLoading(true);
      setError(null);

      try {
        const res = await fetch(`/api/trader/${wallet}/stats`);

        if (!isCurrentRequest()) return;

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));

          if (!isCurrentRequest()) return;

          throw new Error(body.error ?? `HTTP ${res.status}`);
        }

        const data: TraderStatsResponse = await res.json();

        if (!isCurrentRequest()) return;

        setStats(data);
      } catch (err) {
        if (!isCurrentRequest()) return;

        setError(err instanceof Error ? err.message : "Failed to load stats");
      } finally {
        if (isCurrentRequest()) {
          setLoading(false);
        }
      }
    },
    [wallet],
  );

  useEffect(() => {
    requestSeqRef.current += 1;
    const requestSeq = requestSeqRef.current;

    setStats(null);
    setError(null);

    if (wallet) {
      void fetch_(requestSeq);
    } else {
      setLoading(false);
    }

    return () => {
      requestSeqRef.current += 1;
    };
  }, [wallet, fetch_]);

  const refresh = useCallback(() => {
    requestSeqRef.current += 1;
    const requestSeq = requestSeqRef.current;

    setStats(null);
    setError(null);

    if (wallet) {
      void fetch_(requestSeq);
    } else {
      setLoading(false);
    }
  }, [wallet, fetch_]);

  return { stats, loading, error, refresh };
}
