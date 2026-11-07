/**
 * The chart header's live / delayed / offline marker.
 *
 * Council 2026-11-06-go1106-ux (Trader, First-timer): "the chart box says 'Offline' ... while the header shows LIVE."
 * The marker counted only the indexer's `tick` pushes (lib/chart/live-client.ts). The v2.2 price-WS publishes the
 * display price (`type: "price"`, lib/priceStore) and no ticks, so the chart sat at Offline while the price on the
 * same page kept moving. A display-price update is a live price too: the marker uses the newer of the two.
 */
export type ChartLiveState = "live" | "delayed" | "offline";

export const CHART_DELAYED_AFTER_MS = 10_000;
export const CHART_OFFLINE_AFTER_MS = 60_000;

export function chartLiveState(p: { tickAt: number | null; displayAt: number | null; now: number }): {
  state: ChartLiveState;
  ageMs: number | null;
} {
  const last = p.tickAt === null ? p.displayAt : p.displayAt === null ? p.tickAt : Math.max(p.tickAt, p.displayAt);
  if (last === null) return { state: "offline", ageMs: null };
  const ageMs = Math.max(0, p.now - last);
  const state: ChartLiveState = ageMs > CHART_OFFLINE_AFTER_MS ? "offline" : ageMs > CHART_DELAYED_AFTER_MS ? "delayed" : "live";
  return { state, ageMs };
}
