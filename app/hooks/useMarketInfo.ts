"use client";

import useSWR from "swr";
import type { Database } from "@/lib/database.types";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab, getMockMarketInfo } from "@/lib/mock-trade-data";

type MarketWithStats = Database['public']['Views']['markets_with_stats']['Row'];

/**
 * Unwraps whatever shape ended up in the SWR cache for the
 * `/api/markets/${slab}` key: either this hook's OWN `fetchMarketInfo`
 * result (already flat, see below) or the raw `{ market: {...} }` API body
 * (if `useLivePrice.ts`'s fetcher happened to populate the shared cache
 * entry first — see the SWR-key comment on `useMarketInfo` below). Applying
 * this at the READ site, not just inside `fetchMarketInfo`, means the shape
 * is correct regardless of which fetcher actually ran for a given
 * revalidation.
 */
function unwrapMarketInfo(raw: unknown): MarketWithStats | null {
  const data = (raw && typeof raw === "object" && "market" in raw
    ? (raw as { market?: unknown }).market
    : raw) as MarketWithStats | null | undefined;
  if (!data || typeof data !== "object" || !("slab_address" in data)) return null;
  return data;
}

async function fetchMarketInfo(slabAddress: string): Promise<MarketWithStats | null> {
  const r = await fetch(`/api/markets/${slabAddress}`);
  if (!r.ok) throw new Error(`market request failed (${r.status})`);
  const body = await r.json();
  const data = unwrapMarketInfo(body);
  if (!data) throw new Error("Market not found");
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
 *
 * The SWR key is the bare URL `/api/markets/${slabAddress}` — deliberately
 * the SAME key `useLivePrice.ts` uses for its cold-start DB-seed fetch
 * (`marketKey`). SWR dedupes purely by key string across the whole app, not
 * per-hook, so before this the two hooks each held their OWN cache entry for
 * the same endpoint (`market-info:${slab}` vs `/api/markets/${slab}`) — two
 * fetches on every mount instead of one. Unifying the key means whichever
 * hook mounts first satisfies both. `useMarketInfo`'s options win: SWR takes
 * the most aggressive `refreshInterval` among all mounted hooks sharing a
 * key, and useLivePrice's is a one-shot seed (`refreshInterval: 0`), so the
 * merged behavior is exactly this 20s poll — the freshness `useMarketInfo`
 * consumers need, with no loss for useLivePrice's one-shot use.
 *
 * Two gotchas that fall out of sharing a key with a hook this file doesn't
 * own (useLivePrice.ts is out of scope here):
 *   1. Shape: `useLivePrice`'s fetcher returns the RAW `{ market: {...} }`
 *      API body (it reads through `.market` itself downstream), while this
 *      hook's own `fetchMarketInfo` returns the already-unwrapped flat row.
 *      SWR dedupes by key regardless of which hook's fetcher actually runs
 *      a given revalidation, so this hook's `data` could arrive in EITHER
 *      shape depending on mount order — `unwrapMarketInfo` (above) is
 *      applied at the read site specifically to stay correct either way.
 *   2. Mock mode: `useLivePrice` has no mock-mode awareness and would issue
 *      a real (failing) fetch for a mock slab. Resolving mock mode OUTSIDE
 *      the SWR key here (skip the key/fetch entirely — `null` key) means a
 *      mock slab never touches this shared cache entry at all, so it can't
 *      be raced by useLivePrice's non-mock-aware fetch.
 */
export function useMarketInfo(slabAddress: string) {
  const mockMode = isMockMode() && isMockSlab(slabAddress);
  const { data, error, isLoading } = useSWR<MarketWithStats | null, Error>(
    mockMode ? null : `/api/markets/${slabAddress}`,
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

  if (mockMode) {
    return {
      market: getMockMarketInfo(slabAddress) as unknown as MarketWithStats,
      loading: false,
      error: null,
    };
  }

  return {
    market: unwrapMarketInfo(data),
    loading: isLoading,
    error: error instanceof Error ? error.message : error ? String(error) : null,
  };
}
