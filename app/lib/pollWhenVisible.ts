/**
 * Visibility-gated polling helper.
 *
 * Most recurring pollers in this app (`setInterval` fetch loops in hooks and
 * components) should NOT keep hitting the rate-limited devnet RPC / API routes
 * while the tab is hidden — a backgrounded trade tab was measured burning
 * ~15-20 requests/min for data nobody is looking at. `usePortfolio` already
 * hand-rolls this gate (visibilitychange listener + `document.visibilityState`
 * check inside its interval); this module is that same pattern, shared, so
 * every poller doesn't re-implement it slightly differently.
 *
 * Semantics:
 * - `tick` runs on the interval ONLY while the page is visible.
 * - When the page becomes visible again after being hidden, `tick` fires
 *   immediately (catch-up refresh — same behavior usePortfolio and
 *   SlabProvider already ship), then the interval cadence resumes.
 * - SSR-safe: no-ops (returns a no-op disposer) when `document` is undefined.
 *
 * Returns a disposer — call it in the effect cleanup.
 */
export function pollWhenVisible(tick: () => void, intervalMs: number): () => void {
  if (typeof document === "undefined") return () => {};

  const guarded = () => {
    if (document.visibilityState === "visible") tick();
  };

  const onVisibilityChange = () => {
    // Catch-up run the moment the user comes back to the tab.
    if (document.visibilityState === "visible") tick();
  };

  const interval = setInterval(guarded, intervalMs);
  document.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    clearInterval(interval);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
