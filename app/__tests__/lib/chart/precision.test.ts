import { describe, expect, it } from "vitest";
import { formatPerpPrice, perpPricePrecision } from "@/lib/chart/precision";

describe("perpPricePrecision", () => {
  it.each([
    [3500, 2], [226.87, 4], [1, 4], [0.22687, 4], [0.0346, 5], [0.00346, 6], [0.000126, 7], [0.0000012, 8], [1e-12, 8],
  ])("%s -> %s decimals", (ref, dp) => {
    expect(perpPricePrecision(ref).precision).toBe(dp);
  });
  it("falls back safely for missing / invalid references", () => {
    for (const bad of [null, undefined, 0, NaN]) expect(perpPricePrecision(bad as number).precision).toBe(2);
  });
  it("minMove is exactly one unit of the last shown decimal", () => {
    expect(perpPricePrecision(0.00346).minMove).toBe(0.000001);
  });
  it("formats a memecoin without rounding the e6 step away", () => {
    expect(formatPerpPrice(0.000126, 0.000126)).toBe("0.0001260");
    expect(formatPerpPrice(0.000127, 0.000126)).not.toBe(formatPerpPrice(0.000126, 0.000126));
    expect(formatPerpPrice(null)).toBe("—");
  });
});
