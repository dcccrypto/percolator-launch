// @vitest-environment node
import { describe, expect, it } from "vitest";
import { LOOKBACK_MS, createTradeFeed, type TradeMessage, type TradeRow } from "@/lib/chart/trade-feed";

const A = "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";
const B = "6Y4bfYLWrhabgzU4p3onx9CeW1jCKjGjjSCaoCHf2Q9R";
const NOW = 1_791_000_000_000;
const row = (id: string, slab: string, ts: number, price: string | null = "1.5", size = "10", side = "long"): TradeRow =>
  ({ id, slab_address: slab, price, size, side, created_at: new Date(ts) });

function feed(rows: () => TradeRow[], watched: string[]) {
  const out: TradeMessage[] = [];
  const calls: Array<{ slabs: string[]; since: string }> = [];
  let now = NOW;
  const f = createTradeFeed({
    watched: () => watched,
    emit: (m) => out.push(m),
    now: () => now,
    query: async (slabs, since) => { calls.push({ slabs, since }); return rows(); },
  });
  return { f, out, calls, tick: (ms: number) => { now += ms; } };
}

describe("createTradeFeed", () => {
  it("does nothing, and queries nothing, when nobody is watching", async () => {
    const { f, calls } = feed(() => [], []);
    expect(await f.poll()).toBe(0);
    expect(calls).toEqual([]);
  });
  it("ONE query covers every watched slab, starting LOOKBACK before now", async () => {
    const { f, calls } = feed(() => [], [A, B, A]);
    await f.poll();
    expect(calls).toHaveLength(1);
    expect(calls[0].slabs.sort()).toEqual([A, B].sort());
    expect(calls[0].since).toBe(new Date(NOW - LOOKBACK_MS).toISOString());
  });
  it("emits each trade exactly once across polls, in time order, even when the query returns it again", async () => {
    const data = [row("2", A, NOW - 1000), row("1", A, NOW - 2000)];
    const { f, out, tick } = feed(() => data, [A]);
    expect(await f.poll()).toBe(2);
    expect(out.map((m) => m.id)).toEqual(["1", "2"]);
    tick(1000);
    expect(await f.poll()).toBe(0);
    data.push(row("3", A, NOW + 500));
    tick(1000);
    expect(await f.poll()).toBe(1);
    expect(out.map((m) => m.id)).toEqual(["1", "2", "3"]);
  });
  it("two trades in the same millisecond are both emitted, then neither again", async () => {
    const data = [row("a", A, NOW), row("b", A, NOW)];
    const { f, out } = feed(() => data, [A]);
    await f.poll();
    await f.poll();
    expect(out.map((m) => m.id)).toEqual(["a", "b"]);
  });
  it("drops liquidation markers (null price) and garbage, without stalling the cursor", async () => {
    const { f, out } = feed(() => [row("1", A, NOW - 500, null), row("2", A, NOW - 400, "0"), row("3", A, NOW - 300, "x"), row("4", A, NOW - 200, "2.5", "-3", "sell")], [A]);
    expect(await f.poll()).toBe(1);
    expect(out[0]).toMatchObject({ id: "4", price: 2.5, size: 3, side: "short" });
  });
  it("ignores rows for slabs nobody watches and rows older than a slab's cursor", async () => {
    const { f, out } = feed(() => [row("1", B, NOW), row("2", A, NOW - LOOKBACK_MS - 1)], [A]);
    expect(await f.poll()).toBe(0);
    expect(out).toEqual([]);
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
});
