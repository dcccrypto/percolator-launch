import { describe, expect, it } from "vitest";
import { isExpiring, sizeFromUsd, usdToAtoms, DEFAULT_EXPIRY_MARGIN } from "../src/index";

describe("usdToAtoms", () => {
  it("is exact for strings and numbers, cuts extra digits instead of rounding up", () => {
    expect(usdToAtoms("25", 6)).toBe(25_000_000n);
    expect(usdToAtoms("0.5", 6)).toBe(500_000n);
    expect(usdToAtoms(12.345678, 6)).toBe(12_345_678n);
    expect(usdToAtoms("1.9999999", 6)).toBe(1_999_999n);
    expect(usdToAtoms("1", 9)).toBe(1_000_000_000n);
    expect(usdToAtoms("7", 0)).toBe(7n);
  });
  it("refuses a negative, empty or non-decimal amount", () => {
    for (const bad of ["", "-1", "1e6", "abc", "1.2.3"]) expect(() => usdToAtoms(bad, 6)).toThrow(RangeError);
    expect(() => usdToAtoms(-1, 6)).toThrow(RangeError);
    expect(() => usdToAtoms(Number.NaN, 6)).toThrow(RangeError);
  });
});

describe("sizeFromUsd", () => {
  const market = { effectivePriceE6: "980974", collateralDecimals: 6, lotExp: 0 };
  it("the README's worked example: 25 USD at 0.980974 per lot is 25,484,875 q", () => {
    const s = sizeFromUsd(market, 25);
    expect(s.sizeQ).toBe(25_484_875n);
    expect(s.notionalAtoms).toBe(24_999_999n); // rounded DOWN: never more than the 25 USD asked
    expect(s.notionalAtoms).toBeLessThanOrEqual(25_000_000n);
    expect(s.lots).toBe("25.484875");
    expect(s.baseTokens).toBe("25.484875");
  });
  it("a lot of 10^lotExp tokens scales the token amount, not q", () => {
    const s = sizeFromUsd({ effectivePriceE6: 2_000_000n, collateralDecimals: 6, lotExp: 3 }, "10");
    expect(s.sizeQ).toBe(5_000_000n); // 10 USD / 2.00 per lot = 5 lots
    expect(s.lots).toBe("5");
    expect(s.baseTokens).toBe("5000");
    expect(sizeFromUsd({ effectivePriceE6: 2_000_000n, collateralDecimals: 6 }, "10").baseTokens).toBeNull();
  });
  it("scales by the collateral decimals: the USD amount is turned into atoms first, and notional is in atoms", () => {
    const s = sizeFromUsd({ effectivePriceE6: 2_000_000n, collateralDecimals: 9 }, 10);
    expect(s.sizeQ).toBe(5_000_000_000n); // 10 USD = 10e9 atoms; notionalAtoms = q x priceE6 / 1e6 is in atoms
    expect(s.notionalAtoms).toBe(10_000_000_000n);
  });
  it("refuses what it cannot size honestly", () => {
    expect(() => sizeFromUsd({ ...market, collateralDecimals: null }, 25)).toThrow(/cannot be valued in USD/);
    expect(() => sizeFromUsd({ ...market, effectivePriceE6: "0" }, 25)).toThrow(/no price/);
    expect(() => sizeFromUsd({ effectivePriceE6: 10n ** 30n, collateralDecimals: 6 }, "0.000001")).toThrow(/too small/);
  });
});

describe("isExpiring", () => {
  it("is true within `margin` blocks of lastValidBlockHeight and after it, false with headroom", () => {
    expect(isExpiring(1000, 900)).toBe(false);
    expect(isExpiring(1000, 1000 - DEFAULT_EXPIRY_MARGIN - 1)).toBe(false);
    expect(isExpiring(1000, 1000 - DEFAULT_EXPIRY_MARGIN)).toBe(true);
    expect(isExpiring(1000, 1000)).toBe(true);
    expect(isExpiring(1000, 1500)).toBe(true);
    expect(isExpiring(1000, 960, 50)).toBe(true);
    expect(isExpiring(1000, 960, 10)).toBe(false);
  });
  it("treats an unusable height as expiring (rebuild, never guess)", () => {
    expect(isExpiring(Number.NaN, 5)).toBe(true);
    expect(isExpiring(10, Number.POSITIVE_INFINITY)).toBe(true);
  });
});
