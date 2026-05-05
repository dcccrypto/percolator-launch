"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  type Drawing,
  type DrawingInput,
  type DrawingsStorage,
  DRAWINGS_STORAGE_VERSION,
  MAX_DRAWINGS_PER_SLAB,
  mergeDrawings,
} from "@/lib/chart-drawings";

export type { Drawing, DrawingInput } from "@/lib/chart-drawings";

const STORAGE_KEY_PREFIX = "perc:chart:drawings:";

/** Solana base58 pubkey: 32–44 chars from the base58 alphabet (no 0OIl).
 *  Validating before forming the storage key prevents an empty / crafted
 *  slab address from poisoning a shared bucket — the same protection we
 *  added to the indicator persistence hook after the audit pass flagged
 *  the latent footgun. */
const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function isValidSlabAddress(slabAddress: string): boolean {
  return SOLANA_PUBKEY_RE.test(slabAddress);
}

function storageKey(slabAddress: string): string {
  return STORAGE_KEY_PREFIX + slabAddress;
}

function generateId(): string {
  // crypto.randomUUID is supported in every modern browser. SSR-safe via
  // the `typeof window` guard at every call site.
  return crypto.randomUUID();
}

/** Return shape of `useChartDrawings`. Object form (not tuple) so consumers
 *  can destructure only what they need — the overlay's pointer-tool branch
 *  reads `drawings` and `deleteDrawing` only; the toolbar's clear-all reads
 *  `drawings.length` and `clearAll`; the creation tools call `addDrawing`. */
export interface UseChartDrawingsReturn {
  drawings: Drawing[];
  addDrawing: (input: DrawingInput) => void;
  deleteDrawing: (id: string) => void;
  clearAll: () => void;
}

/** Persisted chart drawings, scoped per slab address.
 *
 *  SSR-safe: returns [] on the server and during the first client render,
 *  then hydrates from localStorage in an effect. Setters write through
 *  to localStorage synchronously inside the React state updater.
 *
 *  Usage:
 *
 *      const { drawings, addDrawing, deleteDrawing, clearAll } =
 *        useChartDrawings(slabAddress);
 *
 *      addDrawing({ kind: "trend", p1, p2 });
 *      deleteDrawing(drawings[0].id);
 *      clearAll();
 *
 *  Slab address change: the hook re-hydrates from the new key, replacing
 *  the in-memory list with whatever the new market had stored. An invalid
 *  or empty slab address no-ops the read and write so the shared
 *  `perc:chart:drawings:` bucket isn't poisoned by hooks mounted before
 *  the route param resolves. */
export function useChartDrawings(slabAddress: string): UseChartDrawingsReturn {
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  // Track the slab the in-memory state corresponds to, so setters write
  // to the correct key even when called from stale closures.
  const slabRef = useRef<string>(slabAddress);

  useEffect(() => {
    slabRef.current = slabAddress;
    if (typeof window === "undefined") return;
    if (!isValidSlabAddress(slabAddress)) {
      setDrawings([]);
      return;
    }
    try {
      const raw = window.localStorage.getItem(storageKey(slabAddress));
      if (raw == null) {
        setDrawings([]);
        return;
      }
      const parsed = JSON.parse(raw);
      setDrawings(mergeDrawings(parsed));
    } catch {
      // localStorage unavailable, JSON parse failed, etc — start empty.
      setDrawings([]);
    }
  }, [slabAddress]);

  /** Persist the current list to localStorage. Best-effort — quota errors
   *  and privacy-mode failures are swallowed. Wraps the list in the
   *  versioned envelope. Skips the write entirely for invalid slab
   *  addresses to avoid poisoning a shared bucket. */
  const persist = useCallback((slab: string, list: Drawing[]) => {
    if (typeof window === "undefined") return;
    if (!isValidSlabAddress(slab)) return;
    try {
      const envelope: DrawingsStorage = {
        version: DRAWINGS_STORAGE_VERSION,
        drawings: list,
      };
      window.localStorage.setItem(storageKey(slab), JSON.stringify(envelope));
    } catch {
      // Best-effort; ignore quota / privacy errors.
    }
  }, []);

  const addDrawing = useCallback(
    (input: DrawingInput) => {
      setDrawings((current) => {
        const id = generateId();
        // Spread + cast preserves the discriminated union: `input.kind` is
        // narrowed at the call site, and adding a string `id` doesn't
        // change the variant shape.
        const next = { ...input, id } as Drawing;
        // Cap at MAX_DRAWINGS_PER_SLAB — drop oldest (FIFO) on insertion
        // past the cap. Matches the read-side behaviour in mergeDrawings
        // so an over-cap localStorage payload converges on the same set
        // whether trimmed by read or by write.
        const list =
          current.length >= MAX_DRAWINGS_PER_SLAB
            ? [...current.slice(1), next]
            : [...current, next];
        persist(slabRef.current, list);
        return list;
      });
    },
    [persist],
  );

  const deleteDrawing = useCallback(
    (id: string) => {
      setDrawings((current) => {
        const list = current.filter((d) => d.id !== id);
        persist(slabRef.current, list);
        return list;
      });
    },
    [persist],
  );

  const clearAll = useCallback(() => {
    setDrawings(() => {
      persist(slabRef.current, []);
      return [];
    });
  }, [persist]);

  return { drawings, addDrawing, deleteDrawing, clearAll };
}
