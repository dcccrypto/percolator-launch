/**
 * indexer-db.ts
 *
 * Direct Postgres read path for the playground terminal.
 * Used by the /api/markets/[slab]/trades, /api/candles/[slab], stats and trader
 * routes when INDEXER_DATABASE_URL is set.
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
 *
 * (`funding_history` was dropped in the 2026-07 history-only reduction; funding is read
 * from chain — see /api/funding/:slab and /api/funding/global.)
 */

// Loaded only in Node.js (Next.js server-side route handlers, never the browser).
// The import is dynamic so bundling for the browser never fails.
import postgres from "postgres";
import { getServerNetwork } from "./supabase";

// ── connection pool ─────────────────────────────────────────────────────────

let _sql: ReturnType<typeof postgres> | null = null;

/**
 * Returns true when INDEXER_DATABASE_URL is set.
 * Routes use this to decide whether this deployment has an indexer read path at all.
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

interface RawCandleRow {
  /** NULL for is_liquidation markers — see the guard in `bucketCandles`. */
  price: string | null;
  size: string;
  created_at: Date;
}

// ── helpers ──────────────────────────────────────────────────────────────────

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
 * Raw trades (price + size + created_at) for a slab in a time window.
 * Used by the /api/candles route to build OHLCV bars in-process.
 */
/** Row ceiling of one candle query; a result this long may have lost its oldest trades. */
export const CANDLE_TRADE_ROW_LIMIT = 50_000;

export async function queryTradesForCandles(
  slabAddress: string,
  fromSec: number,
  toSec: number,
  maxRows = CANDLE_TRADE_ROW_LIMIT,
): Promise<RawCandleRow[]> {
  const sql = getSql();
  const fromIso = new Date(fromSec * 1000).toISOString();
  const toIso   = new Date(toSec   * 1000).toISOString();
  // DESC + reverse, not ASC. The LIMIT is a real ceiling on a busy market, and
  // with ASC the rows it drops are the NEWEST ones — the chart would paint
  // history, stop at some point in the past with no indication anything was
  // missing, and leave the live bar stranded across a gap. Losing the far end
  // of history instead is merely a shorter chart. The index backing this is
  // (slab_address, network, created_at DESC), so this is also its natural
  // order. Callers still receive ascending rows.
  const rows = await sql<RawCandleRow[]>`
    SELECT price::text AS price, size::text AS size, created_at
    FROM trades
    WHERE slab_address = ${slabAddress}
      AND network = ${getServerNetwork()}
      AND created_at >= ${fromIso}::timestamptz
      AND created_at <= ${toIso}::timestamptz
    ORDER BY created_at DESC
    LIMIT ${maxRows}
  `;
  return rows.reverse();
}

/**
 * The price of the last trade strictly before `beforeSec`, or null when there is none. Seeds
 * `fillCandleGaps` so a history page that starts between trades opens on the price that was in
 * force, not on a gap. Uses the same (slab_address, network, created_at DESC) index as above.
 */
export async function queryLastTradePriceBefore(slabAddress: string, beforeSec: number): Promise<number | null> {
  const sql = getSql();
  const beforeIso = new Date(beforeSec * 1000).toISOString();
  const rows = await sql<{ price: string | null }[]>`
    SELECT price::text AS price
    FROM trades
    WHERE slab_address = ${slabAddress}
      AND network = ${getServerNetwork()}
      AND created_at < ${beforeIso}::timestamptz
      AND price IS NOT NULL
      AND price > 0
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const p = Number(rows[0]?.price);
  return Number.isFinite(p) && p > 0 ? p : null;
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
  rows: { price: string | null; size: string; created_at: Date | string }[],
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
    // A MISSING price is not a price of zero. `percolator-indexer` writes
    // NULL for is_liquidation markers (insertTradeRow.ts: "null for
    // is_liquidation markers"), and `Number(null)` is `0`, which is finite —
    // so the old guard admitted it and manufactured an o=h=l=c=0 candle. On
    // 2026-09-24 that rendered SOL-PERP as a vertical drop to zero with a
    // -100.00% badge. Require a positive price: a row without one is not a
    // trade, and contributes no volume either.
    if (r.price === null || r.price === undefined) continue;
    const price   = Number(r.price);
    const size    = Math.abs(Number(r.size));
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size)) continue;

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

/** Cap on bars a filled response may hold (about 3.5 days of 1-minute bars); the newest are kept. */
export const MAX_FILLED_BARS = 5_000;

/**
 * Make a last-trade series continuous: every empty bucket between the start and `toSec` gets a
 * flat bar at the previous close (o = h = l = c = previous close, v = 0). That is what the last
 * trade price actually did — it stays put until the next trade — and it stops a quiet market's
 * chart rendering as scattered dashes with gaps. Real (traded) bars are returned unchanged.
 *
 * Start: the bucket of `fromSec` when a `seedClose` (last trade before the window) is known,
 * otherwise the first traded bucket (never invent a price before the first trade). End: the bucket
 * of `toSec` (callers cap it at now), never earlier than the last real bar. Pure.
 */
export function fillCandleGaps(
  udf: UdfResponse,
  bucketSeconds: number,
  opts: { fromSec: number; toSec: number; seedClose: number | null; maxBars?: number },
): UdfResponse {
  if (udf.s === "error" || !(bucketSeconds > 0)) return udf;
  const maxBars = Math.max(1, Math.floor(opts.maxBars ?? MAX_FILLED_BARS));
  const seed =
    opts.seedClose != null && Number.isFinite(opts.seedClose) && opts.seedClose > 0 ? opts.seedClose : null;
  const hasRows = udf.s === "ok" && udf.t.length > 0;
  if (!hasRows && seed === null) return udf; // nothing traded, nothing known: stay "no_data"

  const bucketOf = (sec: number) => Math.floor(sec / bucketSeconds) * bucketSeconds;
  const start = seed !== null ? bucketOf(opts.fromSec) : udf.t[0];
  const lastReal = hasRows ? udf.t[udf.t.length - 1] : start;
  const end = Math.max(bucketOf(opts.toSec), lastReal);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return udf;
  const first = Math.max(start, end - (maxBars - 1) * bucketSeconds);

  const indexOf = new Map<number, number>();
  udf.t.forEach((t, i) => indexOf.set(t, i));
  let prev = seed;
  // When the cap trims old buckets, carry the close of the newest real bar before the window.
  for (let i = 0; i < udf.t.length && udf.t[i] < first; i++) prev = udf.c[i];

  const out: UdfResponse = { s: "ok", t: [], o: [], h: [], l: [], c: [], v: [] };
  for (let t = first; t <= end; t += bucketSeconds) {
    const i = indexOf.get(t);
    if (i !== undefined) {
      out.t.push(t); out.o.push(udf.o[i]); out.h.push(udf.h[i]); out.l.push(udf.l[i]); out.c.push(udf.c[i]); out.v.push(udf.v[i]);
      prev = udf.c[i];
    } else if (prev !== null) {
      out.t.push(t); out.o.push(prev); out.h.push(prev); out.l.push(prev); out.c.push(prev); out.v.push(0);
    }
  }
  return out.t.length > 0 ? out : udf;
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
  excludeSlabs: string[] = [],
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
        AND NOT (slab_address = ANY(${excludeSlabs}::text[]))
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
        AND NOT (slab_address = ANY(${excludeSlabs}::text[]))
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
        AND NOT (slab_address = ANY(${excludeSlabs}::text[]))
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
  /** Sum of `trades.fee` in micro-USD (6 decimals). The indexer records `fee` in USD. */
  totalFees: string;
  /**
   * How many of this trader's fills carry a recorded fee.
   *
   * `trades.fee` is 0 on every row today: the indexer's extractFeeFromTransfers
   * is deliberately neutered (#153) because deriving the fee from the trader's
   * SOL delta was recording collateral movements as fees. So `totalFees` being
   * "0" means "not recorded", NOT "you paid nothing" — and the UI must not
   * present the second. This count is what separates them, and it starts
   * reporting a real sum by itself once a backfill populates the column.
   */
  feesRecorded: number;
  /**
   * How many fills have no usable price, and therefore contributed nothing to
   * `totalVolume`. Same cause: extractPriceFromLogs is neutered (#150, log
   * injection) and the price is stored as 0 when the slab post-state is absent
   * from the payload. A volume figure computed over those rows is understated,
   * not wrong-by-a-rounding — it is missing whole trades.
   */
  tradesMissingPrice: number;
  uniqueMarkets: number;
  firstTradeAt: string | null;
  lastTradeAt: string | null;
}

export async function queryTraderStatsAggregate(
  wallet: string,
  excludeSlabs: string[] = [],
): Promise<TraderStatsAggregate> {
  const sql = getSql();
  const rows = await sql<Array<{
    total_trades: string;
    long_trades: string;
    short_trades: string;
    total_volume: string;
    total_fees: string;
    fees_recorded: string;
    trades_missing_price: string;
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
      COALESCE(sum(floor(fee::numeric * 1000000 + 0.5)), 0)::bigint::text AS total_fees,
      count(*) FILTER (WHERE fee > 0)::text                     AS fees_recorded,
      count(*) FILTER (WHERE price IS NULL OR price <= 0)::text AS trades_missing_price,
      count(DISTINCT slab_address)::text                        AS unique_markets,
      min(created_at)                                           AS first_trade_at,
      max(created_at)                                           AS last_trade_at
    FROM trades
    WHERE trader = ${wallet}
      AND network = ${getServerNetwork()}
      AND NOT (slab_address = ANY(${excludeSlabs}::text[]))
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
    feesRecorded: Number(r?.fees_recorded ?? 0),
    tradesMissingPrice: Number(r?.trades_missing_price ?? 0),
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
  excludeSlabs: string[] = [],
): Promise<TraderTradesPageResult> {
  const sql = getSql();

  // Get total count
  const countRows = slabFilter
    ? await sql<Array<{ cnt: string }>>`
        SELECT COUNT(*)::text AS cnt FROM trades
        WHERE trader = ${wallet} AND slab_address = ${slabFilter}
          AND network = ${getServerNetwork()}
          AND NOT (slab_address = ANY(${excludeSlabs}::text[]))
      `
    : await sql<Array<{ cnt: string }>>`
        SELECT COUNT(*)::text AS cnt FROM trades
        WHERE trader = ${wallet}
          AND network = ${getServerNetwork()}
          AND NOT (slab_address = ANY(${excludeSlabs}::text[]))
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
          AND NOT (slab_address = ANY(${excludeSlabs}::text[]))
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
          AND NOT (slab_address = ANY(${excludeSlabs}::text[]))
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

/** Liveness probe for /api/health: one trivial query, bounded. */
export async function pingIndexerDb(timeoutMs = 3000): Promise<boolean> {
  try {
    await Promise.race([
      getSql()`select 1`,
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs)),
    ]);
    return true;
  } catch {
    return false;
  }
}

// ── Earn LP-vault cost basis (percolator-indexer#207) ──────────────────────

export interface LpVaultPositionRow {
  registry: string;
  market_slab: string | null;
  lp_shares: string;
  pending_redeem_shares: string;
  cost_basis_atoms: string;
  realized_pnl_atoms: string;
  basis_known: boolean;
  updated_slot: string;
}

/**
 * The indexer's average-cost position for (market, wallet), or null if it has
 * never seen an LP-vault instruction from that wallet on that market. Amounts
 * are selected ::text so u128 values never pass through a JS number.
 */
export async function queryLpVaultPosition(
  slabAddress: string,
  wallet: string,
): Promise<LpVaultPositionRow | null> {
  const sql = getSql();
  const rows = await sql<LpVaultPositionRow[]>`
    SELECT
      registry, market_slab,
      lp_shares::text AS lp_shares,
      pending_redeem_shares::text AS pending_redeem_shares,
      cost_basis_atoms::text AS cost_basis_atoms,
      realized_pnl_atoms::text AS realized_pnl_atoms,
      basis_known,
      updated_slot::text AS updated_slot
    FROM lp_vault_positions
    WHERE network = ${getServerNetwork()}
      AND market_slab = ${slabAddress}
      AND user_wallet = ${wallet}
    LIMIT 1
  `;
  return rows[0] ?? null;
}
