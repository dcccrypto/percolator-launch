"use client";

import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { Database } from "@/lib/database.types";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab, getMockMarketInfo } from "@/lib/mock-trade-data";

type MarketWithStats = Database['public']['Views']['markets_with_stats']['Row'];
type SupabaseClient = ReturnType<typeof getSupabase>;

export function useMarketInfo(slabAddress: string) {
  const [market, setMarket] = useState<MarketWithStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    // Mock-mode short-circuit: serves logoUrl, decimals, symbol, OI, volume
    // straight from the in-codebase mock-trade-data. Avoids a DB round-trip
    // and lets demo-shots / pitch screenshots render with correct token logos.
    if (isMockMode() && isMockSlab(slabAddress)) {
      const mock = getMockMarketInfo(slabAddress);
      setMarket(mock as unknown as MarketWithStats);
      setLoading(false);
      return;
    }

    let supabase: SupabaseClient;
    try {
      supabase = getSupabase();
    } catch {
      // Supabase client creation can fail if env vars missing (e.g. in test env)
      setError("Database unavailable");
      setLoading(false);
      return;
    }

    const sb = supabase;

    async function load() {
      try {
        const { data, error: dbError } = await sb
          .from("markets_with_stats")
          .select("*")
          .eq("slab_address", slabAddress)
          .maybeSingle();
        if (dbError) {
          setError(dbError.message);
        } else if (!data) {
          setMarket(null);
          setError("Market not found");
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
    const channel = sb
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

    return () => { sb.removeChannel(channel); };
  }, [slabAddress]);

  return { market, loading, error };
}
