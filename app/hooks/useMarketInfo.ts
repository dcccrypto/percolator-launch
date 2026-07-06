"use client";

import { useEffect, useRef, useState } from "react";

import { getSupabase } from "@/lib/supabase";
import type { Database } from "@/lib/database.types";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab, getMockMarketInfo } from "@/lib/mock-trade-data";

type MarketWithStats = Database["public"]["Views"]["markets_with_stats"]["Row"];
type SupabaseClient = ReturnType<typeof getSupabase>;

export function useMarketInfo(slabAddress: string) {
  const [market, setMarket] = useState<MarketWithStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestSeqRef = useRef(0);

  useEffect(() => {
    requestSeqRef.current += 1;
    const requestSeq = requestSeqRef.current;
    let cancelled = false;

    const isCurrentRequest = () => !cancelled && requestSeqRef.current === requestSeq;

    setLoading(true);
    setError(null);
    setMarket(null);

    if (!slabAddress) {
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    // Mock-mode short-circuit: serves logoUrl, decimals, symbol, OI, volume
    // straight from the in-codebase mock-trade-data. Avoids a DB round-trip
    // and lets demo-shots / pitch screenshots render with correct token logos.
    if (isMockMode() && isMockSlab(slabAddress)) {
      const mock = getMockMarketInfo(slabAddress);

      if (isCurrentRequest()) {
        setMarket(mock as unknown as MarketWithStats);
        setLoading(false);
      }

      return () => {
        cancelled = true;
      };
    }

    let supabase: SupabaseClient;

    try {
      supabase = getSupabase();
    } catch {
      // Supabase client creation can fail if env vars missing (e.g. in test env)
      if (isCurrentRequest()) {
        setError("Database unavailable");
        setLoading(false);
      }

      return () => {
        cancelled = true;
      };
    }

    const sb = supabase;

    async function load() {
      try {
        const { data, error: dbError } = await sb
          .from("markets_with_stats")
          .select("*")
          .eq("slab_address", slabAddress)
          .maybeSingle();

        if (!isCurrentRequest()) return;

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
        if (!isCurrentRequest()) return;

        setError(e instanceof Error ? e.message : "Failed to load market");
      } finally {
        if (isCurrentRequest()) {
          setLoading(false);
        }
      }
    }

    void load();

    // Subscribe to stat updates
    const channel = sb
      .channel(`market-${slabAddress}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "market_stats",
          filter: `slab_address=eq.${slabAddress}`,
        },
        (payload) => {
          if (!isCurrentRequest()) return;

          setMarket((prev) => (prev ? { ...prev, ...payload.new } : prev));
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      sb.removeChannel(channel);
    };
  }, [slabAddress]);

  return { market, loading, error };
}
