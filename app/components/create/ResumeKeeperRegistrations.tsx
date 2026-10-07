"use client";

/**
 * Re-sends any market registration this device started but never finished
 * (lib/keeper-register-client.ts resumePendingRegistrations): once when any page of the app loads
 * (this component lives in app/providers.tsx, so it is not tied to My Markets), then again every
 * minute while the page is visible for as long as a slab is still "try again" (the ceiling was
 * full, the server was busy, the creation tx was not visible yet). No signature and no prompt: the
 * proof is the market's own creation transaction. Devnet playground only.
 */
import { useEffect } from "react";
import { getConfig } from "@/lib/config";
import { RESUME_REPEAT_MS, resumePendingRegistrations } from "@/lib/keeper-register-client";
import { pollWhenVisible } from "@/lib/pollWhenVisible";

let ranThisLoad = false;

export function ResumeKeeperRegistrations(): null {
  useEffect(() => {
    if (ranThisLoad || getConfig().network !== "devnet") return;
    ranThisLoad = true;
    let store: Storage | null = null;
    try {
      store = window.localStorage;
    } catch {
      store = null;
    }
    if (!store) return;
    const s = store;
    let waiting: string[] | null = null; // null = the first pass has not finished
    let running = false;
    let dispose: () => void = () => undefined;
    const pass = async () => {
      if (running) return;
      running = true;
      try {
        const r = await resumePendingRegistrations({ store: s, ...(waiting ? { only: waiting } : {}) });
        waiting = r.retryLater;
        if (waiting.length === 0) dispose();
      } catch {
        /* the next tick tries again */
      } finally {
        running = false;
      }
    };
    void pass();
    dispose = pollWhenVisible(() => void pass(), RESUME_REPEAT_MS);
  }, []);
  return null;
}
