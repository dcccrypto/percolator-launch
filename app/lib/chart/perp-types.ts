/**
 * Shared wire + data types for the perp-standard chart (mark / oracle / last).
 *
 * This file is imported by the price-ws server (scripts/), the Next route
 * handlers and the browser, so it must stay dependency-free and isomorphic.
 *
 * Series semantics (what each candle series IS):
 *  - mark   : the AUTH_MARK the keeper pushes on-chain (breaker-accepted price), one
 *             observation per landed push (~1.5 s per market).
 *  - oracle : the raw DEX-pool price the keeper read for that same push (pre-smoothing).
 *  - last   : last executed Percolator trade (served by the existing /api/candles route).
 * Only `mark` and `oracle` are built from ticks; `last` is built from trades.
 */

export const TICK_SERIES = ["mark", "oracle"] as const;
export type TickSeries = (typeof TICK_SERIES)[number];
export const PERP_SERIES = ["mark", "oracle", "last"] as const;
export type PerpSeries = (typeof PERP_SERIES)[number];

export function isPerpSeries(v: unknown): v is PerpSeries {
  return typeof v === "string" && (PERP_SERIES as readonly string[]).includes(v);
}
export function isTickSeries(v: unknown): v is TickSeries {
  return typeof v === "string" && (TICK_SERIES as readonly string[]).includes(v);
}

/** Candle resolutions, in minutes (1440 = 1D). Same set the TV provider uses. */
export const CANDLE_RES_MINUTES = [1, 5, 15, 60, 240, 1440] as const;
export type CandleResMinutes = (typeof CANDLE_RES_MINUTES)[number];

/** TradingView-style resolution string used by the app ("1","5","15","60","240","1D"). */
export type ChartResolution = "1" | "5" | "15" | "60" | "240" | "1D";
export const CHART_RESOLUTIONS: readonly ChartResolution[] = ["1", "5", "15", "60", "240", "1D"];

export function resolutionToMinutes(res: string): CandleResMinutes | null {
  switch (res) {
    case "1": return 1;
    case "5": return 5;
    case "15": return 15;
    case "60": return 60;
    case "240": return 240;
    case "1D": case "D": case "1440": return 1440;
    default: return null;
  }
}

export interface Candle {
  /** Bucket open time, seconds since epoch (UTC), aligned to the resolution. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Number of observations folded in (mark/oracle) — NOT a volume. */
  n: number;
}

/**
 * A mark/oracle observation as the server fans it out to browsers.
 * `mark`/`oracle` are USD floats. Either may be null (oracle is null when the keeper had no
 * raw reading for that market this cycle).
 */
export interface TickMessage {
  type: "tick";
  slab: string;
  /** Server boot id; seq restarts at 1 when it changes. */
  epoch: string;
  /** Strictly increasing per (epoch, slab). */
  seq: number;
  /** Solana slot of the push batch. */
  slot: number;
  /** Keeper wall-clock when the push landed (ms). The candle bucket time. */
  landedMs: number;
  /** Server wall-clock when the tick was received from the keeper (ms). */
  recvMs: number;
  mark: number | null;
  oracle: number | null;
}

/** What the keeper POSTs (contract v1, see percolator-oracle-keeper tick-publisher.ts). */
export interface IngestTick {
  slab: string;
  assetIndex: number;
  slot: number;
  landedMs: number;
  markE6: string;
  oracleE6: string | null;
}
export interface IngestBody {
  v: 1;
  src: "keeper";
  sentMs: number;
  ticks: IngestTick[];
}

export const MAX_INGEST_TICKS = 200;
