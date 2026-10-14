/**
 * How far back each chart timeframe asks for.
 *
 * The original table gave every timeframe roughly one screenful of bars —
 * 2h of 1-minute bars, 8h of 5-minute bars, and so on, ~96-180 bars each.
 * That is the right shape for a market that trades continuously, and the
 * wrong one for this playground, where a market may trade a handful of times
 * a day. A window sized in BARS is really a window sized in *expected trade
 * frequency*, and these markets do not meet it.
 *
 * Measured on the live playground (SOL-PERP, the only devnet market with real
 * trades) while diagnosing a chart reported as "one line, or nothing":
 *
 *   timeframe   shipped window   bars returned   all-time bars
 *   1m          2h               none            6
 *   5m          8h               1               5
 *   15m         24h              1               5
 *
 * The data was there the whole time; the window excluded it. Its most recent
 * 1-minute bar was 2.6h old against a 2.0h window. "One line" was literally a
 * single bar, and the near-empty result then tripped the <10-bar threshold in
 * TradingChart, which silently swapped the market's own trades for an
 * external spot series — so the chart could look fine, wrong, or empty
 * depending on whether the token happened to have one.
 *
 * So the windows are sized by what they must CATCH rather than by how many
 * bars a liquid market would fill them with. The bar ceilings below are the
 * cost of that, and are kept within what the renderer handles comfortably.
 */

export type ChartTimeframe =
  | "1m" | "5m" | "15m" | "1h" | "4h" | "1d" | "7d" | "30d";

export interface ChartWindow {
  /** Seconds per bar. */
  bucketSec: number;
  /** How far back to request. */
  lookbackSec: number;
}

/*
 * NOTE: the resolution STRING deliberately stays with each hook.
 * usePercolatorCandles talks to our UDF route, which wants "1D"; another
 * upstream may spell the same resolution differently, so only the windows are
 * shared here, because only the windows were the bug.
 */

const HOUR = 3600;
const DAY = 86_400;

/**
 * Sanity ceiling on any lookback window (5 years). Nothing on-chain or on the
 * DEX side is older than this, and it keeps a mistyped `+ 3650 * DAY` from
 * turning every poll into an all-of-history read. Asserted in the tests, with
 * margin.
 */
export const MAX_LOOKBACK_SPAN_SEC = 5 * 365 * DAY;


/**
 * A sparse market must still chart. Each window is at least this long, so a
 * market that trades a few times a day has something to show on every
 * timeframe rather than only the long ones.
 */
export const MIN_WINDOW_SEC = DAY;

/**
 * Upper bound on bars per request, so widening a window cannot produce a
 * payload the chart cannot draw. Asserted over every entry below by
 * __tests__/lib/chart-window.test.ts.
 *
 * NOTE what this does NOT bound: the ROWS the server reads. /api/candles now
 * aggregates in Postgres (queryCandlesAggregated, CANDLE_MAX_BARS bars out),
 * and a single daily bucket can be backed by millions of trades, so a bar
 * ceiling says nothing about the rows scanned. Separate limits.
 */
export const MAX_BARS_PER_REQUEST = 4000;


export const CHART_WINDOWS: Record<ChartTimeframe, ChartWindow> = {
  //                                              window        max bars
  "1m":  { bucketSec: 60,        lookbackSec: 2 * DAY },     // 2880  (margin past a >24h idle gap)
  "5m":  { bucketSec: 5 * 60,    lookbackSec: 5 * DAY },     // 1440
  "15m": { bucketSec: 15 * 60,   lookbackSec: 14 * DAY },    // 1344
  "1h":  { bucketSec: HOUR,      lookbackSec: 45 * DAY },    // 1080
  "4h":  { bucketSec: 4 * HOUR,  lookbackSec: 180 * DAY },   // 1080
  "1d":  { bucketSec: DAY,       lookbackSec: 1095 * DAY },  // 1095
  "7d":  { bucketSec: DAY,       lookbackSec: 1460 * DAY },  // 1460  (4y, inside the 5y span ceiling)
  "30d": { bucketSec: DAY,       lookbackSec: 1700 * DAY },  // 1700  (~4.66y, inside the 5y span ceiling)
};

/** Worst-case bar count for a timeframe — every bucket in the window filled. */
export function maxBarsFor(tf: ChartTimeframe): number {
  const w = CHART_WINDOWS[tf];
  return Math.ceil(w.lookbackSec / w.bucketSec);
}

/**
 * Would a market whose most recent trade is `ageSec` old appear on this
 * timeframe? The question the shipped windows answered "no" to for a market
 * that had traded 2.6 hours earlier.
 */
export function windowCovers(tf: ChartTimeframe, ageSec: number): boolean {
  return ageSec <= CHART_WINDOWS[tf].lookbackSec;
}
