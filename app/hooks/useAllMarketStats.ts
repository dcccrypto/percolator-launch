"use client";

import { useEffect } from "react";
import useSWR from "swr";
import { MARKET_REGISTERED_EVENT } from "@/lib/keeper-register-client";
import { isBlockedSlab } from "@/lib/blocklist";
import type { Database } from "@/lib/database.types";

export type MarketWithStats = Database['public']['Views']['markets_with_stats']['Row'];
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

/**
 * `fresh` goes around the CDN copy (s-maxage 10 + stale-while-revalidate 60): a distinct URL is a
 * distinct cache key, and no-store skips the browser's copy. Used once, right after a registration
 * lands on this device, so the creator's own lists show the market without waiting out the cache.
 */
export async function fetchMarketStats(fresh = false): Promise<Map<string, MarketWithStats>> {
  const res = await fetch(fresh ? `${SWR_KEY}&fresh=${Date.now()}` : SWR_KEY, {
    headers: { Accept: "application/json" },
    ...(fresh ? { cache: "no-store" as const } : {}),
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
 * SWR's default `compare` is `dequal/lite`, which has no Map support: it compares own enumerable
 * keys, and a Map has none, so ANY two Maps compared equal and SWR silently kept the first fetch's
 * data forever (the 30 s poll and any mutate fetched, then discarded the result). A markets list
 * that never changes after the first load is why a new market stayed missing until a full reload.
 */
export function statsMapsEqual(a: Map<string, MarketWithStats> | undefined, b: Map<string, MarketWithStats> | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (w === undefined || JSON.stringify(v) !== JSON.stringify(w)) return false;
  }
  return true;
}

export interface UseAllMarketStatsOptions {
  /**
   * When `false`, skips firing the request entirely (SWR's conditional-key
   * pattern — passing `null` as the key). Defaults to `true`. Lets a caller
   * whose stats are secondary/below-the-fold defer the ~500-market fetch until
   * its primary content has had a chance to paint, instead of competing for
   * bandwidth on mount. (The landing rail no longer defers: its rows come
   * from this fetch.)
   */
  enabled?: boolean;
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
export function useAllMarketStats(options?: UseAllMarketStatsOptions) {
  const enabled = options?.enabled ?? true;
  const { data, error, isLoading, mutate } = useSWR<Map<string, MarketWithStats>, Error>(
    enabled ? SWR_KEY : null,
    () => fetchMarketStats(),
    {
      // Collapse all concurrent hook instances to 1 request per 30 s.
      dedupingInterval: 30_000,
      // Replace the manual setInterval — SWR refetches in the background.
      refreshInterval: 30_000,
      revalidateOnFocus: false,
      // See statsMapsEqual: the default compare treats every pair of Maps as equal.
      compare: statsMapsEqual,
    },
  );

  // A registration just landed on this device (lib/keeper-register-client.ts markRegistered):
  // refetch past the CDN so the new market is in the list now, not on the next poll.
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const onRegistered = () => {
      void mutate(fetchMarketStats(true), { revalidate: false }).catch(() => undefined);
    };
    window.addEventListener(MARKET_REGISTERED_EVENT, onRegistered);
    return () => window.removeEventListener(MARKET_REGISTERED_EVENT, onRegistered);
  }, [enabled, mutate]);

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
