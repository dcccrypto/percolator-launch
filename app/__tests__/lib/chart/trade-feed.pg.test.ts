// @vitest-environment node
/**
 * TRADE_FEED_SQL against a real Postgres. Skipped unless PERF_PG_URL points at a THROWAWAY database
 * loaded with app/scripts/perf/schema.sql (it inserts and deletes its own rows). Never point it at
 * a shared or live database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { ZERO_UUID, createTradeFeed, pgTradeQuery, type TradeMessage } from "@/lib/chart/trade-feed";

const URL = process.env.PERF_PG_URL;
const S1 = "FeedTestSlab1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const S2 = "FeedTestSlab2xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

describe.skipIf(!URL)("TRADE_FEED_SQL on Postgres", () => {
  const sql = URL ? postgres(URL, { max: 1, prepare: false, onnotice: () => {} }) : (null as never);
  beforeAll(async () => {
    await sql`DELETE FROM trades WHERE slab_address IN (${S1}, ${S2})`;
    await sql`DELETE FROM markets WHERE slab_address IN (${S1}, ${S2})`;
    await sql`INSERT INTO markets (slab_address, mint_address, deployer) VALUES (${S1}, 'm', 'd'), (${S2}, 'm', 'd')`;
  });
  afterAll(async () => {
    await sql`DELETE FROM trades WHERE slab_address IN (${S1}, ${S2})`;
    await sql`DELETE FROM markets WHERE slab_address IN (${S1}, ${S2})`;
    await sql.end();
  });

  it("per-slab cursor, newest-first limit, (created_at, id) tie-break, µs precision", async () => {
    const t0 = "2030-01-01 00:00:00.000123+00";
    // 3 legs at the same microsecond on S1, explicit ids so the order is known. `::text` first:
    // postgres.js serializes a timestamptz-typed param through a JS Date, which drops the µs.
    await sql`INSERT INTO trades (id, slab_address, trader, side, size, price, created_at) VALUES
      ('11111111-1111-1111-1111-111111111111', ${S1}, 't', 'long', 1, 10, ${t0}::text::timestamptz),
      ('33333333-3333-3333-3333-333333333333', ${S1}, 't', 'long', 1, 11, ${t0}::text::timestamptz),
      ('22222222-2222-2222-2222-222222222222', ${S1}, 't', 'long', 1, 12, ${t0}::text::timestamptz)`;
    const q = pgTradeQuery(sql as never, "devnet");
    const startUs = (BigInt(Date.parse("2030-01-01T00:00:00Z")) * 1000n).toString();
    const first = await q([{ slab: S1, afterUs: startUs, afterId: ZERO_UUID }, { slab: S2, afterUs: startUs, afterId: ZERO_UUID }], 2);
    // Newest two by (created_at, id) DESC; nothing for the idle S2.
    expect(first.map((r) => r.id)).toEqual(["33333333-3333-3333-3333-333333333333", "22222222-2222-2222-2222-222222222222"]);
    expect(first[0].cursor_us).toBe((BigInt(Date.parse("2030-01-01T00:00:00Z")) * 1000n + 123n).toString());
    // Strictly after (t0, 3333…): nothing at the same instant is returned again.
    const after = await q([{ slab: S1, afterUs: first[0].cursor_us as string, afterId: first[0].id }], 100);
    expect(after).toEqual([]);
    // After (t0, 2222…): only 3333… (the tie-break is on uuid order).
    const tie = await q([{ slab: S1, afterUs: first[0].cursor_us as string, afterId: "22222222-2222-2222-2222-222222222222" }], 100);
    expect(tie.map((r) => r.id)).toEqual(["33333333-3333-3333-3333-333333333333"]);
    await sql`DELETE FROM trades WHERE slab_address IN (${S1}, ${S2})`;
  });

  it("the feed over the real query emits every row once with an idle slab watched", async () => {
    const base = Date.now() - 5_000;
    const out: TradeMessage[] = [];
    let now = Date.now();
    const f = createTradeFeed({ watched: () => [S1, S2], emit: (m) => out.push(m), now: () => now, query: pgTradeQuery(sql as never, "devnet") });
    for (let i = 0; i < 5; i++) {
      await sql`INSERT INTO trades (slab_address, trader, side, size, price, created_at)
                VALUES (${S1}, 't', 'short', 2, ${20 + i}, ${new Date(base + i * 100).toISOString()})`;
      await f.poll();
      now += 1000;
    }
    expect(await f.poll()).toBe(0);
    expect(out.map((m) => m.price)).toEqual([20, 21, 22, 23, 24]);
    expect(out.every((m) => m.side === "short" && m.size === 2)).toBe(true);
  });
});
