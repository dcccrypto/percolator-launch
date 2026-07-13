import { describe, it, expect } from "vitest";
import { clampClosePercent } from "@/lib/trading";

describe("clampClosePercent", () => {
  it("passes through valid whole percentages unchanged", () => {
    expect(clampClosePercent(1)).toBe(1);
    expect(clampClosePercent(25)).toBe(25);
    expect(clampClosePercent(100)).toBe(100);
  });

  it("rounds fractional input to a whole number", () => {
    expect(clampClosePercent(12.5)).toBe(13);
    expect(clampClosePercent(49.4)).toBe(49);
  });

  it("clamps above 100 down to 100", () => {
    expect(clampClosePercent(150)).toBe(100);
    expect(clampClosePercent(1e9)).toBe(100);
  });

  it("folds malformed / below-range input to the MINIMUM (1), never a full close", () => {
    expect(clampClosePercent(0)).toBe(1);
    expect(clampClosePercent(-5)).toBe(1);
    expect(clampClosePercent(NaN)).toBe(1);
    expect(clampClosePercent(Infinity)).toBe(1);
    expect(clampClosePercent(-Infinity)).toBe(1);
  });
});
