/**
 * Pushes executed Percolator trades (the "Last" series) to subscribed browsers.
 *
 * The indexer writes trades to Postgres; this polls that table ONCE per interval for the set of
 * slabs somebody is currently watching (one indexed query for all of them, not one per viewer)
 * and emits each new trade. It is the server half of the "last trade" candle; the browser folds
 * the trades into the forming candle with the same pure code as everything else.
 *
 * Cursor rules (2026-10-14 egress fix, review E1):
 *  - Every slab has its OWN cursor `(created_at in µs, id)`, and the SQL applies it per slab
 *    (`unnest` of the cursors + a LATERAL index scan per slab). The old feed sent ONE `since =
 *    min(cursor)` for all slabs, so a single idle subscribed slab pinned the window at "first
 *    subscribed - 15 s" and every poll re-read every trade since then (up to 500 rows a second).
 *  - The first poll for a slab starts LOOKBACK_MS before "now" (the indexer lags the chain by a few
 *    seconds, and created_at is insert time, so starting exactly at now would miss trades still in
 *    flight); deeper history is the history route's job.
 *  - A cursor older than `now - LOOKBACK_MS` is advanced to it every poll, so an idle slab costs an
 *    empty index probe, never a re-read.
 *  - Per slab the query takes the NEWEST `perSlabLimit` rows after the cursor (`DESC LIMIT`), which
 *    are then emitted oldest-first. The old `ASC LIMIT 500` returned the OLDEST rows of a pinned
 *    window, so once it held more than 500 the feed froze on old trades.
 *  - `(created_at, id)` is a strict total order, so two trades at the same instant are neither lost
 *    nor duplicated across a cursor boundary. The cursor keeps microseconds (`cursor_us`) because
 *    a JS Date only holds milliseconds and created_at has microseconds.
 */

export interface TradeRow {
  id: string;
  slab_address: string;
  price: string | null;
  size: string | null;
  side: string | null;
  created_at: Date | string;
  /** created_at as integer microseconds since the epoch (decimal string). Derived from created_at when absent. */
  cursor_us?: string | null;
}

export interface TradeMessage {
  type: "trade";
  slab: string;
  id: string;
  price: number;
  size: number;
  side: "long" | "short" | null;
  /** Trade time, ms. */
  ts: number;
}

export const LOOKBACK_MS = 15_000;
/** The smallest uuid: "no id yet at this instant", so every row AT the cursor time is still after it. */
export const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
export const DEFAULT_PER_SLAB_LIMIT = 100;

/** Rows strictly after `(afterUs, afterId)` for `slab`. */
export interface TradeCursor {
  slab: string;
  /** Integer microseconds since the epoch, decimal string. */
  afterUs: string;
  afterId: string;
}

export type TradeQuery = (cursors: TradeCursor[], perSlabLimit: number) => Promise<TradeRow[]>;

/**
 * The feed's query. Params: $1 slabs text[], $2 cursor µs bigint[], $3 cursor ids uuid[],
 * $4 network, $5 per-slab limit. One LATERAL probe per slab on idx_trades_network
 * (network, slab_address, created_at DESC); the newest $5 rows after each cursor.
 *
 * `timestamptz 'epoch' + µs * interval '1 microsecond'` is exact integer arithmetic
 * (to_timestamp() goes through a double and can round the last microsecond).
 */
export const TRADE_FEED_SQL = `
SELECT t.id::text AS id, t.slab_address, t.price::text AS price, t.size::text AS size, t.side, t.created_at,
       (extract(epoch FROM t.created_at) * 1000000)::bigint::text AS cursor_us
  FROM unnest($1::text[], $2::bigint[], $3::uuid[]) AS c(slab, after_us, after_id)
  CROSS JOIN LATERAL (
    SELECT id, slab_address, price, size, side, created_at
      FROM trades
     WHERE network = $4
       AND slab_address = c.slab
       AND created_at >= timestamptz 'epoch' + c.after_us * interval '1 microsecond'
       AND (created_at, id) > (timestamptz 'epoch' + c.after_us * interval '1 microsecond', c.after_id)
     ORDER BY created_at DESC, id DESC
     LIMIT $5
  ) t`;

/** Minimal postgres client surface the feed query needs. */
export interface UnsafeSql {
  unsafe(query: string, params?: unknown[]): Promise<ArrayLike<Record<string, unknown>> & Iterable<Record<string, unknown>>>;
}

/** The production TradeQuery over a postgres client. */
export function pgTradeQuery(sql: UnsafeSql, network: string): TradeQuery {
  return async (cursors, perSlabLimit) => {
    if (cursors.length === 0) return [];
    const rows = await sql.unsafe(TRADE_FEED_SQL, [
      cursors.map((c) => c.slab),
      cursors.map((c) => c.afterUs),
      cursors.map((c) => c.afterId),
      network,
      perSlabLimit,
    ]);
    return [...rows] as unknown as TradeRow[];
  };
}

function rowUs(r: TradeRow): bigint | null {
  if (typeof r.cursor_us === "string" && /^-?\d+$/.test(r.cursor_us)) return BigInt(r.cursor_us);
  const ms = new Date(r.created_at).getTime();
  return Number.isFinite(ms) ? BigInt(Math.trunc(ms)) * 1000n : null;
}

interface Cursor { us: bigint; id: string }

/** (us, id) strictly after the cursor. Ids are compared as lowercase uuid text, which orders like uuid. */
function isAfter(us: bigint, id: string, c: Cursor): boolean {
  return us > c.us || (us === c.us && id.toLowerCase() > c.id.toLowerCase());
}

export function createTradeFeed(opts: {
  query: TradeQuery;
  watched(): Iterable<string>;
  emit(m: TradeMessage): void;
  now?: () => number;
  /** Most slabs watched in one query (default 64). */
  maxSlabs?: number;
  /** Newest rows fetched per slab per poll (default 100). */
  perSlabLimit?: number;
  /** Safety cap on trades emitted per poll (the newest are kept). */
  maxRows?: number;
}) {
  const now = opts.now ?? Date.now;
  const cursor = new Map<string, Cursor>(); // slab -> last (µs, id) emitted or skipped

  return {
    /** One poll. Never throws: a failed query just skips this tick. Returns trades emitted. */
    async poll(): Promise<number> {
      // Bounded: one query must never grow with the number of distinct slabs clients ask about.
      const slabs = [...new Set(opts.watched())].slice(0, opts.maxSlabs ?? 64);
      const watchedSet = new Set(slabs);
      for (const s of [...cursor.keys()]) if (!watchedSet.has(s)) cursor.delete(s);
      if (slabs.length === 0) return 0;
      // A cursor never sits further back than the lookback: a slab with no trades costs an empty probe.
      const floor: Cursor = { us: BigInt(Math.trunc(now() - LOOKBACK_MS)) * 1000n, id: ZERO_UUID };
      for (const s of slabs) {
        const c = cursor.get(s);
        if (!c || c.us < floor.us) cursor.set(s, floor);
      }
      let rows: TradeRow[];
      try {
        rows = await opts.query(
          slabs.map((slab) => {
            const c = cursor.get(slab) as Cursor;
            return { slab, afterUs: c.us.toString(), afterId: c.id };
          }),
          opts.perSlabLimit ?? DEFAULT_PER_SLAB_LIMIT,
        );
      } catch (err) {
        console.warn("[trade-feed] poll failed:", err instanceof Error ? err.message : err);
        return 0;
      }
      const keyed: Array<{ r: TradeRow; us: bigint }> = [];
      for (const r of rows) {
        const us = rowUs(r);
        if (us !== null) keyed.push({ r, us });
      }
      keyed.sort((a, b) => (a.us === b.us ? (a.r.id < b.r.id ? -1 : a.r.id > b.r.id ? 1 : 0) : a.us < b.us ? -1 : 1));
      const capped = keyed.slice(Math.max(0, keyed.length - (opts.maxRows ?? 500)));
      let emitted = 0;
      for (const { r, us } of capped) {
        const slab = r.slab_address;
        const cur = cursor.get(slab);
        if (cur === undefined) continue; // nobody watches it
        if (!isAfter(us, r.id, cur)) continue; // already emitted (or older than the cursor)
        cursor.set(slab, { us, id: r.id });
        // A missing price is a liquidation marker, not a trade (see indexer-db bucketCandles).
        const price = r.price === null ? NaN : Number(r.price);
        const size = Math.abs(Number(r.size));
        if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size)) continue;
        const side = r.side === "long" || r.side === "short" ? r.side : r.side === "buy" ? "long" : r.side === "sell" ? "short" : null;
        opts.emit({ type: "trade", slab, id: r.id, price, size, side, ts: new Date(r.created_at).getTime() });
        emitted++;
      }
      return emitted;
    },
  };
}
