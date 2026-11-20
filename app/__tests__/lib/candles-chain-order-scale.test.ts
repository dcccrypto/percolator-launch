// @vitest-environment node
/**
 * Candles vs trades (J-20261120-IDX-REPORT-DIFF-CANDLESVSTRADES), ported from the report's draft tests: three of
 * its five mismatch causes, fixed in CANDLE_AGG_SQL / aggRowsToUdf.
 *
 *  - ordering key: one webhook INSERT stamps every fill with the same created_at, so open/close came from a
 *    random uuid. Chain order inside a tx (leg_index) now breaks the tie.
 *  - unit scale (lot_exp): a lot market's rows can mix per-LOT prices (written before the indexer knew lot_exp)
 *    and per-token prices; the chart drew a 10^lot_exp cliff. Rows are now normalised to per token.
 *  - unit scale (precision): volume above 2^53 was rounded by Number(); it is now exact text.
 *  - control: a price-0 fill still adds nothing to volume, and a minute with only price-0 fills has no bar.
 *
 * The SQL parts run through queryCandlesAggregated's CandleSql seam against a real Postgres, only when
 * PERF_PG_URL points at a THROWAWAY database (this test creates and drops its own schema `candle_cvt_test`).
 * The precision check on aggRowsToUdf is pure and always runs.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { aggRowsToUdf, candleWindow, queryCandlesAggregated, type CandleSql } from "@/lib/indexer-db";

const PG = process.env.PERF_PG_URL;
const SCHEMA = "candle_cvt_test";
const T = (iso: string) => Date.parse(iso) / 1000;

describe("unit scale (precision): volume above 2^53 is not rounded", () => {
  it("aggRowsToUdf keeps v as the exact numeric text Postgres sent", () => {
    const u = aggRowsToUdf([{ t: "60", o: "1", h: "1.1", l: "1", c: "1.1", v: "123465796211600419894" }]);
    expect(String(u.v[0])).toBe("123465796211600419894"); // base: 123465796211600420000 (Number)
  });
});

describe.skipIf(!PG)("candle SQL vs chain order and lot scale (real Postgres)", () => {
  const sql = PG ? postgres(PG, { max: 1, prepare: false, onnotice: () => {} }) : (null as never);
  // The CandleSql test double: the real client, pinned to this test's schema.
  const candleSql: CandleSql = {
    unsafe: async (q, p) => {
      await sql.unsafe(`SET search_path TO ${SCHEMA}`);
      return sql.unsafe(q, p as never[]);
    },
  };

  type Row = { slab: string; sig: string; leg: number; size: string | null; price: string | null; at: string; id?: string; net?: string };
  const D = "2026-11-01";
  // Ids chosen so the uuid order is the REVERSE of chain order: with `ORDER BY created_at, id` the tie is
  // decided the wrong way every time (in production the uuid is random: open right ~1 in n).
  const ROWS: Row[] = [
    // One tx, three legs, one INSERT (identical created_at). Chain order: leg 0 (21), leg 1 (22), leg 2 (23).
    { slab: "SYNslot", sig: "s-tx7", leg: 0, size: "10", price: "21", at: `${D} 11:00:10`, id: "ffffffff-0000-0000-0000-000000000000" },
    { slab: "SYNslot", sig: "s-tx7", leg: 1, size: "-10", price: "22", at: `${D} 11:00:10`, id: "88888888-0000-0000-0000-000000000000" },
    { slab: "SYNslot", sig: "s-tx7", leg: 2, size: "10", price: "23", at: `${D} 11:00:10`, id: "00000000-0000-0000-0000-000000000000" },
    // lot_exp 3: 50 and 51 are per LOT (written at the lot 0 fallback), 0.052 / 0.053 per token.
    { slab: "SYNlot", sig: "x-1", leg: 0, size: "1000000", price: "50", at: `${D} 13:00:10` },
    { slab: "SYNlot", sig: "x-2", leg: 0, size: "1000000", price: "51", at: `${D} 13:01:10` },
    { slab: "SYNlot", sig: "x-3", leg: 0, size: "-1000000", price: "0.052", at: `${D} 13:01:40` },
    { slab: "SYNlot", sig: "x-4", leg: 0, size: "1000000", price: "0.053", at: `${D} 13:02:10` },
    // Volume above 2^53 (2^53 + 1 and ~1.2e20).
    { slab: "SYNbig", sig: "v-1", leg: 0, size: "9007199254740993", price: "1", at: `${D} 17:00:10` },
    { slab: "SYNbig", sig: "v-2", leg: 0, size: "-123456789012345678901", price: "1.1", at: `${D} 17:00:20` },
    // Price-0 fills (policy kept: no price, no volume).
    { slab: "SYNzero", sig: "z-a", leg: 0, size: "100", price: "5", at: `${D} 12:00:05` },
    { slab: "SYNzero", sig: "z-0", leg: 0, size: "1000", price: "0", at: `${D} 12:00:20` },
    { slab: "SYNzero", sig: "z-b", leg: 0, size: "-100", price: "6", at: `${D} 12:00:40` },
    { slab: "SYNzero", sig: "z-0only", leg: 0, size: "700", price: "0", at: `${D} 12:01:30` },
  ];

  beforeAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await sql.unsafe(`CREATE SCHEMA ${SCHEMA}`);
    // The columns CANDLE_AGG_SQL reads, as in app/scripts/perf/schema.sql (the live indexer table).
    await sql.unsafe(`CREATE TABLE ${SCHEMA}.trades (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), slab_address TEXT NOT NULL, trader TEXT NOT NULL, side TEXT,
      size NUMERIC, price NUMERIC, tx_signature TEXT, asset_index SMALLINT NOT NULL DEFAULT 0,
      leg_index SMALLINT NOT NULL DEFAULT 0, is_liquidation BOOLEAN NOT NULL DEFAULT false,
      network TEXT NOT NULL DEFAULT 'devnet', created_at TIMESTAMPTZ DEFAULT NOW())`);
    for (const r of ROWS) {
      await sql.unsafe(
        `INSERT INTO ${SCHEMA}.trades (id, slab_address, trader, size, price, tx_signature, leg_index, network, created_at)
         VALUES (coalesce($1::uuid, gen_random_uuid()), $2, 't', $3::numeric, $4::numeric, $5, $6::smallint, $7, $8::timestamptz)`,
        [r.id ?? null, r.slab, r.size, r.price, r.sig, r.leg, r.net ?? "devnet", `${r.at}+00`],
      );
    }
  });
  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await sql.end();
  });

  async function chart(slab: string, fromIso: string, toIso: string, lot?: { lotExp: number; anchor: number | null }) {
    const win = candleWindow(T(fromIso), T(toIso), 60);
    // `lot` is spread so the call has the same shape on the base branch (which has no such option).
    const opts = { sql: candleSql, network: "devnet", ...(lot ? { lot } : {}) };
    return (await queryCandlesAggregated(slab, 60, win.firstBucket, win.endExclusive, opts)).udf;
  }
  const bar = (u: { t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v: Array<number | string> }, iso: string) => {
    const i = u.t.indexOf(T(iso));
    return i < 0 ? undefined : { o: u.o[i], h: u.h[i], l: u.l[i], c: u.c[i], v: Number(u.v[i]) };
  };

  it("ordering: legs of one tx with identical created_at open/close by leg_index", async () => {
    const b = bar(await chart("SYNslot", `${D}T11:00:00Z`, `${D}T11:00:59Z`), `${D}T11:00:00Z`);
    expect(b).toMatchObject({ o: 21, h: 23, l: 21, c: 23 }); // base: o 23, c 21 (uuid order)
  });

  it("unit scale (lot_exp): a lot market's bars are all per token, no 10^lot_exp cliff", async () => {
    const u = await chart("SYNlot", `${D}T13:00:00Z`, `${D}T13:02:59Z`, { lotExp: 3, anchor: 0.053 });
    expect(Math.max(...u.h) / Math.min(...u.l)).toBeLessThan(10); // base: 51 / 0.052 = 981
    expect(bar(u, `${D}T13:00:00Z`)).toMatchObject({ o: 0.05, c: 0.05 });
    expect(bar(u, `${D}T13:01:00Z`)).toMatchObject({ o: 0.051, h: 0.052, l: 0.051, c: 0.052 });
    expect(bar(u, `${D}T13:02:00Z`)).toMatchObject({ o: 0.053, c: 0.053 });
  });

  it("unit scale (lot_exp): lot_exp 0 or no anchor leaves stored prices untouched", async () => {
    for (const lot of [undefined, { lotExp: 0, anchor: 0.053 }, { lotExp: 3, anchor: null }]) {
      const u = await chart("SYNlot", `${D}T13:00:00Z`, `${D}T13:02:59Z`, lot);
      expect(bar(u, `${D}T13:01:00Z`)).toMatchObject({ o: 51, h: 51, l: 0.052, c: 0.052 });
    }
  });

  it("unit scale (precision): volume above 2^53 reaches the UDF exact", async () => {
    const u = await chart("SYNbig", `${D}T17:00:00Z`, `${D}T17:00:59Z`);
    expect(String(u.v[0])).toBe("123465796211600419894"); // 9007199254740993 + 123456789012345678901
  });

  it("price-0 (unchanged): a price-0 fill adds no volume and a price-0-only minute has no bar", async () => {
    const u = await chart("SYNzero", `${D}T12:00:00Z`, `${D}T12:01:59Z`);
    expect(bar(u, `${D}T12:00:00Z`)).toMatchObject({ o: 5, c: 6, v: 200 });
    expect(bar(u, `${D}T12:01:00Z`)).toBeUndefined();
  });
});
