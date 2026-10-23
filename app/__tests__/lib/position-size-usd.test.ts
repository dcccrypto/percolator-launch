/**
 * "≈ $200.12" under a position's base-unit size: the size is engine Q (1e6
 * scale whatever the mint's decimals), valued at the mark. No mark, no line.
 */
import { describe, expect, it } from "vitest";
import { positionSizeUsdText } from "@/lib/q-usd";

describe("positionSizeUsdText", () => {
  it("values Q at the mark: 20385.281826 PENGU @ $0.009817", () => {
    expect(positionSizeUsdText(20_385_281_826n, 9_817n)).toBe("≈ $200.12");
  });

  it("uses Q_SCALE, not a 9-decimal mint's divisor (1 SOL is $118.78, not $0.12)", () => {
    expect(positionSizeUsdText(1_000_000n, 118_780_000n)).toBe("≈ $118.78");
  });

  it("a short's size is shown by its magnitude", () => {
    expect(positionSizeUsdText(-1_000_000n, 100_000_000n)).toBe("≈ $100.00");
  });

  it("groups thousands", () => {
    expect(positionSizeUsdText(1_500_000_000n, 100_000_000n)).toBe("≈ $150,000.00");
  });

  it("no line without a mark or a position (never $0.00)", () => {
    expect(positionSizeUsdText(1_000_000n, null)).toBeNull();
    expect(positionSizeUsdText(1_000_000n, undefined)).toBeNull();
    expect(positionSizeUsdText(1_000_000n, 0n)).toBeNull();
    expect(positionSizeUsdText(0n, 100_000_000n)).toBeNull();
  });
});
