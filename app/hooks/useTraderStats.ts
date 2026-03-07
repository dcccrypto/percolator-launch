"use client";

import { useState, useEffect, useCallback } from "react";
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

  const fetch_ = useCallback(async () => {
    if (!wallet) {
      setStats(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/trader/${wallet}/stats`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data: TraderStatsResponse = await res.json();
      setStats(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load stats");
    } finally {
      setLoading(false);
    }
  }, [wallet]);

  useEffect(() => {
    fetch_();
  }, [fetch_]);

  return { stats, loading, error, refresh: fetch_ };
}
