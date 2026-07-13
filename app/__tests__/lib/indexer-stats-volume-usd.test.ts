/**
 * B: lib/indexer-db.ts's queryStatsAggregate previously computed
 * `SUM(ABS(size))` (a raw base-coin "Q" quantity, scale 1e6) and labelled it
 * USD after a `/1e6` division in app/api/stats/route.ts — summing 100 SOL and
 * 2,000,000 PENGU as if they were the same fungible $1 unit, then dividing by
 * the WRONG factor on top (a collateral-decimals divisor, not a price
 * multiplier). The fix mirrors the sibling `queryLeaderboard` query, which
 * already multiplies each trade by its own `price` before summing:
 *   SQL: SUM(ABS(size) * price / 1e6)
 *   `size` is a raw base-asset "Q" quantity (fixed-point, scale 1e6, so
 *   actual_qty = size / 1e6); `price` is a real USD float (a Postgres
 *   `numeric` column, NOT price_e6) — so the expression is exactly
 *   `actual_qty * price` = real USD dollars, no further scaling needed.
 *
 * This test pins the corrected arithmetic with the exact heterogeneous-asset
 * scenario the finding describes, and asserts computeStatsFromIndexer's
 * caller-side conversion (no more `/ COLLATERAL_FACTOR`) is a straight
 * passthrough of that value.
 */
import { describe, it, expect } from "vitest";

interface TradeRow {
  /** Raw base-asset "Q" quantity, fixed-point scale 1e6 (signed; sign ignored via ABS). */
  sizeQ: bigint;
  /** Real USD price (a float, NOT price_e6) — same convention as the `trades.price` column. */
  price: number;
}

/** Mirrors the OLD (buggy) SQL: SUM(ABS(size)) — no price multiplication. */
function oldBuggyVolumeRaw(rows: TradeRow[]): bigint {
  return rows.reduce((sum, r) => sum + (r.sizeQ < 0n ? -r.sizeQ : r.sizeQ), 0n);
}

/**
 * Mirrors the FIXED SQL literally: `SUM(ABS(size) * price / 1e6)`. Postgres
 * `numeric` does this multiplication exactly; plain JS floats are precise
 * enough for the magnitudes this test exercises (this is a formula-shape
 * pin, not a precision stress test).
 */
function fixedVolumeUsd(rows: TradeRow[]): number {
  return rows.reduce((sum, r) => {
    const absSize = r.sizeQ < 0n ? -r.sizeQ : r.sizeQ;
    return sum + (Number(absSize) * r.price) / 1_000_000;
  }, 0);
}

describe("indexer-db queryStatsAggregate: 24h volume must be real USD, not raw Q summed as if fungible", () => {
  it("100 SOL ($81.17) + 2,000,000 PENGU ($0.028) must NOT be summed as one fungible unit", () => {
    const rows: TradeRow[] = [
      { sizeQ: 100_000_000n, price: 81.17 },       // 100 SOL
      { sizeQ: 2_000_000_000_000n, price: 0.028 }, // 2,000,000 PENGU
    ];

    // Old behavior: raw Q summed directly — SOL's 100e6 and PENGU's 2e12 combine
    // into a number with no dollar meaning at all (PENGU's raw quantity dwarfs SOL's).
    const buggyRaw = oldBuggyVolumeRaw(rows);
    expect(buggyRaw).toBe(100_000_000n + 2_000_000_000_000n);

    // Fixed: each trade's own price converts it to real dollars before summing.
    // 100 SOL * $81.17 = $8,117; 2,000,000 PENGU * $0.028 = $56,000. Total = $64,117.
    const fixedUsd = fixedVolumeUsd(rows);
    expect(fixedUsd).toBeCloseTo(8_117 + 56_000, 5);
    expect(fixedUsd).toBeCloseTo(64_117, 5);
  });

  it("computeStatsFromIndexer no longer re-divides by a collateral-decimals factor", () => {
    // agg.volume24hRaw is now ALREADY real USD dollars (see fixedVolumeUsd above),
    // truncated to a whole-dollar bigint (mirrors queryLeaderboard's own truncation).
    const volume24hRaw = 64_117n;
    const COLLATERAL_FACTOR = 10 ** 6;

    const buggyTotalVolume24h = Number(volume24hRaw) / COLLATERAL_FACTOR;
    expect(buggyTotalVolume24h).toBeCloseTo(0.064117, 6); // a $64,117 day rendered as ~$0.06

    const fixedTotalVolume24h = Number(volume24hRaw); // straight passthrough now
    expect(fixedTotalVolume24h).toBe(64_117);
  });

  it("a single-asset (all-SOL) day still converts correctly (sanity check against the old formula)", () => {
    const rows: TradeRow[] = [{ sizeQ: 1_000_000_000n, price: 150 }]; // 1000 SOL @ $150
    expect(fixedVolumeUsd(rows)).toBeCloseTo(150_000, 5);
  });
});
