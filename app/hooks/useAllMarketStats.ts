"use client";

import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase";
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
    const supabase = getSupabase();

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
            if (market.slab_address) {
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

    // Subscribe to market_stats updates
    const channel = supabase
      .channel("all-market-stats")
      .on("postgres_changes", {
        event: "*",
        schema: "public",
        table: "market_stats",
      }, (payload) => {
        // Re-fetch on any stats update (could optimize this later)
        load();
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  return { statsMap, loading, error };
}
