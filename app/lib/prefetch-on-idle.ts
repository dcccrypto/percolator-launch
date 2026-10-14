"use client";

/**
 * Warm code-split chunks once the page is idle, so a tab that was split out of the first-load
 * bundle still opens instantly when the user clicks it. `requestIdleCallback` where the browser
 * has it (not Safari), otherwise a short timeout. Failures are ignored: the import runs again,
 * for real, when the tab mounts.
 */
export function prefetchOnIdle(loaders: ReadonlyArray<() => Promise<unknown>>): () => void {
  if (typeof window === "undefined" || loaders.length === 0) return () => {};
  const run = () => {
    for (const load of loaders) load().catch(() => {});
  };
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  if (w.requestIdleCallback) {
    const id = w.requestIdleCallback(run, { timeout: 4000 });
    return () => w.cancelIdleCallback?.(id);
  }
  const t = window.setTimeout(run, 1500);
  return () => window.clearTimeout(t);
}
