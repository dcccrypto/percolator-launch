// @vitest-environment node
/**
 * GH#2616 — the single definition of position notional.
 *
 * These assert EXACT bigint equality. The component test that came first could
 * not: the modal never renders the notional, only `formatLeverage(notional /
 * accountEquity)`, and `formatLeverageValue` is `toFixed(1)`. With its fixture
 * any notional in [425_100_000, 475_000_000] printed "0.9x" — a +5.3% error
 * passed all four of its tests. Review proved that with a mutant that simply
 * added 24 Sim-USDC to the result.
 */

import { describe, expect, it } from "vitest";
import { computeNotionalNative } from "@/lib/notional";

const M = 100_000_001n; // deliberately NOT divisible by 100 — see below

describe("computeNotionalNative", () => {
  it("is exact for integer leverage", () => {
    // Identity-preserving: margin * L * 100 is always divisible by 100, so the
    // old `margin * BigInt(L)` and this agree bit for bit. Existing markets must
    // not shift by a single base unit.
    for (const lev of [1, 2, 3, 5, 10, 200]) {
      expect(computeNotionalNative(M, lev)).toBe(M * BigInt(lev));
    }
  });

  it("is exact for the two-decimal leverages a market can actually have", () => {
    // maxLeverage is `Math.floor((10_000 / initialMarginBps) * 100) / 100` and is
    // offered as the slider's own top snap point, so these are reachable values,
    // not hypotheticals.
    const cases: Array<[number, bigint]> = [
      [2.5, 250_000_002n],
      [3.33, 333_000_003n],
      [4.5, 450_000_004n],
      [6.5, 650_000_006n],
      [6.66, 666_000_006n],
      [9.87, 987_000_009n],
    ];
    for (const [lev, expected] of cases) {
      expect(computeNotionalNative(M, lev)).toBe(expected);
    }
  });

  it("rounds the float artefact instead of flooring it", () => {
    // THE case the first version of these tests could not reach. Its ladder was
    // 2 -> 6.5 by 0.5, and every multiple of 0.5 is binary-exact, so `lev * 100`
    // was always a whole number and floor/ceil/trunc/round were indistinguishable.
    //
    // They are not indistinguishable in production. Sweeping initialMarginBps
    // 1000-5000, 619 of 4001 values (15.5%) give a 2dp leverage whose *100 is
    // not an exact integer. bps 1005 -> leverage 9.95, and 9.95 * 100 is
    // 994.9999999999999.
    expect(9.95 * 100).not.toBe(995); // the artefact itself, so this test explains its own premise
    expect(Math.floor(9.95 * 100)).toBe(994);

    // Flooring would under-size the position by 0.1%. Rounding gives the number
    // the user asked for.
    expect(computeNotionalNative(M, 9.95)).toBe(995_000_009n);
    expect(computeNotionalNative(M, 9.97)).toBe(997_000_009n);
  });

  it("does not divide before multiplying", () => {
    // `(margin / 100n) * BigInt(...)` looks equivalent and is catastrophic for
    // small margins, because bigint division truncates. The first fixture used a
    // margin divisible by 100, which hid it completely.
    expect(computeNotionalNative(99n, 2)).toBe(198n); // margin / 100n would be 0n
    expect(computeNotionalNative(1n, 3)).toBe(3n);
  });

  it("returns 0n for degenerate leverage instead of throwing", () => {
    // BigInt(NaN) raises the very RangeError this function exists to prevent,
    // and this feeds an exported component's prop. A caller that failed to clamp
    // should get a zero-size quote, not a crashed trade page.
    for (const bad of [NaN, Infinity, -Infinity, 0, -1]) {
      expect(computeNotionalNative(M, bad)).toBe(0n);
    }
    expect(computeNotionalNative(0n, 4.5)).toBe(0n);
    expect(computeNotionalNative(-5n, 4.5)).toBe(0n);
  });

  it("CONTROL: the helper is sensitive to both arguments", () => {
    // Without this, a stubbed `return 0n` would satisfy several assertions above.
    expect(computeNotionalNative(M, 4.5)).not.toBe(computeNotionalNative(M, 4));
    expect(computeNotionalNative(M, 4.5)).not.toBe(computeNotionalNative(M + 1n, 4.5));
    expect(computeNotionalNative(M, 4.5)).toBeGreaterThan(0n);
  });
});
