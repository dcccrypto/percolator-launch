"use client";

import { useState, useEffect } from "react";

/**
 * Returns true when the viewport is >= 1024px (Tailwind `lg` breakpoint).
 *
 * Lazy-initialized from the media query so the FIRST client render already
 * matches the viewport. Previously this always started `false` and a post-mount
 * effect flipped it true, so on desktop the MOBILE branch mounted first (creating
 * a TradingChart), then the effect swapped to the DESKTOP branch (creating a
 * SECOND chart) — a visible flicker + wasted lightweight-charts create/destroy on
 * every desktop load of the trade terminal.
 *
 * SSR-safe: `window` is undefined server-side (→ false), and the only consumer
 * (the trade page) renders its loading skeleton — never the desktop/mobile fork —
 * until the slab loads client-side, so this value is never part of the hydrated
 * DOM and cannot cause a hydration mismatch.
 */
export function useIsLargeScreen(): boolean {
  const [isLarge, setIsLarge] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches,
  );

  useEffect(() => {
    const mql = window.matchMedia("(min-width: 1024px)");
    setIsLarge(mql.matches);
    const handler = (e: MediaQueryListEvent) => setIsLarge(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  return isLarge;
}
