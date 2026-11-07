/**
 * The ONE freshness clock for a market's price: when did this page last receive a fresh price for this slab?
 *
 * Council 2026-11-07 council-leftovers run 2 (Clerk, First-timer, Trader): the chart marker read Offline / Delayed next
 * to a green LIVE header badge and a "$" header price, and with the feed dead the header badge never went stale. The
 * three read three different things: the chart counted its own tick channel plus EVERY price-store notification
 * (a 24h-stats patch or a one-shot seed counted as "live", so a dead feed flipped Live/Delayed), and the header badge
 * looked only at the on-chain oracle. Now the chart marker, the chart price and the header badge all read this clock.
 *
 * What counts as a fresh price (writers):
 *  - an accepted live price-WS message for the slab (lib/priceStore/priceStore.ts, `handleRawMessage`), stamped on
 *    receipt, not on the animation-frame flush (a background tab throttles rAF, not the socket);
 *  - an on-chain poll that CHANGED the stored price (`applyOnChainPoll`): a keeper that is pushing moves the mark; an
 *    unchanged re-read of a stalled mark is not a fresh price;
 *  - a chart tick (mark / oracle push) from the shared live client (lib/tv/data `getLiveClient`).
 * What does not: 24h stats, DB / one-shot on-chain seeds, invert or lot-exponent corrections.
 */
import { chartLiveState, type ChartLiveState } from "@/lib/chart/live-state";

const freshAt = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();

/** Record that a fresh price for `slab` arrived at `at` (ms). Never moves the clock backwards. */
export function markPriceFresh(slab: string, at: number = Date.now()): void {
  if (!slab) return;
  const prev = freshAt.get(slab);
  if (prev !== undefined && prev >= at) return;
  freshAt.set(slab, at);
  const ls = listeners.get(slab);
  if (ls) for (const l of [...ls]) l();
}

/** When the last fresh price for `slab` arrived (ms), or null when none has on this page. */
export function getPriceFreshAt(slab: string | null): number | null {
  if (!slab) return null;
  return freshAt.get(slab) ?? null;
}

/** Called on every fresh price for `slab`. Returns the unsubscribe. */
export function subscribePriceFreshness(slab: string, onFresh: () => void): () => void {
  let set = listeners.get(slab);
  if (!set) {
    set = new Set();
    listeners.set(slab, set);
  }
  set.add(onFresh);
  return () => {
    const s = listeners.get(slab);
    if (!s) return;
    s.delete(onFresh);
    if (s.size === 0) listeners.delete(slab);
  };
}

/** live (≤ 10 s) / delayed (≤ 60 s) / offline (older, or never) — the thresholds of lib/chart/live-state.ts. */
export function priceFreshness(slab: string | null, now: number = Date.now()): { state: ChartLiveState; ageMs: number | null } {
  return chartLiveState({ tickAt: null, displayAt: getPriceFreshAt(slab), now });
}

/** Test-only: forget every slab's clock. */
export function __resetPriceFreshnessForTests(): void {
  freshAt.clear();
  listeners.clear();
}
