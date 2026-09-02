/**
 * indexer-db.ts
 *
 * Direct Postgres read path for the playground terminal.
 * Used by the /api/markets/[slab]/trades, /api/funding/[slab]/history,
 * and /api/candles/[slab] routes when INDEXER_DATABASE_URL is set.
 *
 * The v17 indexer (percolator-indexer @ v17-sdk-migration) writes to the
 * same Postgres database this module reads from.  No Supabase SDK is used —
 * queries go over a plain postgres:// connection string so the playground
 * can run against any Postgres instance (local or hosted).
 *
 * Schema (from percolator-indexer/migrations):
 *   trades            — id, slab_address, trader, tx_signature, side, size,
 *                       price, fee, created_at (timestamptz), network,
 *                       asset_index (nullable, added by 20260627_asset_index.sql)
 *   funding_history   — id, market_slab, slot, rate_bps_per_slot, net_lp_pos,
 *                       price_e6, funding_index_qpb_e6, timestamp (timestamptz),
 *                       network
 */

// Loaded only in Node.js (Next.js server-side route handlers, never the browser).
// The import is dynamic so bundling for the browser never fails.
import postgres from "postgres";
import { getServerNetwork } from "./supabase";

// ── connection pool ─────────────────────────────────────────────────────────

let _sql: ReturnType<typeof postgres> | null = null;

/**
 * Returns true when INDEXER_DATABASE_URL is set.
 * Routes use this to decide: direct DB vs proxy-to-api.
 */
export function hasIndexerDb(): boolean {
  return !!process.env.INDEXER_DATABASE_URL;
}

function getSql(): ReturnType<typeof postgres> {
  if (!_sql) {
    const url = process.env.INDEXER_DATABASE_URL;
    if (!url) throw new Error("INDEXER_DATABASE_URL is not set");
    _sql = postgres(url, {
      max: 5,                 // small pool — route handlers are short-lived
      idle_timeout: 20,       // seconds
      connect_timeout: 10,    // seconds
      ssl: url.includes("localhost") || url.includes("127.0.0.1")
        ? false
        : { rejectUnauthorized: false }, // allow self-signed for RDS / Supabase direct
    });
  }
  return _sql;
}

// ── types ───────────────────────────────────────────────────────────────────

export interface IndexerTrade {
  id: string;
  slab_address: string;
  trader: string;
  tx_signature: string;
  side: "long" | "short";
  size: string;   // raw i128 as string
  price: string;  // price_e6 as string (numeric column)
  fee: string;
  created_at: string; // ISO string
  asset_index: number | null;
}

export interface IndexerFundingPoint {
  slot: number;
  rateBpsPerSlot: number;
  netLpPos: string;
  priceE6: string;
  fundingIndexQpbE6: string;
  /** ISO string from the DB */
  timestampIso: string;
  /** Unix milliseconds — what the FundingRateChart component expects */
  timestamp: number;
  /** Pre-computed hourly rate percent — what the FundingRateChart component expects */
  hourlyRatePercent: number;
}

interface RawTradeRow {
  id: string;
  slab_address: string;
  trader: string;
  tx_signature: string;
  side: string;
  size: string;
  price: string;
  fee: string;
  created_at: Date;
  asset_index: number | null;
}

interface RawFundingRow {
  slot: string;
  rate_bps_per_slot: string;
  net_lp_pos: string;
  price_e6: string;
  funding_index_qpb_e6: string;
  timestamp: Date;
}

interface RawCandleRow {
  price: string;
  size: string;
  created_at: Date;
}

// ── helpers ──────────────────────────────────────────────────────────────────

const SLOTS_PER_HOUR = 9000;

function toHourlyPercent(rateBpsPerSlot: number): number {
  // rateBps * slots/hr → hourly bps → divide by 100 → percent
  return (rateBpsPerSlot * SLOTS_PER_HOUR) / 100;
}

/** Validate that a slab address looks like a base-58 pubkey (prevents injection). */
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export function isValidSlab(slab: string): boolean {
  return BASE58_RE.test(slab);
}

// ── queries ──────────────────────────────────────────────────────────────────

/**
 * Recent trades for a market, newest first.
 * limit is capped at 200 by the caller.
 */
export async function queryTrades(
  slabAddress: string,
  limit: number,
): Promise<IndexerTrade[]> {
  const sql = getSql();
  const rows = await sql<RawTradeRow[]>`
    SELECT
      id, slab_address, trader, tx_signature, side,
      size::text AS size, price::text AS price, fee::text AS fee,
      created_at, asset_index
    FROM trades
    WHERE slab_address = ${slabAddress}
      AND network = ${getServerNetwork()}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    id: r.id,
    slab_address: r.slab_address,
    trader: r.trader,
    tx_signature: r.tx_signature,
    side: r.side as "long" | "short",
    size: r.size,
    price: r.price,
    fee: r.fee,
    created_at: r.created_at instanceof Date
      ? r.created_at.toISOString()
      : String(r.created_at),
    asset_index: r.asset_index ?? null,
  }));
}

/**
 * Funding rate history for a market, oldest first (chart time-series).
 * When `sinceIso` is provided, only returns rows at or after that timestamp.
 *
 * REDUCED SCHEMA (2026-07): the indexer was cut down to history-only and the
 * `funding_history` table was dropped from the new Supabase project — querying
 * it would 500. This function is kept (signature unchanged) as a stable no-op
 * so callers keep working; funding history is simply no longer indexed. The
 * current funding rate is available live from chain instead (see the wrapper
 * config parse used by the trade page), not from this historical series.
 */
export async function queryFundingHistory(
  _slabAddress: string,
  _limit: number,
  _sinceIso?: string,
): Promise<IndexerFundingPoint[]> {
  return [];
}

/**
 * Raw trades (price + size + created_at) for a slab in a time window.
 * Used by the /api/candles route to build OHLCV bars in-process.
 */
export async function queryTradesForCandles(
  slabAddress: string,
  fromSec: number,
  toSec: number,
  maxRows = 50_000,
): Promise<RawCandleRow[]> {
  const sql = getSql();
  const fromIso = new Date(fromSec * 1000).toISOString();
  const toIso   = new Date(toSec   * 1000).toISOString();
  return sql<RawCandleRow[]>`
    SELECT price::text AS price, size::text AS size, created_at
    FROM trades
    WHERE slab_address = ${slabAddress}
      AND network = ${getServerNetwork()}
      AND created_at >= ${fromIso}::timestamptz
      AND created_at <= ${toIso}::timestamptz
    ORDER BY created_at ASC
    LIMIT ${maxRows}
  `;
}

// ── OHLCV bucketing (ported from percolator-api/src/routes/candles.ts) ──────

export interface UdfResponse {
  s: "ok" | "no_data" | "error";
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
  errmsg?: string;
}

export function emptyUdf(status: "no_data" | "error", errmsg?: string): UdfResponse {
  return { s: status, t: [], o: [], h: [], l: [], c: [], v: [], ...(errmsg ? { errmsg } : {}) };
}

/**
 * Bucket raw trade rows (ascending `created_at`) into TradingView UDF candles.
 */
export function bucketCandles(
  rows: { price: string; size: string; created_at: Date | string }[],
  bucketSeconds: number,
): UdfResponse {
  if (rows.length === 0) return emptyUdf("no_data");

  const bars = new Map<number, { o: number; h: number; l: number; c: number; v: number }>();

  for (const r of rows) {
    const tsMs = r.created_at instanceof Date
      ? r.created_at.getTime()
      : new Date(r.created_at).getTime();
    const tsSec   = Math.floor(tsMs / 1000);
    const bucket  = Math.floor(tsSec / bucketSeconds) * bucketSeconds;
    const price   = Number(r.price);
    const size    = Math.abs(Number(r.size));
    if (!Number.isFinite(price) || !Number.isFinite(size)) continue;

    const existing = bars.get(bucket);
    if (!existing) {
      bars.set(bucket, { o: price, h: price, l: price, c: price, v: size });
    } else {
      if (price > existing.h) existing.h = price;
      if (price < existing.l) existing.l = price;
      existing.c = price;
      existing.v += size;
    }
  }

  const sortedKeys = [...bars.keys()].sort((a, b) => a - b);
  const out: UdfResponse = { s: "ok", t: [], o: [], h: [], l: [], c: [], v: [] };
  for (const k of sortedKeys) {
    const b = bars.get(k)!;
    out.t.push(k);
    out.o.push(b.o);
    out.h.push(b.h);
    out.l.push(b.l);
    out.c.push(b.c);
    out.v.push(b.v);
  }
  return out;
}

export const RES_TO_SECONDS: Record<string, number> = {
  "1":   60,
  "5":   5 * 60,
  "15":  15 * 60,
  "60":  60 * 60,
  "240": 4 * 60 * 60,
  "1D":  24 * 60 * 60,
};

// ── protocol-wide stats ──────────────────────────────────────────────────────

export interface StatsAggregate {
  /** Number of distinct markets with at least one recorded trade. */
  marketCount: number;
  uniqueTraders: number;
  trades24h: number;
  /**
   * B: 24h trade volume in ACTUAL USD DOLLARS (not a raw collateral-atom
   * count), truncated to a whole-dollar bigint.
   *
   * `size` is a raw base-coin "Q" quantity (fixed-point, scale 1e6) — NOT a
   * collateral-token atom count, and NOT fungible across markets (100 SOL and
   * 2,000,000 PENGU are wildly different notionals). Summing raw |size|
   * directly (the previous behavior here) treated every market's base asset
   * as if it were the same $1-pegged unit. Mirrors the sibling
   * `queryLeaderboard` query below, which already multiplies by each trade's
   * own `price` (actual USD, not price_e6) before summing:
   *   SUM(ABS(size) * price / 1e6) = SUM((size/1e6) * price) = real USD.
   * Callers must NOT divide this by a collateral decimals factor — it is
   * already real dollars.
   */
  volume24hRaw: bigint;
}

/**
 * Single-query aggregate for protocol-wide stats (playground self-contained path).
 * Used by /api/stats when INDEXER_DATABASE_URL is set instead of Supabase.
 */
export async function queryStatsAggregate(): Promise<StatsAggregate> {
  const sql = getSql();
  const rows = await sql<Array<{
    market_count: string;
    unique_traders: string;
    trades_24h: string;
    volume_24h_raw: string;
  }>>`
    SELECT
      COUNT(DISTINCT slab_address)::text               AS market_count,
      COUNT(DISTINCT trader)::text                     AS unique_traders,
      COUNT(*)
        FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::text
                                                       AS trades_24h,
      COALESCE(
        SUM(ABS(size::numeric) * price::numeric / 1e6)
          FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours'),
        0
      )::text                                          AS volume_24h_raw
    FROM trades
    WHERE network = ${getServerNetwork()}
  `;
  const row = rows[0];
  return {
    marketCount:  Number(row?.market_count   ?? "0"),
    uniqueTraders: Number(row?.unique_traders ?? "0"),
    trades24h:    Number(row?.trades_24h     ?? "0"),
    // Truncates sub-dollar cents — acceptable for a display aggregate (mirrors
    // queryLeaderboard's own BigInt(...split(".")[0]) truncation below).
    volume24hRaw: BigInt((row?.volume_24h_raw ?? "0").split(".")[0]),
  };
}

/**
 * Returns the set of distinct slab addresses that appear in the trades table.
 * Capped at 100 to bound the downstream batch-RPC call for on-chain OI.
 */
export async function queryKnownSlabs(): Promise<string[]> {
  const sql = getSql();
  const rows = await sql<Array<{ slab_address: string }>>`
    SELECT DISTINCT slab_address FROM trades WHERE network = ${getServerNetwork()} LIMIT 100
  `;
  return rows.map((r) => r.slab_address);
}

// ── leaderboard / trader stats (P0 self-contained paths) ────────────────────

export interface LeaderboardRow {
  trader: string;
  tradeCount: number;
  /**
   * C: real USD dollars as a plain number (NOT a scaled bigint/atom count).
   * `SUM(ABS(size) * price / 1e6)` below is already `Σ (size/1e6) * price` =
   * real dollar notional (`size` is a fixed-point base-asset "Q" quantity,
   * scale 1e6; `price` is an actual USD float, not price_e6). Callers must
   * NOT rescale this by any collateral/base-asset decimals — see the
   * unification note on `app/api/leaderboard/route.ts`'s `LeaderboardEntry`.
   */
  totalVolume: number;
  lastTradeAt: string;
}

interface RawLeaderboardRow {
  trader: string;
  trade_count: string;
  total_volume: string;
  last_trade_at: Date;
}

/**
 * Aggregate leaderboard from local indexer trades table.
 * period: "24h" | "7d" | "alltime"
 */
export async function queryLeaderboard(
  period: string,
  limit: number,
): Promise<LeaderboardRow[]> {
  const sql = getSql();

  let rows: RawLeaderboardRow[];
  if (period === "24h") {
    rows = await sql<RawLeaderboardRow[]>`
      SELECT
        trader,
        COUNT(*)::text            AS trade_count,
        SUM(ABS(size::numeric) * price::numeric / 1e6)::text AS total_volume,
        MAX(created_at)           AS last_trade_at
      FROM trades
      WHERE created_at >= NOW() - INTERVAL '24 hours'
        AND network = ${getServerNetwork()}
      GROUP BY trader
      ORDER BY SUM(ABS(size::numeric) * price::numeric / 1e6) DESC
      LIMIT ${limit}
    `;
  } else if (period === "7d") {
    rows = await sql<RawLeaderboardRow[]>`
      SELECT
        trader,
        COUNT(*)::text            AS trade_count,
        SUM(ABS(size::numeric) * price::numeric / 1e6)::text AS total_volume,
        MAX(created_at)           AS last_trade_at
      FROM trades
      WHERE created_at >= NOW() - INTERVAL '7 days'
        AND network = ${getServerNetwork()}
      GROUP BY trader
      ORDER BY SUM(ABS(size::numeric) * price::numeric / 1e6) DESC
      LIMIT ${limit}
    `;
  } else {
    rows = await sql<RawLeaderboardRow[]>`
      SELECT
        trader,
        COUNT(*)::text            AS trade_count,
        SUM(ABS(size::numeric) * price::numeric / 1e6)::text AS total_volume,
        MAX(created_at)           AS last_trade_at
      FROM trades
      WHERE network = ${getServerNetwork()}
      GROUP BY trader
      ORDER BY SUM(ABS(size::numeric) * price::numeric / 1e6) DESC
      LIMIT ${limit}
    `;
  }

  return rows.map((r) => ({
    trader: r.trader,
    tradeCount: Number(r.trade_count),
    // Already real USD dollars (see LeaderboardRow.totalVolume's doc comment)
    // — Number(), not BigInt-truncated, so sub-dollar cents aren't lost.
    totalVolume: Number(r.total_volume),
    lastTradeAt: r.last_trade_at instanceof Date
      ? r.last_trade_at.toISOString()
      : String(r.last_trade_at),
  }));
}

export interface TraderStatsRow {
  side: string;
  size: string;
  price: string;
  fee: string;
  slab_address: string;
  created_at: string;
}

/**
 * GH#2510: aggregate a wallet's trade statistics in the DATABASE, over its full
 * history.
 *
 * `queryTraderStatsRows` below fetches at most 10 000 rows and the route reduces
 * them in JavaScript, so any wallet past that cap had its partial history
 * returned as exact totals — with no flag to say so. The cap also orders by
 * `created_at ASC`, so it keeps the OLDEST 10 000: `lastTradeAt` was not merely
 * approximate, it was the timestamp of the 10 000th trade rather than the most
 * recent one.
 *
 * The arithmetic mirrors the JS reducer PER ROW, which is subtler than it looks
 * and got it wrong on the first attempt (caught in review on #2512):
 *
 *   volume += trunc(abs(trunc(size)) * floor(price * 1e6 + 0.5) / 1e6)
 *   fees   += floor(fee + 0.5)
 *
 * Two details the obvious translation misses:
 *
 * 1. The reducer accumulates with BigInt division — `(absSize * priceE6) / 1e6n`
 *    — which TRUNCATES on every trade. Summing the fractional values and
 *    rounding once at the end is a different number, and not by a rounding
 *    error: ten trades of size 1 at price 1.9 give 10 the per-row way and 19
 *    the sum-then-round way. The per-row `trunc()` is load-bearing.
 * 2. `::bigint` ROUNDS in Postgres, so a fractional total would round up rather
 *    than truncate. With per-row truncation the sum is already integral, so the
 *    cast is exact.
 *
 * `floor(x + 0.5)` rather than `round()` because that is what JS `Math.round`
 * does: they disagree on negative halves (`Math.round(-1.5) === -1`, while
 * Postgres `round(-1.5) = -2`).
 *
 * `size` is truncated at the decimal point to match the reducer's
 * `String(size).split(".")[0]`, and the sums stay in `numeric`, so this does not
 * inherit the float rounding a `Number()` round-trip would introduce.
 */
export interface TraderStatsAggregate {
  totalTrades: number;
  longTrades: number;
  shortTrades: number;
  totalVolume: string;
  totalFees: string;
  uniqueMarkets: number;
  firstTradeAt: string | null;
  lastTradeAt: string | null;
}

export async function queryTraderStatsAggregate(
  wallet: string,
): Promise<TraderStatsAggregate> {
  const sql = getSql();
  const rows = await sql<Array<{
    total_trades: string;
    long_trades: string;
    short_trades: string;
    total_volume: string;
    total_fees: string;
    unique_markets: string;
    first_trade_at: Date | null;
    last_trade_at: Date | null;
  }>>`
    SELECT
      count(*)::text                                            AS total_trades,
      count(*) FILTER (WHERE side = 'long')::text               AS long_trades,
      count(*) FILTER (WHERE side <> 'long')::text              AS short_trades,
      COALESCE(sum(trunc(
        abs(trunc(size::numeric)) * floor(price::numeric * 1000000 + 0.5) / 1000000
      )), 0)::bigint::text                                      AS total_volume,
      COALESCE(sum(floor(fee::numeric + 0.5)), 0)::bigint::text AS total_fees,
      count(DISTINCT slab_address)::text                        AS unique_markets,
      min(created_at)                                           AS first_trade_at,
      max(created_at)                                           AS last_trade_at
    FROM trades
    WHERE trader = ${wallet}
  `;
  const r = rows[0];
  const iso = (d: Date | null) =>
    d == null ? null : d instanceof Date ? d.toISOString() : String(d);
  return {
    totalTrades: Number(r?.total_trades ?? 0),
    longTrades: Number(r?.long_trades ?? 0),
    shortTrades: Number(r?.short_trades ?? 0),
    totalVolume: r?.total_volume ?? "0",
    totalFees: r?.total_fees ?? "0",
    uniqueMarkets: Number(r?.unique_markets ?? 0),
    firstTradeAt: iso(r?.first_trade_at ?? null),
    lastTradeAt: iso(r?.last_trade_at ?? null),
  };
}

/**
 * Fetch all trade rows for a wallet for stats aggregation.
 * Returns at most 10 000 rows (same cap as the Supabase path).
 *
 * GH#2510: no longer used by /api/trader/:wallet/stats, which aggregates in the
 * database via queryTraderStatsAggregate. Kept for callers that need the rows
 * themselves rather than the totals.
 */
export async function queryTraderStatsRows(wallet: string): Promise<TraderStatsRow[]> {
  const sql = getSql();
  const rows = await sql<Array<{
    side: string;
    size: string;
    price: string;
    fee: string;
    slab_address: string;
    created_at: Date;
  }>>`
    SELECT side, size::text AS size, price::text AS price,
           fee::text AS fee, slab_address, created_at
    FROM trades
    WHERE trader = ${wallet}
      AND network = ${getServerNetwork()}
    ORDER BY created_at ASC
    LIMIT 10000
  `;
  return rows.map((r) => ({
    side: r.side,
    size: r.size,
    price: r.price,
    fee: r.fee,
    slab_address: r.slab_address,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
}

export interface TraderTradesPageResult {
  trades: IndexerTrade[];
  total: number;
}

/**
 * Paginated trade history for a specific wallet, optionally filtered by slab.
 */
export async function queryTraderTradesPage(
  wallet: string,
  limit: number,
  offset: number,
  slabFilter?: string,
): Promise<TraderTradesPageResult> {
  const sql = getSql();

  // Get total count
  const countRows = slabFilter
    ? await sql<Array<{ cnt: string }>>`
        SELECT COUNT(*)::text AS cnt FROM trades
        WHERE trader = ${wallet} AND slab_address = ${slabFilter}
          AND network = ${getServerNetwork()}
      `
    : await sql<Array<{ cnt: string }>>`
        SELECT COUNT(*)::text AS cnt FROM trades
        WHERE trader = ${wallet}
          AND network = ${getServerNetwork()}
      `;
  const total = Number(countRows[0]?.cnt ?? "0");

  // Get page
  const tradeRows: Array<{
    id: string;
    slab_address: string;
    trader: string;
    side: string;
    size: string;
    price: string;
    fee: string;
    tx_signature: string | null;
    created_at: Date;
    asset_index: number | null;
  }> = slabFilter
    ? await sql`
        SELECT id, slab_address, trader, side, size::text AS size,
               price::text AS price, fee::text AS fee, tx_signature,
               created_at, asset_index
        FROM trades
        WHERE trader = ${wallet} AND slab_address = ${slabFilter}
          AND network = ${getServerNetwork()}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `
    : await sql`
        SELECT id, slab_address, trader, side, size::text AS size,
               price::text AS price, fee::text AS fee, tx_signature,
               created_at, asset_index
        FROM trades
        WHERE trader = ${wallet}
          AND network = ${getServerNetwork()}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;

  const trades: IndexerTrade[] = tradeRows.map((r) => ({
    id: String(r.id),
    slab_address: r.slab_address,
    trader: r.trader,
    tx_signature: r.tx_signature ?? "",
    side: r.side as "long" | "short",
    size: r.size,
    price: r.price,
    fee: r.fee,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    asset_index: r.asset_index ?? null,
  }));

  return { trades, total };
}

// ── funding/global local fallback ────────────────────────────────────────────

export interface FundingGlobalLocalEntry {
  slabAddress: string;
  rateBpsPerSlot: number;
  hourlyRatePercent: number;
  dailyRatePercent: number;
  netLpPos: number;
}

/**
 * Aggregate latest funding rate per market from the local indexer.
 * Used as fallback when Railway /funding/global is unavailable.
 *
 * REDUCED SCHEMA (2026-07): `funding_history` no longer exists in the reduced
 * indexer DB — funding history isn't indexed anymore. Kept as a stable no-op
 * (signature unchanged) so /api/funding/global's fallback path degrades to an
 * empty markets list instead of a 500. The current rate per market is read
 * live from chain elsewhere, not from this aggregate.
 */
export async function queryFundingGlobal(): Promise<FundingGlobalLocalEntry[]> {
  return [];
}
