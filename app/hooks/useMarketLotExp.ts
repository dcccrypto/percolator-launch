"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { ensureLotExp, getLotExp, onLotExp, LOT_LOAD_RETRY_MS } from "@/lib/v22/lot-registry";

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
  const unknown = value === null;
  useEffect(() => {
    if (!slab || !isDevnetV22Enabled()) return;
    ensureLotExp(slab);
    // A failed load is swallowed by the registry; retry (once per cooldown) while unknown, so one bad read never pins the guard.
    if (!unknown) return;
    const t = setInterval(() => ensureLotExp(slab), LOT_LOAD_RETRY_MS / 2);
    return () => clearInterval(t);
  }, [slab, unknown]);
  return value;
}

/** Same for a set of slabs (list pages). A slab absent from the map or null is unknown. */
export function useMarketLotExps(slabs: readonly string[]): Map<string, number | null> {
  const key = [...slabs].sort().join(",");
  const read = (): Map<string, number | null> => new Map((key ? key.split(",") : []).map((s) => [s, getLotExp(s)]));
  const [map, setMap] = useState<Map<string, number | null>>(read);
  const anyUnknown = [...map.values()].some((v) => v === null);
  useEffect(() => {
    if (!anyUnknown || !isDevnetV22Enabled() || !key) return;
    const list = key.split(",");
    const t = setInterval(() => {
      for (const s of list) ensureLotExp(s);
    }, LOT_LOAD_RETRY_MS / 2);
    return () => clearInterval(t);
  }, [key, anyUnknown]);
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
