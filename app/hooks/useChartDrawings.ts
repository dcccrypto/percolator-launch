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
/** Debounce window for localStorage writes. A burst of mutations
 *  (e.g. user redrawing a few rectangles in quick succession) coalesces
 *  to one setItem instead of N — important because setItem can block
 *  5–50 ms on contended storage backends, and a 30-rectangle burst
 *  would otherwise stack 30 main-thread hitches inside a 30-second
 *  window. Each mutation resets the timer; the trailing fire writes
 *  the final state. Flushes on pagehide / unmount / slab change so
 *  no in-flight write is lost. */
const PERSIST_DEBOUNCE_MS = 250;

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
 *  `drawings.length` and `clearAll`; the creation tools call `addDrawing`.
 *
 *  `drawings` is `readonly` so consumers can't accidentally mutate React
 *  state in place (`.push()`, `.sort()`) — those mutations would skip
 *  the re-render and persistence path. */
export interface UseChartDrawingsReturn {
  drawings: readonly Drawing[];
  addDrawing: (input: DrawingInput) => void;
  deleteDrawing: (id: string) => void;
  clearAll: () => void;
}

/** Persisted chart drawings, scoped per slab address.
 *
 *  SSR-safe: returns [] on the server and during the first client render,
 *  then hydrates from localStorage in an effect. Setters write through
 *  to localStorage on a 250 ms trailing debounce; the timer is flushed
 *  on pagehide, unmount, and slab change so no in-flight mutation is
 *  lost.
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
/** Single hook instance per slab is the supported usage. Two parallel
 *  `useChartDrawings(SAME_SLAB)` calls each maintain independent useState —
 *  writes from one don't propagate to the other without a remount or a
 *  `storage` event listener (this hook has neither, by design — cross-tab
 *  sync isn't a v1 concern). For the trade-page chart only one instance
 *  ever mounts at a time so this is a non-issue in practice. */
export function useChartDrawings(slabAddress: string): UseChartDrawingsReturn {
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  // Track the slab the in-memory state corresponds to so setters write to
  // the correct key. Updated synchronously DURING RENDER — not inside the
  // hydration effect — so a setter fired in the brief window between a
  // prop change and the effect commit can't write to the OLD slab's
  // bucket. React's "latest value ref" pattern.
  const slabRef = useRef<string>(slabAddress);
  slabRef.current = slabAddress;

  /** Write the envelope synchronously. Best-effort — quota errors and
   *  privacy-mode failures are swallowed. Skips invalid slab addresses
   *  to avoid poisoning a shared bucket. */
  const persistImmediate = useCallback((slab: string, list: Drawing[]) => {
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

  // Debounced-persist machinery. The pending write captures the slab it
  // was scheduled for so a slab change DOESN'T cause the trailing fire
  // to write the new slab's list under the old key (or vice versa) —
  // each scheduled write knows where it goes.
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPersistRef = useRef<{ slab: string; list: Drawing[] } | null>(
    null,
  );
  /** Persist the most recent pending write immediately and clear the
   *  trailing timer. Called on pagehide, unmount, and slab change. Safe
   *  to call when nothing is pending. */
  const flushPersist = useCallback(() => {
    if (persistTimerRef.current !== null) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    const pending = pendingPersistRef.current;
    if (pending !== null) {
      pendingPersistRef.current = null;
      persistImmediate(pending.slab, pending.list);
    }
  }, [persistImmediate]);

  /** Replace any in-flight pending write and (re)start the 250 ms timer.
   *  Each mutation resets the timer — burst of N mutations within
   *  250 ms collapses to one trailing setItem at the end. */
  const schedulePersist = useCallback(
    (slab: string, list: Drawing[]) => {
      pendingPersistRef.current = { slab, list };
      if (persistTimerRef.current !== null) {
        clearTimeout(persistTimerRef.current);
      }
      persistTimerRef.current = setTimeout(() => {
        persistTimerRef.current = null;
        const pending = pendingPersistRef.current;
        if (pending !== null) {
          pendingPersistRef.current = null;
          persistImmediate(pending.slab, pending.list);
        }
      }, PERSIST_DEBOUNCE_MS);
    },
    [persistImmediate],
  );

  // flushPersist routed through a ref so the hydration effect's cleanup
  // can call it without listing flushPersist in deps (which would cause
  // the effect to re-fire on every callback identity change).
  const flushPersistRef = useRef(flushPersist);
  flushPersistRef.current = flushPersist;

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isValidSlabAddress(slabAddress)) {
      try {
        const raw = window.localStorage.getItem(storageKey(slabAddress));
        if (raw == null) {
          setDrawings([]);
        } else {
          const parsed = JSON.parse(raw);
          setDrawings(mergeDrawings(parsed));
        }
      } catch {
        // localStorage unavailable, JSON parse failed, etc — start empty.
        setDrawings([]);
      }
    } else {
      setDrawings([]);
    }
    // Cleanup is registered unconditionally (regardless of which
    // hydration branch ran above) so the slabAddress change about to
    // happen — or unmount — flushes any pending write. Without this,
    // an early-return inside the try block would skip cleanup
    // registration; a pending write scheduled before the slab change
    // would then never land under the correct bucket.
    return () => {
      flushPersistRef.current();
    };
  }, [slabAddress]);

  // Pagehide flush so the user closing the tab inside the 250 ms
  // window doesn't lose their last drawing. pagehide fires reliably on
  // tab close + bfcache transitions across modern browsers (including
  // iOS Safari, where beforeunload is unreliable on mobile).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPageHide = (): void => {
      flushPersistRef.current();
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      // Final flush on hook unmount — covers SPA navigation away from
      // the trade page where pagehide doesn't fire.
      flushPersistRef.current();
    };
  }, []);

  const addDrawing = useCallback(
    (input: DrawingInput) => {
      // Generate the id OUTSIDE the state updater. React 18's Strict Mode
      // (and concurrent rendering's discard-and-retry path) intentionally
      // double-invokes updater functions to surface impurity — calling
      // generateId inside would produce two different uuids per logical
      // add, persist both, and leave a brief window where in-memory
      // state and disk disagree on which uuid won. The persist call
      // below is also a side effect, but it's idempotent on identical
      // inputs so the double-invoke is wasted work, not a correctness
      // bug.
      const id = generateId();
      // Spread + cast preserves the discriminated union: `input.kind` is
      // narrowed at the call site, and adding a string `id` doesn't
      // change the variant shape.
      const next = { ...input, id } as Drawing;
      setDrawings((current) => {
        // Cap at MAX_DRAWINGS_PER_SLAB — drop oldest (FIFO) on insertion
        // past the cap. Matches the read-side behaviour in mergeDrawings
        // so an over-cap localStorage payload converges on the same set
        // whether trimmed by read or by write.
        const list =
          current.length >= MAX_DRAWINGS_PER_SLAB
            ? [...current.slice(1), next]
            : [...current, next];
        schedulePersist(slabRef.current, list);
        return list;
      });
    },
    [schedulePersist],
  );

  const deleteDrawing = useCallback(
    (id: string) => {
      setDrawings((current) => {
        const list = current.filter((d) => d.id !== id);
        schedulePersist(slabRef.current, list);
        return list;
      });
    },
    [schedulePersist],
  );

  const clearAll = useCallback(() => {
    setDrawings(() => {
      schedulePersist(slabRef.current, []);
      return [];
    });
  }, [schedulePersist]);

  return { drawings, addDrawing, deleteDrawing, clearAll };
}
