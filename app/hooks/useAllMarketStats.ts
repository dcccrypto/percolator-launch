"use client";

import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import { isBlockedSlab } from "@/lib/blocklist";
import type { Database } from "@/lib/database.types";

type MarketWithStats = Database['public']['Views']['markets_with_stats']['Row'];

/**
 * Hook to fetch all markets with their latest stats from Supabase.
 * Returns a map of slab_address -> stats for easy lookup.
 */
export function useAllMarketStats() {
  const [statsMap, setStatsMap] = useState<Map<string, MarketWithStats>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    let supabase: ReturnType<typeof getSupabase>;
    try {
      supabase = getSupabase();
    } catch {
      // Supabase client creation can fail if env vars missing
      setError("Database unavailable");
      setLoading(false);
      return;
    }

    async function load() {
      try {
        const { data, error: dbError } = await supabase
          .from("markets_with_stats")
          .select("*");

        if (dbError) {
          setError(dbError.message);
        } else {
          const map = new Map<string, MarketWithStats>();
          data?.forEach((market) => {
            // Skip blocked/stale markets — they are excluded from /api/markets but
            // still visible to the Supabase anon client via markets_with_stats.
            if (market.slab_address && !isBlockedSlab(market.slab_address)) {
              map.set(market.slab_address, market);
            }
          });
          setStatsMap(map);
          setError(null);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load market stats");
      } finally {
        setLoading(false);
      }
    }

    load();

    // Subscribe to market_stats updates (WebSocket)
    // Wrapped in try/catch — Safari/iOS blocks insecure WebSocket on HTTPS pages
    let channel: ReturnType<typeof supabase.channel> | null = null;
    try {
      channel = supabase
        .channel("all-market-stats")
        .on("postgres_changes", {
          event: "*",
          schema: "public",
          table: "market_stats",
        }, () => {
          load();
        })
        .subscribe();
    } catch {
      // WebSocket unavailable — fall back to polling
      console.warn("[useAllMarketStats] Realtime unavailable, falling back to 30s polling");
    }

    // Polling fallback (also acts as backup if realtime subscription fails)
    const pollInterval = setInterval(load, 30_000);

    return () => {
      clearInterval(pollInterval);
      if (channel) supabase.removeChannel(channel);
    };
  }, []);

  return { statsMap, loading, error };
}
