"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { ensureLotExp, getLotExp, onLotExp } from "@/lib/v22/lot-registry";

/**
 * The lot exponent of a market, as a property of the MARKET (review N1): 0 with the flag off, the exponent once known,
 * null while unknown (the caller must then show no price / size derived from a per-lot number). Triggers the
 * app-level load for a slab nobody has read yet.
 */
export function useMarketLotExp(slab: string | null | undefined): number | null {
  const subscribe = (cb: () => void) => onLotExp((s) => (s === slab ? cb() : undefined));
  const value = useSyncExternalStore(
    subscribe,
    () => getLotExp(slab),
    () => (isDevnetV22Enabled() ? null : 0),
  );
  useEffect(() => {
    if (slab && isDevnetV22Enabled()) ensureLotExp(slab);
  }, [slab]);
  return value;
}

/** Same for a set of slabs (list pages). A slab absent from the map or null is unknown. */
export function useMarketLotExps(slabs: readonly string[]): Map<string, number | null> {
  const key = [...slabs].sort().join(",");
  const read = (): Map<string, number | null> => new Map((key ? key.split(",") : []).map((s) => [s, getLotExp(s)]));
  const [map, setMap] = useState<Map<string, number | null>>(read);
  useEffect(() => {
    const list = key ? key.split(",") : [];
    setMap(read());
    if (isDevnetV22Enabled()) for (const s of list) ensureLotExp(s);
    return onLotExp((s) => {
      if (list.includes(s)) setMap(read());
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the slab set
  }, [key]);
  return map;
}
