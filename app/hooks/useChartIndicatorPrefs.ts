"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  type IndicatorConfig,
  type IndicatorKind,
  type IndicatorsStorage,
  INDICATORS_STORAGE_VERSION,
  INDICATOR_DEFAULTS,
  MAX_INDICATORS_PER_SLAB,
  mergeIndicators,
} from "@/lib/indicator-registry";
import { getNextColor } from "@/lib/indicator-palette";

export type { IndicatorConfig, IndicatorKind } from "@/lib/indicator-registry";

const STORAGE_KEY_PREFIX = "perc:chart:indicators:";

function storageKey(slabAddress: string): string {
  return STORAGE_KEY_PREFIX + slabAddress;
}

function generateId(): string {
  // crypto.randomUUID is supported in every modern browser. SSR-safe via
  // the `typeof window` guard at the call site.
  return crypto.randomUUID();
}

/** Return shape of `useChartIndicatorPrefs`. Object form (not tuple) so
 *  consumers can destructure only what they need (commit 6's overlay
 *  renderer only reads `indicators`; commit 8's settings menu uses all
 *  five). Named fields also catch typos and reordering — five items is
 *  too many to safely position-destructure. */
export interface UseChartIndicatorPrefsReturn {
  indicators: IndicatorConfig[];
  addIndicator: (kind: IndicatorKind) => void;
  removeIndicator: (id: string) => void;
  updateIndicator: (id: string, patch: Partial<IndicatorConfig>) => void;
  clearAll: () => void;
}

/** Persisted chart-indicator preferences, scoped per slab address. SSR-safe:
 *  returns [] on the server and during the first client render, then
 *  hydrates from localStorage in an effect. The setters write through to
 *  localStorage synchronously inside the React state updater.
 *
 *  Usage:
 *
 *      const { indicators, addIndicator, removeIndicator, updateIndicator, clearAll }
 *        = useChartIndicatorPrefs(slabAddress);
 *
 *      addIndicator("sma");                             // appends with defaults
 *      removeIndicator(indicators[0].id);                // delete by id
 *      updateIndicator(indicators[0].id, { period: 50 }); // patch one field
 *      clearAll();                                      // remove every indicator
 *
 *  Slab address change: the hook re-hydrates from the new key, replacing
 *  the in-memory list with whatever the new market had stored.
 */
export function useChartIndicatorPrefs(slabAddress: string): UseChartIndicatorPrefsReturn {
  const [indicators, setIndicators] = useState<IndicatorConfig[]>([]);
  // Track which slab address the in-memory state corresponds to. Used to
  // skip the hydration write-through on the very first render after a
  // slab change (we don't want to persist [] to the new key before
  // hydration finishes).
  const slabRef = useRef<string>(slabAddress);

  useEffect(() => {
    slabRef.current = slabAddress;
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(storageKey(slabAddress));
      if (raw == null) {
        setIndicators([]);
        return;
      }
      const parsed = JSON.parse(raw);
      setIndicators(mergeIndicators(parsed));
    } catch {
      // localStorage unavailable, JSON parse failed, etc — start empty
      setIndicators([]);
    }
  }, [slabAddress]);

  /** Persist the current list to localStorage. Best-effort — quota errors,
   *  privacy mode, etc. are swallowed. Wraps the list in the versioned
   *  envelope. */
  const persist = useCallback((slab: string, list: IndicatorConfig[]) => {
    if (typeof window === "undefined") return;
    try {
      const envelope: IndicatorsStorage = {
        version: INDICATORS_STORAGE_VERSION,
        indicators: list,
      };
      window.localStorage.setItem(storageKey(slab), JSON.stringify(envelope));
    } catch {
      // best-effort; ignore quota / privacy errors
    }
  }, []);

  const addIndicator = useCallback(
    (kind: IndicatorKind) => {
      setIndicators((current) => {
        const usedColors = current.map((i) => i.color);
        const color = getNextColor(usedColors);
        const id = generateId();
        const defaults = INDICATOR_DEFAULTS[kind];
        const next: IndicatorConfig = { ...defaults, id, color } as IndicatorConfig;
        // Cap at MAX_INDICATORS_PER_SLAB — drop oldest on insertion past cap.
        const list = current.length >= MAX_INDICATORS_PER_SLAB
          ? [...current.slice(1), next]
          : [...current, next];
        persist(slabRef.current, list);
        return list;
      });
    },
    [persist],
  );

  const removeIndicator = useCallback(
    (id: string) => {
      setIndicators((current) => {
        const list = current.filter((i) => i.id !== id);
        persist(slabRef.current, list);
        return list;
      });
    },
    [persist],
  );

  const updateIndicator = useCallback(
    (id: string, patch: Partial<IndicatorConfig>) => {
      setIndicators((current) => {
        const list = current.map((i) =>
          i.id === id ? ({ ...i, ...patch } as IndicatorConfig) : i,
        );
        persist(slabRef.current, list);
        return list;
      });
    },
    [persist],
  );

  const clearAll = useCallback(() => {
    setIndicators(() => {
      persist(slabRef.current, []);
      return [];
    });
  }, [persist]);

  return { indicators, addIndicator, removeIndicator, updateIndicator, clearAll };
}
