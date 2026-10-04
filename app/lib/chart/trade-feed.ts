/**
 * Pushes executed Percolator trades (the "Last" series) to subscribed browsers.
 *
 * The indexer writes trades to Postgres; this polls that table ONCE per interval for the set of
 * slabs somebody is currently watching (one indexed query for all of them, not one per viewer)
 * and emits each new trade. It is the server half of the "last trade" candle; the browser folds
 * the trades into the forming candle with the same pure code as everything else.
 *
 * Cursor rules: the first poll for a slab starts LOOKBACK_MS before "now" (the indexer lags the
 * chain by a few seconds, and created_at is the trade's own time, so starting exactly at now would
 * miss the trades still in flight); deeper history is the history route's job. A trade is emitted at
 * most once (id de-dupe across the cursor boundary).
 */

export interface TradeRow {
  id: string;
  slab_address: string;
  price: string | null;
  size: string | null;
  side: string | null;
  created_at: Date | string;
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

export type TradeQuery = (slabs: string[], sinceIso: string) => Promise<TradeRow[]>;

export function createTradeFeed(opts: {
  query: TradeQuery;
  watched(): Iterable<string>;
  emit(m: TradeMessage): void;
  now?: () => number;
  /** Safety cap on trades emitted per poll. */
  maxRows?: number;
}) {
  const now = opts.now ?? Date.now;
  const cursor = new Map<string, number>(); // slab -> last created_at ms emitted
  const seenAtCursor = new Map<string, Set<string>>(); // ids already emitted AT the cursor ms

  return {
    /** One poll. Never throws: a failed query just skips this tick. Returns trades emitted. */
    async poll(): Promise<number> {
      const slabs = [...new Set(opts.watched())];
      for (const s of [...cursor.keys()]) if (!slabs.includes(s)) { cursor.delete(s); seenAtCursor.delete(s); }
      if (slabs.length === 0) return 0;
      const t = now();
      for (const s of slabs) if (!cursor.has(s)) cursor.set(s, t - LOOKBACK_MS);
      const since = Math.min(...slabs.map((s) => cursor.get(s) as number));
      let rows: TradeRow[];
      try {
        rows = await opts.query(slabs, new Date(since).toISOString());
      } catch (err) {
        console.warn("[trade-feed] poll failed:", err instanceof Error ? err.message : err);
        return 0;
      }
      let emitted = 0;
      rows.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      for (const r of rows.slice(0, opts.maxRows ?? 500)) {
        const slab = r.slab_address;
        const cur = cursor.get(slab);
        if (cur === undefined) continue;
        const ts = new Date(r.created_at).getTime();
        if (!Number.isFinite(ts) || ts < cur) continue;
        let seen = seenAtCursor.get(slab);
        if (ts === cur && seen?.has(r.id)) continue;
        // A missing price is a liquidation marker, not a trade (see indexer-db bucketCandles).
        const price = r.price === null ? NaN : Number(r.price);
        const size = Math.abs(Number(r.size));
        if (ts > cur) { cursor.set(slab, ts); seen = new Set(); seenAtCursor.set(slab, seen); }
        if (!seen) { seen = new Set(); seenAtCursor.set(slab, seen); }
        seen.add(r.id);
        if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size)) continue;
        const side = r.side === "long" || r.side === "short" ? r.side : r.side === "buy" ? "long" : r.side === "sell" ? "short" : null;
        opts.emit({ type: "trade", slab, id: r.id, price, size, side, ts });
        emitted++;
      }
      return emitted;
    },
  };
}
