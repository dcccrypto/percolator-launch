/**
 * v2.2 QA Q-3 / M-2: "catching up" only when a keeper is actually expected to catch up.
 *
 * The app treated every stale price (27 OracleStale) and engine lag (19 / 20 / 21) as a few-second wait and re-simulated
 * forever. Two cases never clear on their own:
 *  - a RESOLVED market: 21 / 19 / 27 there are permanent; only close / withdraw remain;
 *  - a market whose price has not moved for minutes (no keeper is pushing it): the wait would never end.
 * Here the price age (seconds since the last on-chain mark) decides; past LONG_STALE_SECS nothing waits and the copy says
 * how old the price is instead of promising seconds.
 */
import type { SimulationRefusal } from "@/lib/tx";

/** A keeper pushes every few seconds; five minutes without a new mark means nobody is pushing this market. */
export const LONG_STALE_SECS = 300;

/** v2.2 QA Q-7: how long the ticket keeps re-simulating a waitable refusal before giving up with a clear line. */
export const TRADE_WAIT_BUDGET_MS = 120_000;

export function isLongStale(priceAgeSecs: number | null | undefined): boolean {
  return typeof priceAgeSecs === "number" && Number.isFinite(priceAgeSecs) && priceAgeSecs >= LONG_STALE_SECS;
}

/** "6 min", "31 h", "3 days". */
export function staleAgeLabel(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  if (s < 3_600) return `${Math.max(1, Math.floor(s / 60))} min`;
  if (s < 172_800) return `${Math.floor(s / 3_600)} h`;
  return `${Math.floor(s / 86_400)} days`;
}

export const PRICE_STALLED = {
  title: "No recent price",
  body: (secs: number) => `This market has had no new price for ${staleAgeLabel(secs)}. Trading reopens when its price updates. Nothing was sent.`,
  ticketBody: (secs: number) => `This market has had no new price for ${staleAgeLabel(secs)}. Trading reopens when its price updates.`,
  button: "No recent price",
} as const;

/**
 * For sendTxWaiting's `shouldWait`: false (surface the refusal now, no re-simulation) on a resolved market or a price
 * older than LONG_STALE_SECS; true otherwise. `get` is read at refusal time so a price that just arrived counts.
 */
export function waitPolicy(get: () => { resolved: boolean; priceAgeSecs: number | null }): (e: SimulationRefusal) => boolean {
  return () => {
    const s = get();
    return !s.resolved && !isLongStale(s.priceAgeSecs);
  };
}

/**
 * v2.2 feature check C2: ONE price-state machine for the header chip, the header status line, the header price and the ticket.
 * fresh: nothing is behind. catching-up: the price / engine is behind for under LONG_STALE_SECS (a keeper is expected to catch up).
 * no-recent-price: behind for LONG_STALE_SECS or more (nobody is pushing; the price shown is the last known one).
 * (A matured-stale market that can be settled is the resolve flow's state, not this one.)
 */
export type PriceState = "fresh" | "catching-up" | "no-recent-price";

export function derivePriceState(behind: boolean, priceAgeSecs: number | null | undefined): PriceState {
  if (!behind) return "fresh";
  return isLongStale(priceAgeSecs) ? "no-recent-price" : "catching-up";
}

/** The catching-up line, shared by the header status and the ticket so the two never differ. */
export const PRICE_CATCHING_UP = {
  title: "Catching up",
  body: "The market is catching up with the latest prices. New positions wait until it has.",
  button: "Waiting for prices\u2026",
} as const;
