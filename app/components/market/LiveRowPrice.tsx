"use client";

import { tokenUsdOfLotUsd } from "@/lib/v22/lot";
import { useCallback, useSyncExternalStore, type FC } from "react";
import { subscribeSlab, getSnapshot } from "@/lib/priceStore/priceStore";
import { usePriceFlash } from "@/hooks/usePriceFlash";
import { formatUsdFromNumber } from "@/lib/format";

/**
 * Live-ticking price cell for the /markets list. Subscribes to the shared
 * price store (the same WS feed the trade page ticks off), so list prices
 * move in real time instead of freezing at the discovery/stats snapshot.
 * Falls back to the static snapshot price until the first tick arrives.
 * Isolated as a component so ticks re-render only this cell, not the list.
 *
 * Flashes green on an up-tick and red on a down-tick (the same `usePriceFlash`
 * the trade header uses), keyed on the exact e6 tick value rather than the
 * rounded USD float. The static fallback never flashes. The resting class is
 * empty so the cell keeps its row's own price colour between flashes.
 */
export const LiveRowPrice: FC<{ slab: string; fallback: number | null }> = ({ slab, fallback }) => {
  const subscribe = useCallback((cb: () => void) => subscribeSlab(slab, cb), [slab]);
  const getUsd = useCallback(() => getSnapshot(slab).priceUsd, [slab]);
  const getE6 = useCallback(() => getSnapshot(slab).priceE6, [slab]);
  const getLot = useCallback(() => getSnapshot(slab).lotExp ?? 0, [slab]);
  const lotExp = useSyncExternalStore(subscribe, getLot, () => 0);
  const liveLot = useSyncExternalStore(subscribe, getUsd, () => null);
  // The store is per LOT (v2.2); a row shows the per-TOKEN price. Identity when lotExp = 0.
  const live = liveLot == null ? null : tokenUsdOfLotUsd(liveLot, lotExp);
  const liveE6 = useSyncExternalStore(subscribe, getE6, () => null);
  const flash = usePriceFlash(liveE6);
  const flashColor = flash === "up" ? "text-[var(--long)]" : flash === "down" ? "text-[var(--short)]" : "";
  return (
    <span data-testid="markets-row-price" data-flash={flash ?? undefined} className={`transition-colors duration-300 ease-out ${flashColor}`}>
      {formatUsdFromNumber(live ?? fallback)}
    </span>
  );
};
