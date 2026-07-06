"use client";

import useSWR from "swr";
import type { Database } from "@/lib/database.types";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab, getMockMarketInfo } from "@/lib/mock-trade-data";

type MarketWithStats = Database['public']['Views']['markets_with_stats']['Row'];

async function fetchMarketInfo(slabAddress: string): Promise<MarketWithStats | null> {
  // Mock-mode short-circuit: serves logoUrl, decimals, symbol, OI, volume
  // straight from the in-codebase mock-trade-data (demo-shots / screenshots).
  if (isMockMode() && isMockSlab(slabAddress)) {
    return getMockMarketInfo(slabAddress) as unknown as MarketWithStats;
  }

  const r = await fetch(`/api/markets/${slabAddress}`);
  if (!r.ok) throw new Error(`market request failed (${r.status})`);
  const body = await r.json();
  // /api/markets/[slab] returns { market: {...} }; tolerate a bare object too.
  const data = (body?.market ?? body) as MarketWithStats | null;
  if (!data || typeof data !== "object" || !("slab_address" in data)) {
    throw new Error("Market not found");
  }
  return data;
}

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
 *
 * BUG 19 fix: was a raw useState+fetch+setInterval(20s) — with ~5 trade-page
 * components (OrderTicket, MarketInfoBar, PositionsDock, PositionPanel, …) each
 * mounting this hook independently for the same slab, that was ~5 identical
 * GETs every 20s per tab. Now a shared SWR key (mirrors useAllMarketStats.ts)
 * dedupes concurrent mounts and shares one poll across all consumers of the
 * same slab. Return shape (`{ market, loading, error }`) is unchanged.
 */
export function useMarketInfo(slabAddress: string) {
  const { data, error, isLoading } = useSWR<MarketWithStats | null, Error>(
    `market-info:${slabAddress}`,
    () => fetchMarketInfo(slabAddress),
    {
      // Collapse all concurrent hook instances for the same slab into 1
      // request per 20s window, and poll in the background at the same
      // cadence the old setInterval used.
      dedupingInterval: 20_000,
      refreshInterval: 20_000,
      revalidateOnFocus: false,
    },
  );

  return {
    market: data ?? null,
    loading: isLoading,
    error: error instanceof Error ? error.message : error ? String(error) : null,
  };
}
