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

/** Distribute Omit over a discriminated union — built-in Omit collapses
 *  to common keys via `keyof`, dropping per-variant fields like `period`
 *  and `stdDev`. The conditional-type trick (`T extends unknown ? ... :
 *  never`) forces distribution, preserving each variant's full key set
 *  before the omit is applied. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** Patch shape accepted by `updateIndicator`. Excludes `id` (immutable
 *  identity) and `kind` (the discriminator — changing it without supplying
 *  the new variant's required fields would corrupt the config). Each
 *  variant retains its per-kind fields (period for SMA/EMA/RSI;
 *  period+stdDev for Bollinger; fast/slow/signal for MACD) so a Bollinger
 *  row can patch `stdDev` and a MACD row can patch `signalPeriod` — but
 *  no caller can switch a config's kind. */
export type IndicatorPatch = Partial<
  DistributiveOmit<IndicatorConfig, "id" | "kind">
>;

const STORAGE_KEY_PREFIX = "perc:chart:indicators:";

/** Solana base58 pubkey: 32–44 chars from the base58 alphabet (no 0OIl).
 *  Validating before forming the storage key prevents an empty / crafted
 *  slab address from poisoning a shared bucket (e.g. `slabAddress = ""`
 *  would otherwise write to `perc:chart:indicators:` — a single key
 *  visible to every page that mounts the hook with a falsy slab). */
const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function isValidSlabAddress(slabAddress: string): boolean {
  return SOLANA_PUBKEY_RE.test(slabAddress);
}

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
  updateIndicator: (id: string, patch: IndicatorPatch) => void;
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
    // Treat an invalid/empty slab as "no persistence" — start with an
    // empty list and don't read from localStorage. Without this guard,
    // hooks mounted before the route param resolves would read from the
    // shared `perc:chart:indicators:` bucket.
    if (!isValidSlabAddress(slabAddress)) {
      setIndicators([]);
      return;
    }
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
   *  envelope. Skips the write entirely for invalid slab addresses to
   *  avoid poisoning a shared bucket. */
  const persist = useCallback((slab: string, list: IndicatorConfig[]) => {
    if (typeof window === "undefined") return;
    if (!isValidSlabAddress(slab)) return;
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
    (id: string, patch: IndicatorPatch) => {
      setIndicators((current) => {
        // Spread is sound now that IndicatorPatch excludes `kind`: i.kind
        // wins, so the discriminator can't be flipped to a variant whose
        // required fields are missing. Per-kind fields not native to this
        // variant (e.g. stdDev landing on an SMA) are extra-property noise
        // — read sites switch on kind and ignore them.
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
