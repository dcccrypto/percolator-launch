"use client";

import { useEffect, useState } from "react";
import { subscribeSlab, getSnapshot } from "@/lib/priceStore/priceStore";

/**
 * Live priceE6 for a SET of slabs, backed by ONE effect that subscribes to
 * every slab in `slabs` — as opposed to N components each mounting their own
 * `useSyncExternalStore` instance (e.g. the portfolio page's `PositionCard`
 * and `PositionsBar`'s `PositionChip` today, unaffected by this hook). This
 * is specifically for a roll-up consumer (the portfolio hero's live
 * Portfolio Value / Unrealized PnL) that needs every open position's mark in
 * one place to sum them, where mounting one subscription per row would mean
 * one extra component tree just to read a price.
 *
 * Returns a `Map<slabAddress, priceE6>`. Seeded SYNCHRONOUSLY from
 * `getSnapshot()` in the initial `useState` (before the effect subscribes),
 * so the first render already has whatever the shared price store already
 * holds for these slabs — no one-tick-late flash of empty/zero prices, the
 * same "seed before subscribe" shape `priceStore.ts` documents for its own
 * `useSyncExternalStore` surface.
 */
export function useLiveSlabPrices(slabs: string[]): Map<string, bigint> {
  // Stable key so the effect only re-subscribes when the SET of slabs
  // changes, not on every render of a caller that recomputes `slabs` as a
  // fresh array reference (mirrors PositionsBar's `slabKey` pattern).
  const slabsKey = [...slabs].sort().join(",");

  const seed = (keys: readonly string[]): Map<string, bigint> => {
    const map = new Map<string, bigint>();
    for (const slab of keys) {
      const e6 = getSnapshot(slab).priceE6;
      if (e6 != null) map.set(slab, e6);
    }
    return map;
  };

  const [prices, setPrices] = useState<Map<string, bigint>>(() => seed(slabs));

  useEffect(() => {
    const list = slabsKey ? slabsKey.split(",") : [];
    if (list.length === 0) {
      setPrices(new Map());
      return;
    }

    // Re-seed on (re)subscribe — the slab SET may have changed since the
    // lazy `useState` seed above ran (e.g. positions opened/closed between
    // mount and this effect, or `slabsKey` changing on a later render).
    setPrices(seed(list));

    const unsubs = list.map((slab) =>
      subscribeSlab(slab, () => {
        const e6 = getSnapshot(slab).priceE6;
        if (e6 == null) return;
        setPrices((prev) => {
          if (prev.get(slab) === e6) return prev; // bail out — no redundant re-render
          const next = new Map(prev);
          next.set(slab, e6);
          return next;
        });
      }),
    );

    return () => {
      unsubs.forEach((unsub) => unsub());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on slabsKey, not `slabs` itself
  }, [slabsKey]);

  return prices;
}
