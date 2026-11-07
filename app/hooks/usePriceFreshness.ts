"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { getServerSnapshot, getSnapshot, subscribeSlab } from "@/lib/priceStore/priceStore";
import { tokenUsdOfLotUsd } from "@/lib/v22/lot";
import { priceFreshness, subscribePriceFreshness } from "@/lib/price-freshness";
import type { ChartLiveState } from "@/lib/chart/live-state";

/**
 * The market's price freshness (lib/price-freshness.ts), re-read on every fresh price and once a second so
 * live → delayed → offline happens on time with a dead feed. The chart marker, the chart price and the page
 * header badge all use this one hook, so they cannot disagree.
 */
export function usePriceFreshness(slab: string | null): { state: ChartLiveState; ageMs: number | null } {
  const [, setBeat] = useState(0);
  useEffect(() => {
    if (!slab) return;
    return subscribePriceFreshness(slab, () => setBeat((n) => n + 1));
  }, [slab]);
  useEffect(() => {
    const id = setInterval(() => setBeat((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return priceFreshness(slab, Date.now());
}

/**
 * The market's display price per TOKEN (the price store holds v2.2 lot markets per LOT: lib/v22/lot.ts), the same
 * number the page header shows. null until the store has one.
 */
export function useDisplayPriceTokenUsd(slab: string | null): number | null {
  const subscribe = useCallback((cb: () => void) => (slab ? subscribeSlab(slab, cb) : () => {}), [slab]);
  const snap = useSyncExternalStore(subscribe, () => getSnapshot(slab), getServerSnapshot);
  const p = snap.priceUsd;
  if (p == null || !Number.isFinite(p) || p <= 0) return null;
  return tokenUsdOfLotUsd(p, snap.lotExp ?? 0);
}
