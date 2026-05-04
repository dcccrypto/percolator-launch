"use client";

import { useState, useEffect, useCallback } from "react";
import {
  type OverlayKey,
  type OverlayPrefs,
  DEFAULT_OVERLAY_PREFS,
  mergeOverlayPrefs,
} from "@/lib/chart-overlays";

export type { OverlayKey, OverlayPrefs } from "@/lib/chart-overlays";

const STORAGE_KEY = "perc:chart:overlays";

/** Persisted chart-overlay preferences. SSR-safe: returns DEFAULT_OVERLAY_PREFS
 *  on the server and during the first client render, then hydrates from
 *  localStorage in an effect. The setter writes through to localStorage and
 *  updates state in one hop.
 *
 *  Returns [prefs, setPref] where setPref toggles a single key:
 *
 *      const [prefs, setPref] = useChartOverlayPrefs();
 *      setPref("entry", false); // hide entry-price line
 */
export function useChartOverlayPrefs(): [
  OverlayPrefs,
  (key: OverlayKey, value: boolean) => void,
] {
  const [prefs, setPrefs] = useState<OverlayPrefs>(DEFAULT_OVERLAY_PREFS);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw == null) return;
      const parsed = JSON.parse(raw);
      // mergeOverlayPrefs tolerates partial / unknown shapes — recovers
      // gracefully from older deploys that persisted a smaller key set, and
      // from forward-compat reads where a downgraded build encounters a key
      // it doesn't know about.
      setPrefs(mergeOverlayPrefs(parsed));
    } catch {
      // localStorage unavailable, JSON parse failed, etc — keep defaults
    }
  }, []);

  const setPref = useCallback((key: OverlayKey, value: boolean) => {
    setPrefs((current) => {
      const next = { ...current, [key]: value };
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // best-effort write; ignore quota / privacy errors
      }
      return next;
    });
  }, []);

  return [prefs, setPref];
}
