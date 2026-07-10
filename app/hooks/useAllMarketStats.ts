"use client";

import useSWR from "swr";
import { isBlockedSlab } from "@/lib/blocklist";
import type { Database } from "@/lib/database.types";

type MarketWithStats = Database['public']['Views']['markets_with_stats']['Row'];
type MarketsApiResponse = {
  markets?: MarketWithStats[];
  error?: string;
};

/** Stable SWR cache key — shared across all mounting hook instances. */
const SWR_KEY = "/api/markets?include_zombie=true&limit=500";

/**
 * Stable identity fallback so downstream memos don't churn while loading.
 * Read-only by convention only — unlike EMPTY_MARKETS (a frozen array) in
 * useMarketDiscovery.ts, Object.freeze() on a Map does NOT block .set()/
 * .delete()/.clear() (they're prototype methods, not own properties), so
 * this shared singleton relies on every caller treating it as read-only.
 * Do not mutate this Map — copy it first if you need to add/remove entries.
 */
const EMPTY_STATS_MAP: Map<string, MarketWithStats> = new Map();

async function fetchMarketStats(): Promise<Map<string, MarketWithStats>> {
  const res = await fetch(SWR_KEY, {
    headers: { Accept: "application/json" },
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
  return map;
}

/**
 * Hook to fetch all markets with their latest stats through the app API.
 * Returns a map of slab_address -> stats for easy lookup.
 *
 * Uses SWR to deduplicate concurrent fetches when multiple components mount
 * this hook simultaneously (React Strict Mode double-invocation, multiple
 * consumers on the markets page). All instances share a single in-flight
 * request per 30-second dedup window and get stale-while-revalidate for
 * instant paint on revisit.
 */
export function useAllMarketStats() {
  const { data, error, isLoading } = useSWR<Map<string, MarketWithStats>, Error>(
    SWR_KEY,
    fetchMarketStats,
    {
      // Collapse all concurrent hook instances to 1 request per 30 s.
      dedupingInterval: 30_000,
      // Replace the manual setInterval — SWR refetches in the background.
      refreshInterval: 30_000,
      revalidateOnFocus: false,
    },
  );

  return {
    statsMap: data ?? EMPTY_STATS_MAP,
    loading: isLoading,
    error: error instanceof Error
      ? error.message
      : error
        ? String(error)
        : null,
  };
}
