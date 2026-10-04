// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CandleBook, bucketStartSec, foldTick, mergeCandles, rollUp, sanitizeCandles } from "@/lib/chart/candles";

const T0 = Date.UTC(2026, 9, 4, 12, 0, 0); // aligned to every resolution up to 4h

describe("foldTick", () => {
  it("opens the very first candle at its first tick", () => {
    expect(foldTick(null, 0.00346, T0 + 1_500, 1)).toEqual({ t: T0 / 1000, o: 0.00346, h: 0.00346, l: 0.00346, c: 0.00346, n: 1 });
  });
  it("updates high/low/close inside the bucket and keeps the open", () => {
    let c = foldTick(null, 100, T0, 1)!;
    c = foldTick(c, 103, T0 + 10_000, 1)!;
    c = foldTick(c, 98, T0 + 20_000, 1)!;
    c = foldTick(c, 101, T0 + 59_999, 1)!;
    expect(c).toEqual({ t: T0 / 1000, o: 100, h: 103, l: 98, c: 101, n: 4 });
  });
  it("opens a new bucket at the previous close (continuity) and widens high/low to include that open", () => {
    const a = foldTick(null, 100, T0, 1)!;
    const b = foldTick(a, 90, T0 + 61_000, 1)!;
    expect(b).toEqual({ t: T0 / 1000 + 60, o: 100, h: 100, l: 90, c: 90, n: 1 });
    const c = foldTick(a, 120, T0 + 61_000, 1)!;
    expect(c.o).toBe(100);
    expect(c.h).toBe(120);
    expect(c.l).toBe(100);
  });
  it("skips empty buckets without inventing bars (a gap stays a gap in time)", () => {
    const a = foldTick(null, 100, T0, 1)!;
    const b = foldTick(a, 101, T0 + 10 * 60_000, 1)!;
    expect(b.t).toBe(T0 / 1000 + 600);
    expect(b.o).toBe(100);
  });
  it("rejects a tick older than the newest bucket, and unusable prices", () => {
    const a = foldTick(null, 100, T0 + 120_000, 1)!;
    expect(foldTick(a, 100, T0, 1)).toBeNull();
    for (const bad of [0, -1, NaN, Infinity]) expect(foldTick(a, bad, T0 + 130_000, 1)).toBeNull();
    expect(foldTick(a, 100, NaN, 1)).toBeNull();
  });
  it("keeps full precision for sub-cent memecoin prices", () => {
    const c = foldTick(null, 0.000001234, T0, 1)!;
    expect(c.o).toBe(0.000001234);
  });
});

describe("bucketStartSec", () => {
  it("aligns every resolution in UTC", () => {
    const ts = Date.UTC(2026, 9, 4, 13, 47, 31) / 1000;
    expect(bucketStartSec(ts, 1)).toBe(Date.UTC(2026, 9, 4, 13, 47, 0) / 1000);
    expect(bucketStartSec(ts, 5)).toBe(Date.UTC(2026, 9, 4, 13, 45, 0) / 1000);
    expect(bucketStartSec(ts, 60)).toBe(Date.UTC(2026, 9, 4, 13, 0, 0) / 1000);
    expect(bucketStartSec(ts, 240)).toBe(Date.UTC(2026, 9, 4, 12, 0, 0) / 1000);
    expect(bucketStartSec(ts, 1440)).toBe(Date.UTC(2026, 9, 4, 0, 0, 0) / 1000);
  });
});

describe("CandleBook", () => {
  it("updates all six resolutions per tick and reports the closed candle on rollover", () => {
    const book = new CandleBook();
    const first = book.apply(100, T0);
    expect(first.map((x) => x.res)).toEqual([1, 5, 15, 60, 240, 1440]);
    expect(first.every((x) => x.closed === null)).toBe(true);
    const next = book.apply(105, T0 + 61_000);
    const m1 = next.find((x) => x.res === 1)!;
    expect(m1.closed).toEqual({ t: T0 / 1000, o: 100, h: 100, l: 100, c: 100, n: 1 });
    expect(next.find((x) => x.res === 5)!.closed).toBeNull();
    expect(book.get(5)).toMatchObject({ o: 100, h: 105, c: 105, n: 2 });
  });
  it("is deterministic: the same ticks give the same candles server- and client-side", () => {
    const a = new CandleBook();
    const b = new CandleBook();
    const ticks = Array.from({ length: 200 }, (_, i) => [100 + Math.sin(i / 5) * 3, T0 + i * 1_500] as const);
    for (const [p, t] of ticks) { a.apply(p, t); b.apply(p, t); }
    for (const r of [1, 5, 15, 60, 240, 1440] as const) expect(a.get(r)).toEqual(b.get(r));
  });
});

describe("mergeCandles / rollUp / sanitizeCandles", () => {
  const c = (t: number, p: number) => ({ t, o: p, h: p, l: p, c: p, n: 1 });
  it("merges ascending with fresh winning on collision", () => {
    expect(mergeCandles([c(60, 1), c(120, 2)], [c(120, 9), c(180, 3)]).map((x) => [x.t, x.o])).toEqual([[60, 1], [120, 9], [180, 3]]);
  });
  it("rolls 1m up to 5m", () => {
    const fine = [0, 60, 120, 180, 240, 300].map((t, i) => ({ t, o: 10 + i, h: 12 + i, l: 9 + i, c: 11 + i, n: 1 }));
    const r = rollUp(fine, 5);
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({ t: 0, o: 10, h: 16, l: 9, c: 15, n: 5 });
    expect(r[1].t).toBe(300);
  });
  it("drops corrupt candles", () => {
    const good = c(60, 5);
    expect(sanitizeCandles([good, { ...good, t: 120, h: 1, l: 9 }, { ...good, t: 180, o: -1 }, { ...good, t: NaN }])).toEqual([good]);
  });
});
