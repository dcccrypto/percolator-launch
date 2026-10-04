/**
 * Persistence for tick-series candles (chart_candles) and the backfill ledger
 * (chart_backfill). Direct Postgres over INDEXER_DATABASE_URL (the same Supabase
 * database the trades table lives in), so RLS never gets in the way and the
 * browser never sees the table.
 *
 * The store is an interface so the tick server and the route handler are tested
 * against an in-memory implementation and the SQL stays a thin, reviewed layer.
 */
import type { Candle, CandleResMinutes, TickSeries } from "./perp-types";

export type CandleSrc = "live" | "gecko";

export interface StoredCandle extends Candle {
  src: CandleSrc;
}

export interface CandleRow {
  slab: string;
  series: TickSeries;
  res: CandleResMinutes;
  candle: Candle;
  src?: CandleSrc;
}

export interface CandleStore {
  upsert(rows: readonly CandleRow[]): Promise<void>;
  /** Newest `limit` candles with t < beforeSec (exclusive), returned ASCENDING. */
  before(slab: string, series: TickSeries, res: CandleResMinutes, beforeSec: number, limit: number): Promise<StoredCandle[]>;
  /** Candles with fromSec <= t < toSec, ASCENDING, at most `limit`. */
  range(slab: string, series: TickSeries, res: CandleResMinutes, fromSec: number, toSec: number, limit: number): Promise<StoredCandle[]>;
  /** The newest candle per (slab, series, res) — used to seed the hub after a restart. */
  newest(slabs: readonly string[]): Promise<CandleRow[]>;
  /** Backfill ledger: when did we last pull Gecko for (slab,res), 0 when never. */
  backfilledAt(slab: string, res: CandleResMinutes): Promise<number>;
  markBackfilled(slab: string, res: CandleResMinutes, atMs: number, bars: number): Promise<void>;
  /**
   * Atomically claim the right to pull Gecko for (slab, res) for `holdMs`. False when somebody else
   * (any instance) holds the claim or a back-off is still running. The claim is the global single-flight.
   */
  claimBackfill(slab: string, res: CandleResMinutes, nowMs: number, holdMs: number): Promise<boolean>;
  /** Negative cache: keep everyone away from (slab, res) until `untilMs` after a failed / no-pool / 429 pull. */
  backoffBackfill(slab: string, res: CandleResMinutes, untilMs: number): Promise<void>;
  prune(nowMs: number): Promise<number>;
}

/** Retention per resolution (days). Keeps the table around ~100 MB at 40 markets. */
export const RETENTION_DAYS: Record<CandleResMinutes, number | null> = {
  1: 2,
  5: 7,
  15: 21,
  60: 60,
  240: 180,
  1440: null,
};

export class MemoryCandleStore implements CandleStore {
  readonly rows = new Map<string, StoredCandle>();
  readonly ledger = new Map<string, number>();
  private key(slab: string, series: string, res: number, t: number) { return `${slab}|${series}|${res}|${t}`; }

  async upsert(rows: readonly CandleRow[]): Promise<void> {
    for (const r of rows) {
      const k = this.key(r.slab, r.series, r.res, r.candle.t);
      const cur = this.rows.get(k);
      const src = r.src ?? "live";
      if (!cur || (cur.src === "gecko" && src === "live")) {
        this.rows.set(k, { ...r.candle, src });
      } else if (src === "live") {
        this.rows.set(k, { t: cur.t, o: cur.o, h: Math.max(cur.h, r.candle.h), l: Math.min(cur.l, r.candle.l), c: r.candle.c, n: Math.max(cur.n, r.candle.n), src: "live" });
      } // a gecko row never overwrites a live one
    }
  }
  private select(slab: string, series: TickSeries, res: CandleResMinutes): StoredCandle[] {
    const out: StoredCandle[] = [];
    for (const [k, v] of this.rows) if (k.startsWith(`${slab}|${series}|${res}|`)) out.push(v);
    return out.sort((a, b) => a.t - b.t);
  }
  async before(slab: string, series: TickSeries, res: CandleResMinutes, beforeSec: number, limit: number) {
    return this.select(slab, series, res).filter((c) => c.t < beforeSec).slice(-limit);
  }
  async range(slab: string, series: TickSeries, res: CandleResMinutes, fromSec: number, toSec: number, limit: number) {
    return this.select(slab, series, res).filter((c) => c.t >= fromSec && c.t < toSec).slice(0, limit);
  }
  async newest(slabs: readonly string[]): Promise<CandleRow[]> {
    const out: CandleRow[] = [];
    for (const slab of slabs) for (const series of ["mark", "oracle"] as const) for (const res of [1, 5, 15, 60, 240, 1440] as const) {
      const last = this.select(slab, series, res).filter((c) => c.src === "live").at(-1);
      if (last) out.push({ slab, series, res, candle: last });
    }
    return out;
  }
  readonly retry = new Map<string, number>();
  async backfilledAt(slab: string, res: CandleResMinutes) { return this.ledger.get(`${slab}|${res}`) ?? 0; }
  async markBackfilled(slab: string, res: CandleResMinutes, atMs: number) { this.ledger.set(`${slab}|${res}`, atMs); this.retry.delete(`${slab}|${res}`); }
  async claimBackfill(slab: string, res: CandleResMinutes, nowMs: number, holdMs: number) {
    const k = `${slab}|${res}`;
    if ((this.retry.get(k) ?? 0) > nowMs) return false;
    this.retry.set(k, nowMs + holdMs);
    return true;
  }
  async backoffBackfill(slab: string, res: CandleResMinutes, untilMs: number) { this.retry.set(`${slab}|${res}`, untilMs); }
  async prune(): Promise<number> { return 0; }
}

// ---------------------------------------------------------------------------
// Postgres implementation.
// ---------------------------------------------------------------------------

/** The slice of the `postgres` tagged-template client this module uses (so tests can fake it). */
export interface SqlLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tagged-template shape of the postgres client
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<any[]> & { count?: number };
  unsafe(query: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;
}

interface DbCandle { slab: string; series: TickSeries; res: number; t: string | number; o: number; h: number; l: number; c: number; n: number; src: CandleSrc }

function toStored(r: DbCandle): StoredCandle {
  return { t: Number(r.t), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), n: Number(r.n), src: r.src };
}

/** Rows per statement (10 parameters each). */
export const PG_UPSERT_CHUNK = 1_000;

export function createPgCandleStore(sql: SqlLike): CandleStore {
  const store: CandleStore = {
    async upsert(rows) {
      if (rows.length === 0) return;
      // Postgres allows 65,535 bind parameters per statement; this uses 10 per row.
      if (rows.length > PG_UPSERT_CHUNK) {
        for (let i = 0; i < rows.length; i += PG_UPSERT_CHUNK) await store.upsert(rows.slice(i, i + PG_UPSERT_CHUNK));
        return;
      }
      // One multi-row statement. Live data is authoritative: it replaces a gecko row outright,
      // and merges into an existing live row so a restart that lost the in-memory open
      // cannot rewrite the persisted open/high/low. A gecko row never overwrites a live one.
      const params: unknown[] = [];
      const tuples = rows.map((r, i) => {
        const b = i * 9;
        params.push(r.slab, r.series, r.res, r.candle.t, r.candle.o, r.candle.h, r.candle.l, r.candle.c, r.candle.n);
        return `($${b + 1},$${b + 2},$${b + 3}::smallint,$${b + 4}::bigint,$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9}::int,$${rows.length * 9 + 1 + i})`;
      });
      for (const r of rows) params.push(r.src ?? "live");
      await sql.unsafe(
        `INSERT INTO chart_candles (slab, series, res, t, o, h, l, c, n, src) VALUES ${tuples.join(",")}
         ON CONFLICT (slab, series, res, t) DO UPDATE SET
           o = CASE WHEN chart_candles.src = 'gecko' AND excluded.src = 'live' THEN excluded.o ELSE chart_candles.o END,
           h = CASE WHEN chart_candles.src = 'gecko' AND excluded.src = 'live' THEN excluded.h ELSE GREATEST(chart_candles.h, excluded.h) END,
           l = CASE WHEN chart_candles.src = 'gecko' AND excluded.src = 'live' THEN excluded.l ELSE LEAST(chart_candles.l, excluded.l) END,
           c = excluded.c,
           n = CASE WHEN chart_candles.src = 'gecko' AND excluded.src = 'live' THEN excluded.n ELSE GREATEST(chart_candles.n, excluded.n) END,
           src = CASE WHEN chart_candles.src = 'live' OR excluded.src = 'live' THEN 'live' ELSE 'gecko' END,
           updated_at = now()
         WHERE NOT (chart_candles.src = 'live' AND excluded.src = 'gecko')`,
        params,
      );
    },
    async before(slab, series, res, beforeSec, limit) {
      const rows = (await sql.unsafe(
        `SELECT t, o, h, l, c, n, src FROM chart_candles WHERE slab=$1 AND series=$2 AND res=$3 AND t < $4 ORDER BY t DESC LIMIT $5`,
        [slab, series, res, beforeSec, limit],
      )) as unknown as DbCandle[];
      return rows.map(toStored).reverse();
    },
    async range(slab, series, res, fromSec, toSec, limit) {
      const rows = (await sql.unsafe(
        `SELECT t, o, h, l, c, n, src FROM chart_candles WHERE slab=$1 AND series=$2 AND res=$3 AND t >= $4 AND t < $5 ORDER BY t ASC LIMIT $6`,
        [slab, series, res, fromSec, toSec, limit],
      )) as unknown as DbCandle[];
      return rows.map(toStored);
    },
    async newest(slabs) {
      if (slabs.length === 0) return [];
      const rows = (await sql.unsafe(
        `SELECT DISTINCT ON (slab, series, res) slab, series, res, t, o, h, l, c, n, src
           FROM chart_candles WHERE slab = ANY($1::text[]) AND src = 'live'
          ORDER BY slab, series, res, t DESC`,
        [slabs as string[]],
      )) as unknown as DbCandle[];
      return rows.map((r) => ({ slab: r.slab, series: r.series, res: Number(r.res) as CandleResMinutes, candle: toStored(r), src: r.src }));
    },
    async backfilledAt(slab, res) {
      const rows = await sql.unsafe(`SELECT fetched_at FROM chart_backfill WHERE slab=$1 AND res=$2`, [slab, res]);
      const v = rows[0]?.fetched_at;
      return v ? new Date(v as string | Date).getTime() : 0;
    },
    async markBackfilled(slab, res, atMs, bars) {
      await sql.unsafe(
        `INSERT INTO chart_backfill (slab, res, fetched_at, bars, retry_after) VALUES ($1,$2,$3,$4,NULL)
         ON CONFLICT (slab, res) DO UPDATE SET fetched_at = excluded.fetched_at, bars = excluded.bars, retry_after = NULL`,
        [slab, res, new Date(atMs).toISOString(), bars],
      );
    },
    async claimBackfill(slab, res, nowMs, holdMs) {
      // One atomic statement: insert a placeholder row, or take over an existing one only when its
      // claim/back-off has expired. RETURNING is empty when somebody else holds it.
      const rows = await sql.unsafe(
        `INSERT INTO chart_backfill (slab, res, fetched_at, bars, retry_after) VALUES ($1,$2,'1970-01-01T00:00:00Z',0,$3)
         ON CONFLICT (slab, res) DO UPDATE SET retry_after = excluded.retry_after
           WHERE chart_backfill.retry_after IS NULL OR chart_backfill.retry_after <= $4
         RETURNING 1`,
        [slab, res, new Date(nowMs + holdMs).toISOString(), new Date(nowMs).toISOString()],
      );
      return rows.length > 0;
    },
    async backoffBackfill(slab, res, untilMs) {
      await sql.unsafe(
        `INSERT INTO chart_backfill (slab, res, fetched_at, bars, retry_after) VALUES ($1,$2,'1970-01-01T00:00:00Z',0,$3)
         ON CONFLICT (slab, res) DO UPDATE SET retry_after = excluded.retry_after`,
        [slab, res, new Date(untilMs).toISOString()],
      );
    },
    async prune(nowMs) {
      let removed = 0;
      for (const [res, days] of Object.entries(RETENTION_DAYS)) {
        if (days === null) continue;
        const cutoff = Math.floor(nowMs / 1000) - days * 86_400;
        const out = await sql.unsafe(`DELETE FROM chart_candles WHERE res=$1 AND t < $2 RETURNING 1`, [Number(res), cutoff]);
        removed += out.length;
      }
      return removed;
    },
  };
  return store;
}
