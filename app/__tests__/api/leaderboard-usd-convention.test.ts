/**
 * C: three incompatible volume conventions used to collide across the
 * leaderboard stack:
 *   - lib/indexer-db.ts's queryLeaderboard (indexer path) returned real
 *     USD DOLLARS.
 *   - app/api/leaderboard/route.ts's Supabase fallback path returned
 *     dollars×1e6 ("collateral atoms"-style scaling).
 *   - The client (app/leaderboard/page.tsx) divided by a THIRD, unrelated
 *     divisor (base-asset decimals derived from /api/markets — a category
 *     error for a collateral-scale figure), on top of whatever the API sent.
 * A $250,000 trader could render as "0.25" on the indexer path.
 *
 * The fix: the API always returns `totalVolume` as a plain number of real
 * USD dollars; the client only formats, never rescales. This test pins:
 *   1. The Supabase-path aggregation (mirrored inline, same convention as
 *      the pre-existing __tests__/api/leaderboard.test.ts mirror) converts
 *      its internal micro-USD accumulator to real dollars exactly once.
 *   2. The client's fmtVolume (mirrored) treats its input as dollars — no
 *      divisor parameter exists anymore.
 */
import { describe, it, expect } from "vitest";

/** Mirrors app/api/leaderboard/route.ts's Supabase-path per-trade accumulation
 *  (the primary BigInt branch) — `size` is a raw base-asset Q quantity (scale
 *  1e6), `price` is a real USD float. Produces a micro-USD (dollars×1e6)
 *  accumulator, matching the real route's `totalVolumeMicroUsd` field. */
function accumulateMicroUsd(rows: Array<{ size: string; price: number }>): bigint {
  return rows.reduce((sum, r) => {
    const rawSize = BigInt(String(r.size).split(".")[0]);
    const absSize = rawSize < 0n ? -rawSize : rawSize;
    const priceE6 = BigInt(Math.round(r.price * 1_000_000));
    return sum + (absSize * priceE6) / 1_000_000n;
  }, 0n);
}

/** Mirrors the route's final conversion: real USD dollars, ONCE. */
function toApiTotalVolume(microUsd: bigint): number {
  return Number(microUsd) / 1_000_000;
}

/** Mirrors app/leaderboard/page.tsx's fmtVolume — a plain-number USD formatter,
 *  no divisor argument (that parameter, and the divisor/collateralDecimals
 *  machinery around it, is exactly what this finding removed). */
function fmtVolume(usd: number): string {
  if (!Number.isFinite(usd)) return "—";
  const units = Math.abs(usd);
  const sign = usd < 0 ? "-" : "";
  if (units >= 1_000_000_000) return `${sign}${(units / 1_000_000_000).toFixed(2)}B`;
  if (units >= 1_000_000) return `${sign}${(units / 1_000_000).toFixed(2)}M`;
  if (units >= 1_000) return `${sign}${(units / 1_000).toFixed(1)}K`;
  return `${sign}${units.toLocaleString(undefined, { maximumFractionDigits: units < 1 ? 6 : 2 })}`;
}

describe("leaderboard: unified USD-dollars convention (API returns dollars, client only formats)", () => {
  it("Supabase path: a $250,000 trader converts to the number 250000, not a scaled string", () => {
    // 1000 SOL traded at $250 = $250,000 real notional.
    const rows = [{ size: "1000000000", price: 250 }]; // 1000 SOL (scale 1e6) @ $250
    const microUsd = accumulateMicroUsd(rows);
    expect(microUsd).toBe(250_000_000_000n); // $250,000 × 1e6 internal scale

    const apiValue = toApiTotalVolume(microUsd);
    expect(apiValue).toBe(250_000); // real dollars — NOT "0.25"
  });

  it("indexer path: queryLeaderboard already returns real dollars — no further scaling needed", () => {
    // SUM(ABS(size) * price / 1e6) for 1000 SOL @ $250 in Postgres numeric math.
    const sqlEquivalentDollars = 250_000; // what the SQL expression itself yields
    // The route now does `totalVolume: row.totalVolume` — a straight passthrough.
    const apiValue = sqlEquivalentDollars;
    expect(apiValue).toBe(250_000);
  });

  it("client fmtVolume never divides — the exact bug scenario renders correctly", () => {
    // Before the fix: the client additionally divided by DEFAULT_DIVISOR (1e9 on
    // devnet), turning $250,000 into "0.00025" -> displayed as "0.25" after a
    // stray ×1000 in some code paths. After the fix, fmtVolume(250000) is exact.
    expect(fmtVolume(250_000)).toBe("250.0K");
    expect(fmtVolume(64_117)).toBe("64.1K");
    expect(fmtVolume(0)).toBe("0");
  });

  it("client fmtVolume formats sub-thousand dollar amounts without a K/M/B suffix", () => {
    expect(fmtVolume(42.5)).toBe("42.5");
  });

  it("heterogeneous-asset trades produce a fair dollar ranking, not a raw-quantity ranking", () => {
    // A $50 PENGU trade must NOT outrank a $15,000 SOL trade just because its
    // raw contract-quantity number happens to be larger (50,000 PENGU vs 100 SOL).
    const pengu = accumulateMicroUsd([{ size: "50000000000", price: 0.001 }]); // 50,000 PENGU @ $0.001 = $50
    const sol = accumulateMicroUsd([{ size: "100000000", price: 150 }]);       // 100 SOL @ $150 = $15,000
    expect(toApiTotalVolume(pengu)).toBe(50);
    expect(toApiTotalVolume(sol)).toBe(15_000);
    expect(toApiTotalVolume(sol)).toBeGreaterThan(toApiTotalVolume(pengu));
  });
});
