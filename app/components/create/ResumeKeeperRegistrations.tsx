"use client";

/**
 * Re-sends any market registration this device started but never finished
 * (lib/keeper-register-client.ts resumePendingRegistrations): once when any page of the app loads
 * (this component lives in app/providers.tsx, so it is not tied to My Markets), then again every
 * minute while the page is visible for as long as a slab is still "try again" (the ceiling was
 * full, the server was busy, the creation tx was not visible yet), at most RESUME_MAX_PASSES passes
 * or RESUME_MAX_MS from the first, and not sooner than a response's `Retry-After`. No signature and no prompt: the
 * proof is the market's own creation transaction. Devnet playground only.
 */
import { useEffect } from "react";
import { getConfig } from "@/lib/config";
import { RESUME_MAX_MS, RESUME_MAX_PASSES, RESUME_REPEAT_MS, pendingRegistrationSlabs, resumePendingRegistrations } from "@/lib/keeper-register-client";
import { pollWhenVisible } from "@/lib/pollWhenVisible";

interface SlabRetry {
  attempts: number;
  startedAt: number;
  nextAt: number;
  inFlight: boolean;
  exhausted: boolean;
  terminal: boolean;
}

// A component effect may replay or remount in the same tab. A page load starts a new session.
const retries = new Map<string, SlabRetry>();

export function ResumeKeeperRegistrations(): null {
  useEffect(() => {
    if (getConfig().network !== "devnet") return;
    let store: Storage | null = null;
    try {
      store = window.localStorage;
    } catch {
      store = null;
    }
    if (!store) return;
    const s = store;
    let active = true;
    let polling = false;
    let dispose: () => void = () => undefined;
    const pending = () => pendingRegistrationSlabs(s);
    const syncPolling = () => {
      if (!active) return;
      const hasWork = pending().some((slab) => {
        const state = retries.get(slab);
        return !state || (!state.exhausted && !state.terminal);
      });
      if (hasWork && !polling) {
        dispose = pollWhenVisible(scan, RESUME_REPEAT_MS);
        polling = true;
      } else if (!hasWork && polling) {
        dispose();
        polling = false;
      }
    };
    const attempt = async (slab: string) => {
      let state = retries.get(slab);
      if (!state) {
        state = { attempts: 0, startedAt: Date.now(), nextAt: 0, inFlight: false, exhausted: false, terminal: false };
        retries.set(slab, state);
      }
      const now = Date.now();
      if (state.exhausted || state.terminal) return;
      if (state.attempts >= RESUME_MAX_PASSES || now - state.startedAt >= RESUME_MAX_MS) {
        state.exhausted = true;
        syncPolling();
        return;
      }
      if (state.inFlight || now < state.nextAt) return;
      state.inFlight = true;
      state.attempts++;
      try {
        const result = await resumePendingRegistrations({ store: s, only: [slab] });
        if (result.retryLater.includes(slab)) {
          state.nextAt = Math.max(state.nextAt, Date.now() + Math.max(RESUME_REPEAT_MS, result.retryAfterMs ?? 0));
        } else {
          state.terminal = true;
        }
      } catch {
        state.nextAt = Math.max(state.nextAt, Date.now() + RESUME_REPEAT_MS);
      } finally {
        state.inFlight = false;
        if (state.attempts >= RESUME_MAX_PASSES || Date.now() - state.startedAt >= RESUME_MAX_MS) state.exhausted = true;
        syncPolling();
      }
    };
    const scan = () => {
      if (!active) return;
      pending().forEach((slab) => void attempt(slab));
      syncPolling();
    };
    const onPending = (event: Event) => {
      const slab = (event as CustomEvent<{ slab?: unknown }>).detail?.slab;
      if (typeof slab === "string" && slab.length > 0) {
        if (pending().includes(slab)) void attempt(slab);
        syncPolling();
      } else {
        scan();
      }
    };

    window.addEventListener(
      "percolator:keeper-registration-pending",
      onPending,
    );

    // Cancel the first scheduled pass during Strict Mode replay.
    // Only the currently mounted effect performs the initial scan.
    const initialTimer = setTimeout(scan, 0);

    return () => {
      active = false;
      clearTimeout(initialTimer);
      dispose();
      window.removeEventListener(
        "percolator:keeper-registration-pending",
        onPending,
      );
    };
  }, []);
  return null;
}
