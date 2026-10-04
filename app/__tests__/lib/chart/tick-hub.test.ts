// @vitest-environment node
import { describe, expect, it } from "vitest";
import { TickHub, REPLAY_MAX_PER_SLAB, REPLAY_WINDOW_MS } from "@/lib/chart/tick-hub";
import type { IngestTick } from "@/lib/chart/perp-types";

const SLAB = "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";
const OTHER = "6Y4bfYLWrhabgzU4p3onx9CeW1jCKjGjjSCaoCHf2Q9R";
const T0 = Date.UTC(2026, 9, 4, 12, 0, 0);
const tk = (landedMs: number, markE6: string, oracleE6: string | null = markE6, slab = SLAB): IngestTick => ({ slab, assetIndex: 0, slot: 1, landedMs, markE6, oracleE6 });

describe("TickHub", () => {
  it("numbers ticks per slab and stamps the epoch", () => {
    const h = new TickHub("e1");
    expect(h.ingest(tk(T0, "100"), T0)!.seq).toBe(1);
    expect(h.ingest(tk(T0 + 1500, "101"), T0 + 1500)!.seq).toBe(2);
    expect(h.ingest(tk(T0, "5", "5", OTHER), T0)!.seq).toBe(1);
    expect(h.latest(SLAB)).toMatchObject({ epoch: "e1", seq: 2, mark: 0.000101 });
  });
  it("drops a tick whose landed time goes backwards for a slab", () => {
    const h = new TickHub("e");
    h.ingest(tk(T0 + 5000, "100"), T0 + 5000);
    expect(h.ingest(tk(T0 + 1000, "999"), T0 + 6000)).toBeNull();
    expect(h.forming(SLAB, "mark", 1)!.c).toBe(0.0001);
  });
  it("builds mark and oracle candles independently; a null oracle leaves the oracle series alone", () => {
    const h = new TickHub("e");
    h.ingest(tk(T0, "100", "90"), T0);
    h.ingest(tk(T0 + 1500, "110", null), T0 + 1500);
    expect(h.forming(SLAB, "mark", 1)).toMatchObject({ o: 0.0001, h: 0.00011, c: 0.00011, n: 2 });
    expect(h.forming(SLAB, "oracle", 1)).toMatchObject({ o: 0.00009, c: 0.00009, n: 1 });
  });
  it("drains each changed (slab, series, res) once with its newest state, then is empty", () => {
    const h = new TickHub("e");
    h.ingest(tk(T0, "100"), T0);
    h.ingest(tk(T0 + 1500, "102"), T0 + 1500);
    const rows = h.drainDirty();
    expect(rows).toHaveLength(12); // 2 series x 6 resolutions
    expect(rows.find((r) => r.series === "mark" && r.res === 1)!.candle.c).toBe(0.000102);
    expect(h.drainDirty()).toEqual([]);
  });
  it("requeues a failed flush without clobbering newer state", () => {
    const h = new TickHub("e");
    h.ingest(tk(T0, "100"), T0);
    const rows = h.drainDirty();
    h.ingest(tk(T0 + 1500, "105"), T0 + 1500);
    h.requeue(rows);
    const again = h.drainDirty();
    expect(again.find((r) => r.series === "mark" && r.res === 1)!.candle.c).toBe(0.000105);
    expect(again).toHaveLength(12);
  });
  it("replays after a seq in the same epoch, and the whole buffer for a different epoch", () => {
    const h = new TickHub("e1");
    for (let i = 0; i < 5; i++) h.ingest(tk(T0 + i * 1500, "100"), T0 + i * 1500);
    expect(h.replay(SLAB, 3, "e1").map((m) => m.seq)).toEqual([4, 5]);
    expect(h.replay(SLAB, 3, "old-epoch")).toHaveLength(5);
    expect(h.replay(SLAB, 0, null)).toHaveLength(5);
    expect(h.replay("unknown", 0, "e1")).toEqual([]);
  });
  it("bounds the replay buffer by count and by age", () => {
    const h = new TickHub("e");
    for (let i = 0; i < REPLAY_MAX_PER_SLAB + 50; i++) h.ingest(tk(T0 + i, "100"), T0 + i);
    expect(h.replay(SLAB, 0, "e")).toHaveLength(REPLAY_MAX_PER_SLAB);
    const h2 = new TickHub("e");
    h2.ingest(tk(T0, "100"), T0);
    h2.ingest(tk(T0 + 10, "100"), T0 + REPLAY_WINDOW_MS + 5_000);
    expect(h2.replay(SLAB, 0, "e").map((m) => m.seq)).toEqual([2]);
  });
  it("seed continues a persisted candle, never overrides a candle already formed", () => {
    const h = new TickHub("e");
    h.seed(SLAB, "mark", 1, { t: T0 / 1000, o: 0.5, h: 0.9, l: 0.4, c: 0.6, n: 40 });
    h.ingest(tk(T0 + 1000, "700000"), T0 + 1000);
    expect(h.forming(SLAB, "mark", 1)).toMatchObject({ o: 0.5, h: 0.9, l: 0.4, c: 0.7, n: 41 });
    h.seed(SLAB, "mark", 1, { t: T0 / 1000, o: 9, h: 9, l: 9, c: 9, n: 1 });
    expect(h.forming(SLAB, "mark", 1)!.o).toBe(0.5);
  });
});
