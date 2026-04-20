"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "perc.ui.orderBookVisible";

function readInitial(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return true; // default: visible
    return raw !== "false";
  } catch {
    return true;
  }
}

/**
 * User preference for whether the MarketBookCard ("order book" middle panel)
 * is visible on the trade page. Persists to localStorage so the choice survives
 * page reloads / navigations.
 *
 * Returns [visible, toggle, setVisible].
 */
export function useOrderBookVisibility(): [boolean, () => void, (v: boolean) => void] {
  // SSR-safe: start with the default, then reconcile on client mount.
  const [visible, setVisibleState] = useState<boolean>(true);

  useEffect(() => {
    setVisibleState(readInitial());
  }, []);

  const setVisible = useCallback((v: boolean) => {
    setVisibleState(v);
    try {
      window.localStorage.setItem(STORAGE_KEY, v ? "true" : "false");
    } catch {
      // ignore quota / disabled storage
    }
    // Let other mounted copies of the trade page listen and update too.
    try {
      window.dispatchEvent(new CustomEvent("perc:orderBookVisible", { detail: v }));
    } catch {
      /* no-op */
    }
  }, []);

  const toggle = useCallback(() => {
    setVisible(!visible);
  }, [visible, setVisible]);

  // Listen for changes from other components using the same hook.
  useEffect(() => {
    const handler = (e: Event) => {
      const v = (e as CustomEvent<boolean>).detail;
      if (typeof v === "boolean") setVisibleState(v);
    };
    window.addEventListener("perc:orderBookVisible", handler);
    return () => window.removeEventListener("perc:orderBookVisible", handler);
  }, []);

  return [visible, toggle, setVisible];
}
