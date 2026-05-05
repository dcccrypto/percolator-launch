"use client";

import { useEffect, useState } from "react";
import { isBlockedSlab } from "@/lib/blocklist";
import type { Database } from "@/lib/database.types";

type MarketWithStats = Database['public']['Views']['markets_with_stats']['Row'];
type MarketsApiResponse = {
  markets?: MarketWithStats[];
  error?: string;
};

/**
 * Hook to fetch all markets with their latest stats through the app API.
 * Returns a map of slab_address -> stats for easy lookup.
 */
export function useAllMarketStats() {
  const [statsMap, setStatsMap] = useState<Map<string, MarketWithStats>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const controller = new AbortController();

    async function load() {
      try {
        const res = await fetch("/api/markets?include_zombie=true&limit=500", {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`Markets API returned ${res.status}`);
        }
        const body = (await res.json()) as MarketsApiResponse;
        if (!Array.isArray(body.markets)) {
          throw new Error(body.error ?? "Markets API returned no markets array");
        }

        const map = new Map<string, MarketWithStats>();
        body.markets.forEach((market) => {
          if (market.slab_address && !isBlockedSlab(market.slab_address)) {
            map.set(market.slab_address, market);
          }
        });
        setStatsMap(map);
        setError(null);
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Failed to load market stats");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    load();

    const pollInterval = setInterval(load, 30_000);

    return () => {
      controller.abort();
      clearInterval(pollInterval);
    };
  }, []);

  return { statsMap, loading, error };
}
