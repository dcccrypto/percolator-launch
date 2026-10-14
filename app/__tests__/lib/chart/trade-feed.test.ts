// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  LOOKBACK_MS,
  ZERO_UUID,
  createTradeFeed,
  type TradeCursor,
  type TradeMessage,
  type TradeQuery,
  type TradeRow,
} from "@/lib/chart/trade-feed";

const A = "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";
const B = "6Y4bfYLWrhabgzU4p3onx9CeW1jCKjGjjSCaoCHf2Q9R";
const NOW = 1_791_000_000_000;
const row = (id: string, slab: string, ts: number, price: string | null = "1.5", size = "10", side = "long", us?: bigint): TradeRow =>
  ({ id, slab_address: slab, price, size, side, created_at: new Date(ts), cursor_us: (us ?? BigInt(ts) * 1000n).toString() });

/**
 * An in-memory stand-in for TRADE_FEED_SQL with the same semantics: per slab, rows strictly after
 * (cursor µs, cursor id), newest `limit` by (created_at, id) DESC. Counts every row it "reads".
 */
function fakeDb() {
  const table: TradeRow[] = [];
  let rowsRead = 0;
  const calls: TradeCursor[][] = [];
  const us = (r: TradeRow) => BigInt(r.cursor_us as string);
  const query: TradeQuery = async (cursors, limit) => {
    calls.push(cursors);
    const out: TradeRow[] = [];
    for (const c of cursors) {
      const after = BigInt(c.afterUs);
      const hits = table
        .filter((r) => r.slab_address === c.slab && (us(r) > after || (us(r) === after && r.id > c.afterId)))
        .sort((x, y) => (us(x) === us(y) ? (x.id < y.id ? 1 : -1) : us(x) < us(y) ? 1 : -1))
        .slice(0, limit);
      out.push(...hits);
    }
    rowsRead += out.length;
    return out;
  };
  return { table, query, calls, rowsRead: () => rowsRead };
}

/** The pre-fix query: ONE `since = min(cursor)` for every slab, `ASC LIMIT 500`. Used only as the control. */
function oldStyleRowsRead(table: TradeRow[], slabs: string[], sinceMs: number): number {
  return table.filter((r) => slabs.includes(r.slab_address) && new Date(r.created_at).getTime() >= sinceMs).slice(0, 500).length;
}

function feed(db: ReturnType<typeof fakeDb>, watched: string[], extra: { perSlabLimit?: number } = {}) {
  const out: TradeMessage[] = [];
  let now = NOW;
  const f = createTradeFeed({ watched: () => watched, emit: (m) => out.push(m), now: () => now, query: db.query, ...extra });
  return { f, out, tick: (ms: number) => { now += ms; }, now: () => now };
}

describe("createTradeFeed", () => {
  it("does nothing, and queries nothing, when nobody is watching", async () => {
    const db = fakeDb();
    const { f } = feed(db, []);
    expect(await f.poll()).toBe(0);
    expect(db.calls).toEqual([]);
  });

  it("ONE query covers every watched slab, each cursor starting LOOKBACK before now", async () => {
    const db = fakeDb();
    const { f } = feed(db, [A, B, A]);
    await f.poll();
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].map((c) => c.slab).sort()).toEqual([A, B].sort());
    for (const c of db.calls[0]) {
      expect(c.afterUs).toBe((BigInt(NOW - LOOKBACK_MS) * 1000n).toString());
      expect(c.afterId).toBe(ZERO_UUID);
    }
  });

  it("emits each trade exactly once across polls, in time order, even when the query returns it again", async () => {
    const data = [row("2", A, NOW - 1000), row("1", A, NOW - 2000)];
    const out: TradeMessage[] = [];
    let now = NOW;
    // A sloppy query that ignores the cursor and returns everything every time.
    const f = createTradeFeed({ watched: () => [A], emit: (m) => out.push(m), now: () => now, query: async () => data });
    expect(await f.poll()).toBe(2);
    expect(out.map((m) => m.id)).toEqual(["1", "2"]);
    now += 1000;
    expect(await f.poll()).toBe(0);
    data.push(row("3", A, NOW + 500));
    now += 1000;
    expect(await f.poll()).toBe(1);
    expect(out.map((m) => m.id)).toEqual(["1", "2", "3"]);
  });

  it("drops liquidation markers (null price) and garbage, without stalling the cursor", async () => {
    const db = fakeDb();
    db.table.push(row("1", A, NOW - 500, null), row("2", A, NOW - 400, "0"), row("3", A, NOW - 300, "x"), row("4", A, NOW - 200, "2.5", "-3", "sell"));
    const { f, out } = feed(db, [A]);
    expect(await f.poll()).toBe(1);
    expect(out[0]).toMatchObject({ id: "4", price: 2.5, size: 3, side: "short" });
    expect(await f.poll()).toBe(0);
    // The cursor moved past the markers: nothing is read again.
    expect(db.calls[1][0].afterId).toBe("4");
  });

  it("ignores rows for slabs nobody watches and rows older than a slab's cursor", async () => {
    const out: TradeMessage[] = [];
    const f = createTradeFeed({
      watched: () => [A], emit: (m) => out.push(m), now: () => NOW,
      query: async () => [row("1", B, NOW), row("2", A, NOW - LOOKBACK_MS - 1)],
    });
    expect(await f.poll()).toBe(0);
    expect(out).toEqual([]);
  });

  it("keeps the wire format: exactly the TradeMessage fields, ts in ms from created_at", async () => {
    const db = fakeDb();
    db.table.push(row("x", A, NOW - 10, "2", "1", "buy"));
    const { f, out } = feed(db, [A]);
    await f.poll();
    expect(out).toEqual([{ type: "trade", slab: A, id: "x", price: 2, size: 1, side: "long", ts: NOW - 10 }]);
  });

  it("(a) an idle watched slab no longer pins the window: each poll reads only new rows", async () => {
    const db = fakeDb();
    const { f, out, tick, now } = feed(db, [A, B]); // A never trades
    const firstPollAt = NOW;
    let oldReads = 0;
    for (let i = 0; i < 600; i++) {
      // B trades once a second.
      db.table.push(row(`b${String(i).padStart(4, "0")}`, B, now() - 200));
      await f.poll();
      // What the pre-fix feed would have read this poll: A's cursor never moves, so since = first poll - 15 s.
      oldReads += oldStyleRowsRead(db.table, [A, B], firstPollAt - LOOKBACK_MS);
      tick(1000);
    }
    expect(out).toHaveLength(600);
    expect(new Set(out.map((m) => m.id)).size).toBe(600);
    // New: one row read per trade, total. Old: every poll re-read the whole growing window (capped at 500).
    expect(db.rowsRead()).toBe(600);
    expect(oldReads).toBeGreaterThan(100_000);
    // The idle slab's cursor follows now - LOOKBACK instead of staying at its first value.
    const lastCall = db.calls[db.calls.length - 1];
    const idle = lastCall.find((c) => c.slab === A) as TradeCursor;
    expect(BigInt(idle.afterUs)).toBe(BigInt(now() - 1000 - LOOKBACK_MS) * 1000n);
  });

  it("(b) a backlog larger than the per-slab limit still delivers the NEWEST trades, and the feed keeps moving", async () => {
    const db = fakeDb();
    for (let i = 0; i < 1500; i++) db.table.push(row(`a${String(i).padStart(5, "0")}`, A, NOW - 10_000 + i));
    const { f, out, tick, now } = feed(db, [A], { perSlabLimit: 100 });
    expect(await f.poll()).toBe(100);
    expect(out[out.length - 1].id).toBe("a01499");
    expect(out.map((m) => m.ts)).toEqual([...out.map((m) => m.ts)].sort((x, y) => x - y)); // oldest-first on the wire
    tick(1000);
    db.table.push(row("fresh", A, now() - 100));
    expect(await f.poll()).toBe(1);
    expect(out[out.length - 1].id).toBe("fresh");
    // Negative control: the pre-fix ASC LIMIT 500 over the pinned window returns only old rows, never "fresh".
    const oldStyle = db.table.filter((r) => new Date(r.created_at).getTime() >= NOW - LOOKBACK_MS).slice(0, 500);
    expect(oldStyle.some((r) => r.id === "fresh")).toBe(false);
  });

  it("(c) equal timestamps: none lost, none duplicated, across a cursor boundary", async () => {
    const db = fakeDb();
    const t = NOW - 1000;
    const us = BigInt(t) * 1000n + 123n; // same microsecond for every row
    // Three legs of one transaction share created_at.
    db.table.push(row("11111111-0000-0000-0000-000000000000", A, t, "1", "1", "long", us));
    db.table.push(row("33333333-0000-0000-0000-000000000000", A, t, "1", "1", "long", us));
    db.table.push(row("22222222-0000-0000-0000-000000000000", A, t, "1", "1", "long", us));
    const { f, out } = feed(db, [A], { perSlabLimit: 2 });
    // Limit 2 < 3 rows at one instant: the newest two by (created_at, id) come first...
    expect(await f.poll()).toBe(2);
    // ...and the next poll does NOT re-emit them (strictly after (us, "3333…")).
    expect(await f.poll()).toBe(0);
    // A later row in the same microsecond with a higher id is still delivered.
    db.table.push(row("44444444-0000-0000-0000-000000000000", A, t, "1", "1", "long", us));
    expect(await f.poll()).toBe(1);
    expect(await f.poll()).toBe(0);
    const ids = out.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["22222222-0000-0000-0000-000000000000", "33333333-0000-0000-0000-000000000000", "44444444-0000-0000-0000-000000000000"]);
  });

  it("(c) two trades in the same millisecond but different microseconds are both delivered across polls", async () => {
    const db = fakeDb();
    const t = NOW - 500;
    db.table.push(row("b", A, t, "1", "1", "long", BigInt(t) * 1000n + 100n));
    const { f, out } = feed(db, [A]);
    expect(await f.poll()).toBe(1);
    // Same ms, later µs, LOWER id: a ms cursor plus an id tie-break would drop it.
    db.table.push(row("a", A, t, "1", "1", "long", BigInt(t) * 1000n + 900n));
    expect(await f.poll()).toBe(1);
    expect(out.map((m) => m.id)).toEqual(["b", "a"]);
  });

  it("caps the watched set passed to the ONE query (negative control: under the cap nothing is cut)", async () => {
    const many = Array.from({ length: 200 }, (_, i) => `${A.slice(0, 38)}${String(100 + i)}`);
    const calls: TradeCursor[][] = [];
    const f = createTradeFeed({ watched: () => many, emit: () => {}, now: () => NOW, maxSlabs: 64, query: async (c) => { calls.push(c); return []; } });
    await f.poll();
    expect(calls[0]).toHaveLength(64);
    const g = createTradeFeed({ watched: () => many.slice(0, 10), emit: () => {}, now: () => NOW, maxSlabs: 64, query: async (c) => { calls.push(c); return []; } });
    await g.poll();
    expect(calls[1]).toHaveLength(10);
  });

  it("survives a failing query and keeps its cursors", async () => {
    let fail = true;
    const out: TradeMessage[] = [];
    const f = createTradeFeed({
      watched: () => [A], emit: (m) => out.push(m), now: () => NOW,
      query: async () => { if (fail) throw new Error("db down"); return [row("1", A, NOW - 100)]; },
    });
    const w = console.warn; console.warn = () => {};
    expect(await f.poll()).toBe(0);
    console.warn = w;
    fail = false;
    expect(await f.poll()).toBe(1);
  });

  it("derives the cursor from created_at when cursor_us is absent", async () => {
    const out: TradeMessage[] = [];
    const r: TradeRow = { id: "1", slab_address: A, price: "1", size: "1", side: "long", created_at: new Date(NOW - 100) };
    const seen: TradeCursor[][] = [];
    const f = createTradeFeed({ watched: () => [A], emit: (m) => out.push(m), now: () => NOW, query: async (c) => { seen.push(c); return [r]; } });
    expect(await f.poll()).toBe(1);
    expect(await f.poll()).toBe(0);
    expect(seen[1][0]).toEqual({ slab: A, afterUs: (BigInt(NOW - 100) * 1000n).toString(), afterId: "1" });
  });
});
