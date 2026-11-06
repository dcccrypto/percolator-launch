import { describe, it, expect } from "vitest";
import { isReducingOrder } from "@/hooks/useTrade";

describe("isReducingOrder (council GO1106: closes may bundle the taker crank)", () => {
  it("a full or partial close of a long / short is reducing", () => {
    expect(isReducingOrder(10n, -10n, 1)).toBe(true);
    expect(isReducingOrder(10n, -4n, 1)).toBe(true);
    expect(isReducingOrder(-10n, 10n, 1)).toBe(true);
  });
  it("adds, flips, opens from flat, unknown and multi-leg orders are not", () => {
    expect(isReducingOrder(10n, 5n, 1)).toBe(false); // add
    expect(isReducingOrder(10n, -11n, 1)).toBe(false); // flip
    expect(isReducingOrder(0n, -5n, 1)).toBe(false); // open
    expect(isReducingOrder(null, -5n, 1)).toBe(false); // unknown
    expect(isReducingOrder(10n, -10n, 2)).toBe(false); // multi-leg
  });
});
