/**
 * v2.2 QA minor: the v2.2 preview has no trade indexer (draft #218 is not deployed). Screens that read indexer data
 * (candles, trade history, trader stats) do not ask for it there, so the page shows a calm "no history on this test
 * build" state instead of 404s and a warning. `NEXT_PUBLIC_V22_INDEXER_LOT_AWARE=1` (set once a lot-aware v2.2 indexer
 * is attested, see lib/trade-stats-display.ts) turns the requests back on. Flag off: always false (unchanged).
 */
import { isDevnetV22Enabled } from "./flag";

export function v22HasNoIndexer(): boolean {
  return isDevnetV22Enabled() && process.env.NEXT_PUBLIC_V22_INDEXER_LOT_AWARE !== "1";
}

export const NO_HISTORY_COPY = {
  title: "No trade history on this test build",
  body: "Trades on Devnet v2.2 are on chain; the history view is not connected here yet.",
} as const;
