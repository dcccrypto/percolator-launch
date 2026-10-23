"use client";

import { useCallback, useEffect, useState } from "react";

/** The bit of the Navigation API used below; not in this TypeScript's DOM lib yet. */
type NavigationLike = EventTarget;

/**
 * A hub page's active tab, kept in the URL hash (/portfolio#wallet, /earn#stake).
 *
 * The tab follows the URL whenever it changes, not only on mount: a hash link, Back / Forward
 * (`hashchange` / `popstate`), and a Next <Link> to the bare hub path from inside the hub (the
 * header's Portfolio link while on #wallet). That last one is a history.pushState with no
 * hashchange / popstate and no re-render, so it's picked up through the Navigation API's
 * `currententrychange` where the browser has it. A missing or unknown hash shows `fallback`.
 * Read in effects (never during render) so SSR and hydration don't touch `window`, and without
 * next/navigation's useSearchParams, which would put the page behind a Suspense boundary.
 */
export function useHashTab<K extends string>(isKey: (value: string) => value is K, fallback: K) {
  const [tab, setTab] = useState<K>(fallback);

  useEffect(() => {
    const sync = () => {
      const hash = window.location.hash.replace(/^#/, "");
      setTab(isKey(hash) ? hash : fallback);
    };
    sync();
    const nav = (window as Window & { navigation?: NavigationLike }).navigation;
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    nav?.addEventListener("currententrychange", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
      nav?.removeEventListener("currententrychange", sync);
    };
  }, [isKey, fallback]);

  const selectTab = useCallback((key: K) => {
    setTab(key);
    // null, not history.state: Next's patched replaceState copies its own entry state over and
    // syncs its router to the new URL only when the state has no __NA marker.
    history.replaceState(null, "", "#" + key);
  }, []);

  return [tab, selectTab] as const;
}
