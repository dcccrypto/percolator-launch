/**
 * GH#2510 / review on #2512 — the SQL aggregate must match the JS reducer it
 * replaced, PER ROW.
 *
 * The first version of the aggregate summed the fractional per-row values and
 * let the final `::bigint` cast round. That is a different number from what the
 * reducer produced, and not by a rounding error: the reducer accumulates with
 * BigInt division, which truncates on EVERY trade.
 *
 *   ten trades, size 1 at price 1.9   reducer: 10   sum-then-round: 19
 *
 * These fixtures pin that semantics. They model both implementations in
 * JavaScript rather than hitting Postgres — the CI environment has no database,
 * and what is being pinned is the ARITHMETIC contract, which is expressible
 * either side. The SQL in `queryTraderStatsAggregate` is written to match
 * `sqlPerRowTrunc` below expression-for-expression; if that SQL changes, this
 * file is the statement of what it has to keep doing.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

interface Row {
  size: string;
  price: string;
  fee: string;
}

/** The reducer this replaced, volume only (route.ts aggregateRows). */
function jsReducerVolume(rows: Row[]): bigint {
  let total = 0n;
  for (const r of rows) {
    const raw = BigInt(String(r.size).split(".")[0]);
    const abs = raw < 0n ? -raw : raw;
    const priceE6 = BigInt(Math.round(Number(r.price) * 1_000_000));
    total += (abs * priceE6) / 1_000_000n; // BigInt division truncates, per trade
  }
  return total;
}

/** What the SQL does now: trunc() per row, then sum. */
function sqlPerRowTrunc(rows: Row[]): bigint {
  let total = 0;
  for (const r of rows) {
    const abs = Math.abs(Math.trunc(Number(r.size)));
    const priceE6 = Math.floor(Number(r.price) * 1_000_000 + 0.5);
    total += Math.trunc((abs * priceE6) / 1_000_000);
  }
  return BigInt(total);
}

/** The bug: sum the fractional values, round once at the end (`::bigint`). */
function sqlSumThenRound(rows: Row[]): bigint {
  let total = 0;
  for (const r of rows) {
    const abs = Math.abs(Math.trunc(Number(r.size)));
    const priceE6 = Math.floor(Number(r.price) * 1_000_000 + 0.5);
    total += (abs * priceE6) / 1_000_000;
  }
  return BigInt(Math.round(total));
}

const FIXTURES: { name: string; rows: Row[] }[] = [
  { name: "single fractional price (the reviewer's example)", rows: [{ size: "1", price: "1.5", fee: "0" }] },
  { name: "two fractional trades", rows: [{ size: "1", price: "1.5", fee: "0" }, { size: "1", price: "1.5", fee: "0" }] },
  { name: "sub-unit product truncates to zero", rows: [{ size: "3", price: "0.33", fee: "0" }] },
  { name: "ten trades that drift far apart", rows: Array.from({ length: 10 }, () => ({ size: "1", price: "1.9", fee: "0" })) },
  { name: "whole numbers (no divergence possible)", rows: [{ size: "2", price: "2.0", fee: "0" }] },
  { name: "size carries a decimal part, truncated first", rows: [{ size: "2.9", price: "1.0", fee: "0" }] },
  { name: "negative size uses absolute value", rows: [{ size: "-3", price: "2.0", fee: "0" }] },
];

describe("trader-stats volume: SQL matches the JS reducer per row", () => {
  for (const { name, rows } of FIXTURES) {
    it(`matches for: ${name}`, () => {
      expect(sqlPerRowTrunc(rows)).toBe(jsReducerVolume(rows));
    });
  }

  it("the sum-then-round form diverges — this is what review caught", () => {
    const rows = Array.from({ length: 10 }, () => ({ size: "1", price: "1.9", fee: "0" }));
    expect(jsReducerVolume(rows)).toBe(10n);
    expect(sqlSumThenRound(rows)).toBe(19n); // the first version of the aggregate
    expect(sqlPerRowTrunc(rows)).toBe(10n); // the fix
  });

  it("rounds like Math.round, not like Postgres round(), on negative halves", () => {
    // Math.round(-1.5) === -1 (toward +Infinity); Postgres round(-1.5) = -2.
    // The SQL uses floor(x + 0.5) so the two agree.
    expect(Math.floor(-1.5 + 0.5)).toBe(Math.round(-1.5));
    expect(Math.floor(2.5 + 0.5)).toBe(Math.round(2.5));
  });
});

/**
 * The fixtures above state the contract but cannot enforce it: they model both
 * implementations in JavaScript, so reverting the real SQL leaves them green.
 * Verified by mutation — restoring the sum-then-round form failed nothing.
 *
 * This binds it. The per-row `trunc()` is the whole fix, so its presence is
 * asserted directly against the source; the fixtures above are the explanation
 * of why it has to be there.
 */
describe("the aggregate SQL actually truncates per row", () => {
  const SRC = fs.readFileSync(
    path.resolve(__dirname, "../../lib/indexer-db.ts"),
    "utf8",
  );

  function aggregateSql(): string {
    const start = SRC.indexOf("export async function queryTraderStatsAggregate");
    expect(start).toBeGreaterThan(-1);
    const end = SRC.indexOf("export interface TraderStatsRow", start) > -1
      ? SRC.indexOf("export interface TraderStatsRow", start)
      : start + 4000;
    return SRC.slice(start, end);
  }

  it("wraps the per-row volume expression in trunc() before summing", () => {
    const sql = aggregateSql();
    // sum(trunc(...)) — NOT sum(...) with a trailing ::bigint doing the rounding.
    expect(sql).toMatch(/sum\(\s*trunc\(/);
    expect(sql).not.toMatch(/sum\(\s*\n?\s*abs\(trunc\(size/);
  });

  it("rounds price and fee with floor(x + 0.5), matching Math.round", () => {
    const sql = aggregateSql();
    expect(sql).toMatch(/floor\(price::numeric \* 1000000 \+ 0\.5\)/);
    expect(sql).toMatch(/floor\(fee::numeric \+ 0\.5\)/);
  });
});
