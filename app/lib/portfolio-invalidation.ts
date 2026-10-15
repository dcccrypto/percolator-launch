/**
 * "Your portfolio just changed" — a notification any component can send,
 * without holding a `usePortfolio()` instance.
 *
 * The site-wide PositionsBar reads `usePortfolio`, whose position list
 * refreshes on a 30s interval. Closing a position already short-circuits that:
 * `OtherMarketPositions` passes `onClosed={portfolio.refresh}`, and `refresh()`
 * forces a load plus a reconciliation burst. Opening one does not — OrderTicket
 * only calls `refreshSlab()`, which updates the trade page's own dock (via the
 * slab-bytes scan) and tells the portfolio nothing. So a freshly opened
 * position can take up to 30 seconds to appear in the header bar, while the
 * same position shows on the trade page almost immediately.
 *
 * OrderTicket cannot simply call `portfolio.refresh()`: `usePortfolio` is
 * described in PositionsBar's own comment as "a genuinely expensive hook —
 * full market discovery", and mounting a second instance inside the order
 * ticket to obtain a refresh function would be the wrong trade. A module-level
 * notification costs nothing and is the pattern this repo already uses in four
 * places (subscribePortfolioScan, subscribeHeldNftScan, subscribeSlab,
 * subscribePerfSamples).
 *
 * Why a burst rather than one refresh: an immediate re-read comes back through
 * /api/rpc's account-data cache (getAccountInfo ~1s, getProgramAccounts ~1.5s)
 * and re-publishes the PRE-change snapshot. `usePortfolio.refresh` already
 * schedules follow-ups for exactly this reason; the schedule lives here so the
 * open and close paths cannot drift apart.
 */

/**
 * Follow-up refresh offsets, in ms after the triggering action.
 *
 * Mirrors useTrade's own reconciliation timings. The first entry is past the
 * ~1.5s getProgramAccounts cache window; the last is the point where waiting
 * longer stops helping and the 30s poll is the backstop anyway.
 */
export const PORTFOLIO_RECONCILE_MS: readonly number[] = [1400, 2600, 4000];

type Listener = () => void;

const listeners = new Set<Listener>();

/** Subscribe to portfolio-changed notifications. Returns an unsubscriber. */
export function subscribePortfolioInvalidation(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Follow-up offsets for reads served by the indexer (trade history, trader
 * stats). The indexer lags the chain by a few seconds (lib/chart/trade-feed.ts
 * looks back 15s for the same reason), and unlike usePortfolio these readers
 * have no 30s poll to fall back on, so the tail runs longer.
 */
export const INDEXER_RECONCILE_MS: readonly number[] = [...PORTFOLIO_RECONCILE_MS, 8_000, 15_000];

/**
 * Run `reload` on every invalidation: once immediately, then at each offset.
 * A new invalidation restarts the schedule instead of stacking a second one
 * (a full close can fire two). The returned unsubscriber also cancels any
 * follow-ups still pending, so an unmounted or wallet-switched consumer is not
 * reloaded afterwards.
 */
export function subscribePortfolioReload(
  reload: () => void,
  offsets: readonly number[] = PORTFOLIO_RECONCILE_MS,
): () => void {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const cancel = () => {
    timers.forEach(clearTimeout);
    timers.clear();
  };
  const unsubscribe = subscribePortfolioInvalidation(() => {
    cancel();
    reload();
    for (const ms of offsets) {
      const t = setTimeout(() => {
        timers.delete(t);
        reload();
      }, ms);
      timers.add(t);
    }
  });
  return () => {
    unsubscribe();
    cancel();
  };
}

/**
 * Announce that the connected wallet's portfolio changed on chain.
 *
 * Safe to call with no subscribers (the trade page may be the only mounted
 * consumer), and a throwing listener must not prevent the others from running
 * — one broken widget should not stop the header bar from updating.
 */
export function invalidatePortfolio(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A listener that throws is that component's problem, not ours.
    }
  }
}

/** Test seam: drop all listeners. Not used in application code. */
export function __resetPortfolioInvalidationForTests(): void {
  listeners.clear();
}
