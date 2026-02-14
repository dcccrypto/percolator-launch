"use client";

import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { Database } from "@/lib/database.types";

type MarketWithStats = Database['public']['Views']['markets_with_stats']['Row'];

export function useMarketInfo(slabAddress: string) {
  const [market, setMarket] = useState<MarketWithStats | null>(null);
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
          .select("*")
          .eq("slab_address", slabAddress)
          .single();
        if (dbError) {
          setError(dbError.message);
        } else {
          setMarket(data);
          setError(null);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load market");
      } finally {
        setLoading(false);
      }
    }
    load();

    // Subscribe to stat updates
    const channel = supabase
      .channel(`market-${slabAddress}`)
      .on("postgres_changes", {
        event: "UPDATE",
        schema: "public",
        table: "market_stats",
        filter: `slab_address=eq.${slabAddress}`,
      }, (payload) => {
        setMarket((prev) => prev ? { ...prev, ...payload.new } : prev);
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [slabAddress]);

  return { market, loading, error };
}
