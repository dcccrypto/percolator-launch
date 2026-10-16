// @vitest-environment node
/**
 * Review E3 (2026-10-14): /api/candles aggregates OHLCV in Postgres instead of pulling raw trades.
 *
 * The pure parts always run. The equivalence check runs against a real Postgres only when
 * PERF_PG_URL points at a THROWAWAY database loaded with app/scripts/perf/schema.sql (it inserts
 * and deletes its own rows): the SQL aggregate must equal the old path (queryTradesForCandles +
 * bucketCandles, the reference) bar for bar on the same rows.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { alignCandleWindow } from "@/lib/tv/data/candlesApiProvider";

const PG = process.env.PERF_PG_URL;
if (PG) process.env.INDEXER_DATABASE_URL = PG; // before indexer-db is used: getSql() reads it lazily

const { aggRowsToUdf, bucketCandles, candleWindow, queryCandlesAggregated, queryTradesForCandles, RES_TO_SECONDS } =
  await import("@/lib/indexer-db");

describe("candle window rounding", () => {
  it("server: the bucket of `from` through the end of the bucket of `to`", () => {
    expect(candleWindow(3_661, 7_259, 3_600)).toEqual({ firstBucket: 3_600, lastBucket: 7_200, endExclusive: 10_800 });
    expect(candleWindow(3_600, 7_200, 3_600)).toEqual({ firstBucket: 3_600, lastBucket: 7_200, endExclusive: 10_800 });
  });
  it("client: both down to the bucket; the server window is the same as for the raw values", () => {
    expect(alignCandleWindow(3_661, 7_259, 3_600)).toEqual({ from: 3_600, to: 7_200 });
    expect(alignCandleWindow(3_600, 7_200, 3_600)).toEqual({ from: 3_600, to: 7_200 });
    const a = alignCandleWindow(3_661, 7_259, 3_600);
    expect(candleWindow(a.from, a.to, 3_600)).toEqual(candleWindow(3_661, 7_259, 3_600));
    // Every raw `now` inside one bucket maps to ONE url (that is what makes the edge cache hit).
    const urls = new Set([7_201, 8_000, 10_799].map((now) => JSON.stringify(alignCandleWindow(now - 30 * 3_600, now, 3_600))));
    expect(urls.size).toBe(1);
  });
  it("aggRowsToUdf parses numeric text with Number(), as the raw path did", () => {
    expect(aggRowsToUdf([])).toEqual({ s: "no_data", t: [], o: [], h: [], l: [], c: [], v: [] });
    expect(aggRowsToUdf([{ t: "60", o: "1.500000", h: "2.25", l: "1", c: "2", v: "15" }])).toEqual({
      s: "ok", t: [60], o: [1.5], h: [2.25], l: [1], c: [2], v: [15],
    });
  });
});

describe.skipIf(!PG)("SQL aggregate == bucketCandles on the same rows (real Postgres)", () => {
  const SLAB = "CandleAggTestSlabxxxxxxxxxxxxxxxxxxxxxxxxxx";
  const sql = PG ? postgres(PG, { max: 1, prepare: false, onnotice: () => {} }) : (null as never);
  const BASE = 1_790_000_000; // seconds, a fixed past instant
  const SPAN = 3 * 86_400;

  beforeAll(async () => {
    await sql`DELETE FROM trades WHERE slab_address = ${SLAB}`;
    await sql`DELETE FROM markets WHERE slab_address = ${SLAB}`;
    await sql`INSERT INTO markets (slab_address, mint_address, deployer) VALUES (${SLAB}, 'm', 'd')`;
    // 6,000 trades with distinct microsecond timestamps over 3 days, 6-decimal prices, integer
    // sizes (raw Q units, as the indexer writes them), plus every row shape the reference skips.
    await sql.unsafe(
      `INSERT INTO trades (slab_address, trader, side, size, price, created_at)
       SELECT $1, 't', CASE WHEN g % 2 = 0 THEN 'long' ELSE 'short' END,
              (CASE WHEN g % 7 = 0 THEN -1 ELSE 1 END) * (1 + (g * 7919) % 5000000000),
              round((50 + ((g * 104729) % 150000000) / 1000000.0)::numeric, 6),
              to_timestamp($2::bigint) + ((g::bigint * 43199993) % ($3::bigint * 1000000)) * interval '1 microsecond'
         FROM generate_series(1, 6000) g`,
      [SLAB, BASE, SPAN],
    );
    await sql.unsafe(
      `INSERT INTO trades (slab_address, trader, side, size, price, is_liquidation, created_at) VALUES
        ($1, 't', NULL, NULL, NULL, true, to_timestamp($2::bigint + 1000) + interval '17 microseconds'),
        ($1, 't', 'long', 5, 0, false, to_timestamp($2::bigint + 2000) + interval '18 microseconds'),
        ($1, 't', 'long', 5, -3, false, to_timestamp($2::bigint + 3000) + interval '19 microseconds'),
        ($1, 't', 'long', 5, 'NaN', false, to_timestamp($2::bigint + 4000) + interval '20 microseconds'),
        ($1, 't', 'long', NULL, 77.5, false, to_timestamp($2::bigint + 5000) + interval '21 microseconds')`,
      [SLAB, BASE],
    );
  });
  afterAll(async () => {
    await sql`DELETE FROM trades WHERE slab_address = ${SLAB}`;
    await sql`DELETE FROM markets WHERE slab_address = ${SLAB}`;
    await sql.end();
  });

  const windows: Array<[string, number, number]> = [
    ["whole span", BASE - 10, BASE + SPAN + 10],
    ["mid-bucket edges", BASE + 12_345, BASE + 98_765],
    ["sub-hour", BASE + 40_000, BASE + 41_000],
  ];

  for (const res of Object.keys(RES_TO_SECONDS)) {
    for (const [label, from, to] of windows) {
      it(`resolution ${res}, ${label}: identical OHLCV`, async () => {
        const b = RES_TO_SECONDS[res];
        const win = candleWindow(from, to, b);
        // The reference: the OLD route's own query + bucketing, over the same bucket-aligned window.
        // (queryTradesForCandles' upper bound is inclusive; drop rows at/after the exclusive end.)
        const raw = (await queryTradesForCandles(SLAB, win.firstBucket, win.endExclusive)).filter(
          (r) => r.created_at.getTime() < win.endExclusive * 1000,
        );
        const reference = bucketCandles(raw, b);
        const { udf, truncated } = await queryCandlesAggregated(SLAB, b, win.firstBucket, win.endExclusive, { sql: sql as never });
        expect(truncated).toBe(false);
        expect(udf).toEqual(reference);
        if (label === "whole span") expect(udf.t.length).toBeGreaterThan(0);
      });
    }
  }

  it("the bar ceiling keeps the NEWEST bars and reports truncation", async () => {
    const b = 60;
    const win = candleWindow(BASE, BASE + SPAN, b);
    const full = await queryCandlesAggregated(SLAB, b, win.firstBucket, win.endExclusive, { sql: sql as never });
    const capped = await queryCandlesAggregated(SLAB, b, win.firstBucket, win.endExclusive, { sql: sql as never, maxBars: 100 });
    expect(capped.truncated).toBe(true);
    expect(capped.udf.t).toEqual(full.udf.t.slice(-100));
    expect(capped.udf.c).toEqual(full.udf.c.slice(-100));
  });
});
