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
 */
export async function queryFundingHistory(
  slabAddress: string,
  limit: number,
  sinceIso?: string,
): Promise<IndexerFundingPoint[]> {
  const sql = getSql();

  let rows: RawFundingRow[];
  if (sinceIso) {
    rows = await sql<RawFundingRow[]>`
      SELECT slot, rate_bps_per_slot, net_lp_pos, price_e6,
             funding_index_qpb_e6, timestamp
      FROM funding_history
      WHERE market_slab = ${slabAddress}
        AND timestamp >= ${sinceIso}::timestamptz
      ORDER BY timestamp ASC
      LIMIT ${limit}
    `;
  } else {
    // Default: last N rows, returned oldest-first so the chart is a time-series
    rows = await sql<RawFundingRow[]>`
      SELECT slot, rate_bps_per_slot, net_lp_pos, price_e6,
             funding_index_qpb_e6, timestamp
      FROM (
        SELECT slot, rate_bps_per_slot, net_lp_pos, price_e6,
               funding_index_qpb_e6, timestamp
        FROM funding_history
        WHERE market_slab = ${slabAddress}
        ORDER BY timestamp DESC
        LIMIT ${limit}
      ) sub
      ORDER BY timestamp ASC
    `;
  }

  return rows.map((r) => {
    const rateBpsPerSlot = Number(r.rate_bps_per_slot);
    const tsMs =
      r.timestamp instanceof Date
        ? r.timestamp.getTime()
        : new Date(r.timestamp).getTime();
    return {
      slot: Number(r.slot),
      rateBpsPerSlot,
      netLpPos: String(r.net_lp_pos),
      priceE6: String(r.price_e6),
      fundingIndexQpbE6: String(r.funding_index_qpb_e6),
      timestampIso: r.timestamp instanceof Date
        ? r.timestamp.toISOString()
        : String(r.timestamp),
      timestamp: tsMs,
      hourlyRatePercent: toHourlyPercent(rateBpsPerSlot),
    };
  });
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
   * Sum of ABS(size) for trades in the last 24 hours, as a raw bigint.
   * `size` is stored in collateral token's smallest unit (e.g. microUSDC for
   * a 6-decimal USDC-collateral market).  Callers must divide by 10^decimals
   * to get USD volume.
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
        SUM(ABS(size::numeric))
          FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours'),
        0
      )::text                                          AS volume_24h_raw
    FROM trades
  `;
  const row = rows[0];
  return {
    marketCount:  Number(row?.market_count   ?? "0"),
    uniqueTraders: Number(row?.unique_traders ?? "0"),
    trades24h:    Number(row?.trades_24h     ?? "0"),
    volume24hRaw: BigInt(row?.volume_24h_raw ?? "0"),
  };
}

/**
 * Returns the set of distinct slab addresses that appear in the trades table.
 * Capped at 100 to bound the downstream batch-RPC call for on-chain OI.
 */
export async function queryKnownSlabs(): Promise<string[]> {
  const sql = getSql();
  const rows = await sql<Array<{ slab_address: string }>>`
    SELECT DISTINCT slab_address FROM trades LIMIT 100
  `;
  return rows.map((r) => r.slab_address);
}
