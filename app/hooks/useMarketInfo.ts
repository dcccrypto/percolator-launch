"use client";

import { useEffect, useState } from "react";
import type { Database } from "@/lib/database.types";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab, getMockMarketInfo } from "@/lib/mock-trade-data";

type MarketWithStats = Database['public']['Views']['markets_with_stats']['Row'];

/**
 * Market metadata + rolling stats (symbol, OI, 24h volume, funding, …).
 *
 * Sources from the app's own `/api/markets/[slab]` endpoint, which is
 * self-contained (local registry + indexer/on-chain) and needs no Supabase.
 * Previously this queried Supabase directly from the client — but the playground
 * ships with empty NEXT_PUBLIC_SUPABASE_* env, so `market` was always null:
 * that left the chart with no `symbol` (→ no Pyth feed → blank chart) and the
 * market bar showing "—" for OI / 24h stats. Fetching the server API instead
 * works in every deployment (the API resolves the right backend server-side).
 */
export function useMarketInfo(slabAddress: string) {
  const [market, setMarket] = useState<MarketWithStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    // Mock-mode short-circuit: serves logoUrl, decimals, symbol, OI, volume
    // straight from the in-codebase mock-trade-data (demo-shots / screenshots).
    if (isMockMode() && isMockSlab(slabAddress)) {
      const mock = getMockMarketInfo(slabAddress);
      setMarket(mock as unknown as MarketWithStats);
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function load() {
      try {
        const r = await fetch(`/api/markets/${slabAddress}`);
        if (!r.ok) throw new Error(`market request failed (${r.status})`);
        const body = await r.json();
        // /api/markets/[slab] returns { market: {...} }; tolerate a bare object too.
        const data = (body?.market ?? body) as MarketWithStats | null;
        if (cancelled) return;
        if (!data || typeof data !== "object" || !("slab_address" in data)) {
          setMarket(null);
          setError("Market not found");
        } else {
          setMarket(data);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load market");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    // Poll for stat updates (OI / 24h / funding) — replaces the old Supabase
    // realtime channel. The live price itself comes from useLivePrice (faster);
    // these slow-moving stats are fine at 20s.
    const poll = setInterval(load, 20000);

    return () => { cancelled = true; clearInterval(poll); };
  }, [slabAddress]);

  return { market, loading, error };
}
