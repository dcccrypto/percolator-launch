/**
 * The chart's "Last" series on a quiet market: trades land in a few minutes, so a series built
 * from trade buckets alone is scattered flat dashes with gaps. fillCandleGaps carries the previous
 * close through every empty bucket (the last trade price really is unchanged until the next trade).
 * Also: the Mark line is the chart's current-price line on every series, Mark included.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fillCandleGaps, emptyUdf, MAX_FILLED_BARS, type UdfResponse } from "@/lib/indexer-db";

const M = 60;
const udf = (bars: Array<[t: number, o: number, h: number, l: number, c: number, v: number]>): UdfResponse => ({
  s: "ok",
  t: bars.map((b) => b[0]), o: bars.map((b) => b[1]), h: bars.map((b) => b[2]),
  l: bars.map((b) => b[3]), c: bars.map((b) => b[4]), v: bars.map((b) => b[5]),
});

describe("fillCandleGaps", () => {
  it("fills empty buckets with the previous close (v = 0) and keeps traded bars unchanged", () => {
    const out = fillCandleGaps(udf([[0, 10, 11, 9, 10.5, 2], [3 * M, 12, 12, 12, 12, 1]]), M, { fromSec: 0, toSec: 3 * M, seedClose: null });
    expect(out.t).toEqual([0, M, 2 * M, 3 * M]);
    expect(out.c).toEqual([10.5, 10.5, 10.5, 12]);
    expect(out.o.slice(1, 3)).toEqual([10.5, 10.5]);
    expect(out.h.slice(1, 3)).toEqual([10.5, 10.5]);
    expect(out.v).toEqual([2, 0, 0, 1]);
    expect([out.o[0], out.h[0], out.l[0]]).toEqual([10, 11, 9]); // the real bar untouched
  });

  it("without a seed, never invents a price before the first trade", () => {
    const out = fillCandleGaps(udf([[5 * M, 7, 7, 7, 7, 1]]), M, { fromSec: 0, toSec: 6 * M, seedClose: null });
    expect(out.t[0]).toBe(5 * M);
    expect(out.c).toEqual([7, 7]);
  });

  it("with a seed (last trade before the window), opens the page at `from` on that price", () => {
    const out = fillCandleGaps(udf([[3 * M, 9, 9, 9, 9, 1]]), M, { fromSec: M + 30, toSec: 3 * M, seedClose: 8 });
    expect(out.t).toEqual([M, 2 * M, 3 * M]);
    expect(out.c).toEqual([8, 8, 9]);
  });

  it("extends the line to `toSec` (the chart's current price reaches now)", () => {
    const out = fillCandleGaps(udf([[0, 5, 5, 5, 5, 1]]), M, { fromSec: 0, toSec: 4 * M + 10, seedClose: null });
    expect(out.t[out.t.length - 1]).toBe(4 * M);
    expect(out.c[out.c.length - 1]).toBe(5);
  });

  it("never cuts a real bar that lies after toSec", () => {
    const out = fillCandleGaps(udf([[5 * M, 5, 5, 5, 5, 1]]), M, { fromSec: 0, toSec: M, seedClose: null });
    expect(out.t).toEqual([5 * M]);
  });

  it("no trades and no seed stays no_data; no trades with a seed is a flat line", () => {
    expect(fillCandleGaps(emptyUdf("no_data"), M, { fromSec: 0, toSec: 3 * M, seedClose: null }).s).toBe("no_data");
    const flat = fillCandleGaps(emptyUdf("no_data"), M, { fromSec: 0, toSec: 2 * M, seedClose: 4 });
    expect(flat.s).toBe("ok");
    expect(flat.c).toEqual([4, 4, 4]);
    expect(flat.v).toEqual([0, 0, 0]);
  });

  it("ignores an unusable seed", () => {
    for (const seedClose of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = fillCandleGaps(udf([[2 * M, 3, 3, 3, 3, 1]]), M, { fromSec: 0, toSec: 2 * M, seedClose });
      expect(out.t[0]).toBe(2 * M);
    }
  });

  it("caps the output at maxBars (newest kept) and carries the trimmed close", () => {
    const out = fillCandleGaps(udf([[0, 1, 1, 1, 1, 1], [M, 2, 2, 2, 2, 1]]), M, { fromSec: 0, toSec: 9 * M, seedClose: null, maxBars: 3 });
    expect(out.t).toEqual([7 * M, 8 * M, 9 * M]);
    expect(out.c).toEqual([2, 2, 2]);
    expect(MAX_FILLED_BARS).toBe(5_000);
  });

  it("passes an error response through", () => {
    const err = emptyUdf("error", "boom");
    expect(fillCandleGaps(err, M, { fromSec: 0, toSec: M, seedClose: 1 })).toBe(err);
  });
});

describe("wiring", () => {
  const read = (p: string) => fs.readFileSync(path.resolve(__dirname, p), "utf8");

  it("/api/candles fills only when asked (fill=1), seeded and capped at now", () => {
    const route = read("../../app/api/candles/[slab]/route.ts");
    expect(route).toMatch(/if \(q\.get\("fill"\) === "1"\) \{[\s\S]*?queryLastTradePriceBefore\(validSlab, fromSec\)[\s\S]*?fillCandleGaps\(/);
    expect(route).toMatch(/toSec: Math\.min\(toSec, Math\.floor\(Date\.now\(\) \/ 1000\)\)/);
  });

  it("the chart's Last series asks for the filled series", () => {
    expect(read("../../lib/tv/data/candlesApiProvider.ts")).toMatch(/&to=\$\{Math\.floor\(toSec\)\}&fill=1`/);
  });

  it("the Mark line is drawn on every series, including Mark (it is the current-price line)", () => {
    const tv = read("../../components/trade/tv/TvChart.tsx");
    expect(tv).toMatch(/showMark: true,/);
    expect(tv).not.toMatch(/showMark: s\.series !== "mark"/);
  });

  it("does not seed the fill when the trade query hit its row ceiling (oldest trades were dropped)", () => {
    const route = fs.readFileSync(path.resolve(__dirname, "../../app/api/candles/[slab]/route.ts"), "utf8");
    expect(route).toMatch(/rows\.length >= CANDLE_TRADE_ROW_LIMIT \? null : await queryLastTradePriceBefore/);
  });
});
