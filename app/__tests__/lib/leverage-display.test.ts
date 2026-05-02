import { describe, expect, it } from "vitest";
import { formatLeverage } from "../../lib/leverage-display";

describe("leverage display formatting", () => {
  it("preserves sub-1x risk leverage for over-collateralized slab accounts", () => {
    expect(formatLeverage(0.5)).toBe("0.5x");
  });

  it("formats whole-number order leverage without decimals", () => {
    expect(formatLeverage(2)).toBe("2x");
  });
});
