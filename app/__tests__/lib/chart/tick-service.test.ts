// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { MemoryCandleStore } from "@/lib/chart/candle-store";
import { FLUSH_CHUNK_ROWS, MAX_BODY_BYTES, createTickService } from "@/lib/chart/tick-service";
import type { TickMessage } from "@/lib/chart/perp-types";

const KEY = "s3cret-s3cret-s3cret-s3cret";
const AUTH = `Bearer ${KEY}`;
const NOW = 1_791_000_000_000;
const SLAB = "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";
const payload = (ticks: unknown[]) => JSON.stringify({ v: 1, src: "keeper", sentMs: NOW, ticks });
const tick = (landedMs = NOW - 50, markE6 = "3461") => ({ slab: SLAB, assetIndex: 0, slot: 9, landedMs, markE6, oracleE6: "3460" });

function svc(store = new MemoryCandleStore(), opts: { key?: string | undefined } = { key: KEY }) {
  return { s: createTickService({ key: opts.key, store, epoch: "ep", now: () => NOW }), store };
}

describe("tick service ingest", () => {
  it("refuses everything when no key is configured", () => {
    const { s } = svc(undefined, { key: undefined });
    expect(s.ingest(AUTH, payload([tick()]), () => {})).toEqual({ status: 503, error: "ingest is not configured" });
  });
  it("401s a wrong or missing token and counts it, without fanning anything out", () => {
    const { s } = svc();
    const out: TickMessage[] = [];
    expect(s.ingest("Bearer nope", payload([tick()]), (m) => out.push(m)).status).toBe(401);
    expect(s.ingest(undefined, payload([tick()]), (m) => out.push(m)).status).toBe(401);
    expect(out).toEqual([]);
    expect(s.stats.ingestUnauthorized).toBe(2);
  });
  it("rejects oversized and malformed bodies", () => {
    const { s } = svc();
    expect(s.ingest(AUTH, "x".repeat(MAX_BODY_BYTES + 1), () => {}).status).toBe(413);
    expect(s.ingest(AUTH, "{not json", () => {}).status).toBe(400);
    expect(s.ingest(AUTH, JSON.stringify({ v: 9, ticks: [] }), () => {}).status).toBe(400);
  });
  it("accepts good ticks, fans each out once, and reports the rejected ones", () => {
    const { s } = svc();
    const out: TickMessage[] = [];
    const r = s.ingest(AUTH, payload([tick(), { ...tick(), markE6: "0" }, tick(NOW - 10, "3470")]), (m) => out.push(m));
    expect(r).toEqual({ status: 202, accepted: 2, rejected: 1 });
    expect(out.map((m) => m.seq)).toEqual([1, 2]);
    expect(out[1].mark).toBe(0.00347);
    expect(s.stats.ticksAccepted).toBe(2);
  });
  it("counts a backwards tick as dropped, not accepted", () => {
    const { s } = svc();
    s.ingest(AUTH, payload([tick(NOW - 10)]), () => {});
    expect(s.ingest(AUTH, payload([tick(NOW - 5000)]), () => {})).toMatchObject({ status: 202, accepted: 0 });
    expect(s.stats.ticksDroppedBackwards).toBe(1);
  });
});

describe("tick service allowlist", () => {
  it("drops ticks for markets we do not serve and counts them; known ones pass (negative control)", () => {
    const OTHER = "6Y4bfYLWrhabgzU4p3onx9CeW1jCKjGjjSCaoCHf2Q9R";
    const s = createTickService({ key: KEY, store: null, epoch: "e", now: () => NOW, isKnownSlab: (x) => x === SLAB });
    const out: TickMessage[] = [];
    const r = s.ingest(AUTH, payload([tick(), { ...tick(), slab: OTHER }]), (m) => out.push(m));
    expect(r).toMatchObject({ status: 202, accepted: 1 });
    expect(out.map((m) => m.slab)).toEqual([SLAB]);
    expect(s.stats.ticksDroppedUnknown).toBe(1);
    expect(s.hub.latest(OTHER)).toBeNull();
  });
});

describe("tick service flush chunking", () => {
  it("never sends more than FLUSH_CHUNK_ROWS per statement, so a large dirty set cannot hit the parameter limit", async () => {
    const store = new MemoryCandleStore();
    const sizes: number[] = [];
    const real = store.upsert.bind(store);
    store.upsert = async (rows) => { sizes.push(rows.length); return real(rows); };
    const s = createTickService({ key: KEY, store, epoch: "e", now: () => NOW });
    for (let i = 0; i < 100; i++) {
      const slab = `${SLAB.slice(0, 40)}${String(1000 + i)}`; // 100 distinct markets x 12 candles = 1200 dirty rows
      s.hub.ingest({ slab, assetIndex: 0, slot: 1, landedMs: NOW - 10, markE6: "3461", oracleE6: "3460" }, NOW);
    }
    await s.flush();
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(1200);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(FLUSH_CHUNK_ROWS);
    expect(sizes.length).toBeGreaterThan(1);
  });
  it("a failure in a later chunk requeues only the unwritten rows", async () => {
    const store = new MemoryCandleStore();
    const real = store.upsert.bind(store);
    let calls = 0;
    store.upsert = async (rows) => { if (++calls === 2) throw new Error("db down"); return real(rows); };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = createTickService({ key: KEY, store, epoch: "e", now: () => NOW });
    for (let i = 0; i < 100; i++) s.hub.ingest({ slab: `${SLAB.slice(0, 40)}${String(1000 + i)}`, assetIndex: 0, slot: 1, landedMs: NOW - 10, markE6: "3461", oracleE6: "3460" }, NOW);
    await s.flush();
    expect(store.rows.size).toBe(FLUSH_CHUNK_ROWS); // chunk 1 landed
    expect(s.hub.drainDirty()).toHaveLength(1200 - FLUSH_CHUNK_ROWS); // the rest is queued again
  });
});

describe("tick service flush", () => {
  it("persists the dirty candles, then writes nothing until something changes", async () => {
    const { s, store } = svc();
    s.ingest(AUTH, payload([tick()]), () => {});
    await s.flush();
    expect(store.rows.size).toBe(12);
    const spy = vi.spyOn(store, "upsert");
    await s.flush();
    expect(spy).not.toHaveBeenCalled();
  });
  it("requeues on a store failure and succeeds on the next flush", async () => {
    const { s, store } = svc();
    s.ingest(AUTH, payload([tick()]), () => {});
    const real = store.upsert.bind(store);
    store.upsert = vi.fn().mockRejectedValueOnce(new Error("db down")).mockImplementation(real);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await s.flush();
    expect(s.stats.flushFailed).toBe(1);
    expect(store.rows.size).toBe(0);
    await s.flush();
    expect(store.rows.size).toBe(12);
    expect(s.stats.flushOk).toBe(1);
  });
  it("works with no store at all (in-memory only)", async () => {
    const s = createTickService({ key: KEY, store: null, epoch: "e", now: () => NOW });
    s.ingest(AUTH, payload([tick()]), () => {});
    await expect(s.flush()).resolves.toBeUndefined();
  });
});
