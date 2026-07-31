/**
 * Leg math for over-cap closes (lib/closeChunks.ts).
 *
 * The invariants that matter on-chain, pinned with exact values:
 *  - legs sum to the requested close EXACTLY (a drifted sum closes the wrong
 *    amount — or over-closes into opposite exposure);
 *  - every leg is under the matcher's per-fill cap (one over-cap leg reverts
 *    the whole BatchTradeCpi with the bare InvalidAccountData this exists to
 *    prevent);
 *  - sign is preserved on every leg (a flipped leg would ADD exposure);
 *  - leg count is the minimum ceil (extra legs = extra matcher fills = fees).
 */
import { describe, it, expect } from "vitest";
import { chunkCloseSize } from "@/lib/closeChunks";

describe("chunkCloseSize", () => {
  it("passes through when under or at the cap", () => {
    expect(chunkCloseSize(500n, 1000n)).toEqual([500n]);
    expect(chunkCloseSize(1000n, 1000n)).toEqual([1000n]);
    expect(chunkCloseSize(-1000n, 1000n)).toEqual([-1000n]);
  });

  it("passes through when the cap is unknown (0)", () => {
    expect(chunkCloseSize(999_999n, 0n)).toEqual([999_999n]);
  });

  it("returns no legs for a zero close", () => {
    expect(chunkCloseSize(0n, 1000n)).toEqual([]);
  });

  it("splits one-over-cap into two near-equal legs", () => {
    expect(chunkCloseSize(1001n, 1000n)).toEqual([501n, 500n]);
  });

  it("splits a 4x-cap position (the structural maximum) into exactly 4 legs", () => {
    // maxInventoryAbs = 4 × maxFillAbs, so this is the biggest close a market
    // can produce. Position: full inventory cap, negative (closing a long).
    const legs = chunkCloseSize(-4000n, 1000n);
    expect(legs).toEqual([-1000n, -1000n, -1000n, -1000n]);
  });

  it("holds all invariants on the real CATE-scale numbers", () => {
    const total = -202_520_251_800n; // closing the whole long side
    const cap = 205_380_981_721n / 4n; // a quarter-cap for a 4-leg split
    const legs = chunkCloseSize(total, cap);
    expect(legs.length).toBe(4);
    expect(legs.reduce((a, b) => a + b, 0n)).toBe(total);
    for (const leg of legs) {
      expect(leg < 0n).toBe(true);
      expect(-leg <= cap).toBe(true);
    }
  });

  it("never emits a dust leg — remainder spreads across the first legs", () => {
    // 10 over 3-cap → ceil = 4 legs of 3,3,2,2 — NOT 3,3,3,1.
    expect(chunkCloseSize(10n, 3n)).toEqual([3n, 3n, 2n, 2n]);
  });
});
