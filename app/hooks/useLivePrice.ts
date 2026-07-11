"use client";

/**
 * Live price + 24h stats for the active slab (SlabProvider).
 *
 * Phase 1 rewrite (trade-terminal rebuild, see BUILD-LOG.md): this hook is
 * now a THIN `useSyncExternalStore` reader over `lib/priceStore/priceStore.ts`.
 * All WebSocket connection handling (now via a shared, reference-counted
 * manager — one real socket per URL, not one per hook instance — see
 * `lib/priceStore/wsManager.ts`), tick buffering/rAF-flushing, and seed/
 * fallback precedence rules live in the store. This file's remaining jobs:
 *
 *   1. Resolve which slab we're looking at (from SlabProvider context, same
 *      as before — works on both /trade/[slab] and ?market= routes).
 *   2. Drive the store's REST/on-chain SEED paths (cold-start fallback,
 *      applied only-if-empty by the store). These are now genuinely
 *      one-shot for the *price* field, NOT a recurring 10s poll — the old
 *      recurring DB-fallback poll had a real correctness bug, not just an
 *      efficiency one: every 10s it would unconditionally re-apply the DB's
 *      `last_price` even over an already-fresher live WS price, unless they
 *      happened to match to the last digit — a periodic flicker-to-stale-
 *      price bug. See `priceStore.seedFromDbIfEmpty`'s doc comment.
 *   3. Keep the 24h stats (change24h/high24h/low24h) on their existing 10s
 *      REST poll — legitimately-recurring aggregate data, NOT "live price",
 *      so explicitly *not* part of what this phase was asked to kill.
 *   4. Return the exact same `PriceState` shape every existing call site
 *      (TradeForm, TradingChart, PositionPanel, MarketInfoBar, useTrade,
 *      useClosePosition, ...) already depends on — this file is a drop-in,
 *      no consumer needs to change. (`useTrade`/`useClosePosition` were
 *      separately migrated off this reactive hook onto the store's
 *      non-reactive `getLivePriceSnapshot()` — see those files — because
 *      they only need the price *inside* a submit-time callback, never for
 *      JSX; keeping them on this hook would force every future caller of
 *      `useTrade()` to re-render on every tick no matter how good this
 *      store is.)
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";
import useSWR from "swr";
import { useSlabState } from "@/components/providers/SlabProvider";
import { resolveMarketPriceE6 } from "@/lib/oraclePrice";
import {
  subscribeSlab,
  getSnapshot,
  getServerSnapshot,
  seedFromDbIfEmpty,
  seedFromOnChain,
  setInvertFlag,
  setStats24h,
  type PriceState,
} from "@/lib/priceStore/priceStore";

/** SWR fetcher: fail fast on HTTP error (unchanged from pre-refactor). */
export async function livePriceJsonFetcher<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

/** 24h stats — legitimately recurring; NOT the "live price" poll this phase kills. */
const STATS_SWR_OPTS = {
  dedupingInterval: 10_000,
  refreshInterval: 10_000,
  revalidateOnFocus: false,
  shouldRetryOnError: false,
} as const;

/**
 * DB `last_price` fallback — cold-start seed ONLY now. Fetched once
 * (`refreshInterval: 0`) and deduped across simultaneous mounts (mobile +
 * desktop both mount every trade-panel component — see BUILD-LOG Phase 0
 * finding #2), never re-polled. `priceStore.seedFromDbIfEmpty` additionally
 * refuses to apply it once real data exists, so even if this ever
 * revalidates for an unrelated reason it still can't clobber a live price.
 */
const SEED_SWR_OPTS = {
  dedupingInterval: 10_000,
  refreshInterval: 0,
  revalidateOnFocus: false,
  revalidateIfStale: false,
  shouldRetryOnError: false,
} as const;

type PricesApiJson = {
  stats?: { change24h?: number; high24h?: string; low24h?: string } | null;
};
type MarketApiJson = { market?: { last_price?: number | null } };

/**
 * Real-time price hook — reads from the shared price store, which connects
 * to the Percolator WebSocket price engine (one shared connection for the
 * whole app) and falls back to a one-shot REST/on-chain seed when no live
 * tick has arrived yet.
 *
 * Gets the slab address from SlabProvider context (not query params) so it
 * works on both /trade/[slab] and ?market= routes.
 */
export function useLivePrice(): PriceState {
  const { config: mktConfig, slabAddress } = useSlabState();
  const slabAddr = slabAddress || null;

  const subscribe = useCallback(
    (onChange: () => void) => (slabAddr ? subscribeSlab(slabAddr, onChange) : () => {}),
    [slabAddr],
  );
  const getSnap = useCallback(() => getSnapshot(slabAddr), [slabAddr]);
  const state = useSyncExternalStore(subscribe, getSnap, getServerSnapshot);

  // 24h stats — unchanged cadence/semantics from the pre-refactor hook.
  const pricesKey = slabAddr ? `/api/prices/${slabAddr}` : null;
  const { data: pricesJson } = useSWR<PricesApiJson>(pricesKey, livePriceJsonFetcher, STATS_SWR_OPTS);
  useEffect(() => {
    if (!slabAddr || !pricesJson?.stats) return;
    setStats24h(slabAddr, {
      change24h: pricesJson.stats?.change24h ?? null,
      high24h: pricesJson.stats?.high24h ? Number(pricesJson.stats.high24h) / 1_000_000 : null,
      low24h: pricesJson.stats?.low24h ? Number(pricesJson.stats.low24h) / 1_000_000 : null,
    });
  }, [slabAddr, pricesJson]);

  // DB last_price — cold-start seed only (fetched once; store enforces only-if-empty).
  const marketKey = slabAddr ? `/api/markets/${slabAddr}` : null;
  const { data: marketJson } = useSWR<MarketApiJson>(marketKey, livePriceJsonFetcher, SEED_SWR_OPTS);
  useEffect(() => {
    const dbPrice = marketJson?.market?.last_price;
    if (!slabAddr || dbPrice == null || dbPrice <= 0) return;
    seedFromDbIfEmpty(slabAddr, dbPrice, mktConfig?.invert);
  }, [slabAddr, marketJson, mktConfig?.invert]);

  // Keep the store's invert flag current — drives both the DB-seed
  // recompute-on-change path and every subsequent WS tick's applyInvert call.
  useEffect(() => {
    if (!slabAddr) return;
    setInvertFlag(slabAddr, mktConfig?.invert);
  }, [slabAddr, mktConfig?.invert]);

  // On-chain fallback — seed-if-empty, same as pre-refactor.
  useEffect(() => {
    if (!slabAddr || !mktConfig) return;
    const onChainE6 = resolveMarketPriceE6(mktConfig);
    if (onChainE6 === 0n) return;
    seedFromOnChain(slabAddr, onChainE6);
  }, [slabAddr, mktConfig]);

  return state;
}

/**
 * Lightweight boolean reader over the price store: `true` once a live price
 * exists for the active slab, else `false`.
 *
 * Unlike `useLivePrice()`, the `useSyncExternalStore` snapshot here is a
 * PRIMITIVE boolean, so React bails on every unchanged render — a consumer
 * re-renders only when price data appears or disappears (rare), NOT on every
 * ~4-5/sec tick. Use this instead of `useLivePrice().priceUsd == null` in
 * components that need price *presence*, not the value (e.g. the trade page
 * shell's no-data gate), to keep them off the tick path.
 *
 * Carries NO seeding side-effects on purpose — those live in `useLivePrice()`,
 * which the trade page's children (MarketInfoBar, OrderTicket, chart, dock…)
 * already call, so the store stays seeded regardless.
 */
export function useLivePriceHasData(): boolean {
  const { slabAddress } = useSlabState();
  const slabAddr = slabAddress || null;

  const subscribe = useCallback(
    (onChange: () => void) => (slabAddr ? subscribeSlab(slabAddr, onChange) : () => {}),
    [slabAddr],
  );
  const getHasData = useCallback(
    () => (slabAddr ? getSnapshot(slabAddr).priceUsd != null : false),
    [slabAddr],
  );
  return useSyncExternalStore(subscribe, getHasData, () => false);
}
