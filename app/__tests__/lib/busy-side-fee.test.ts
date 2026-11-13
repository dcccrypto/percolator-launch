// @vitest-environment node
import { describe, expect, it } from "vitest";
import { busyFeeNotice, busyFeeValue } from "@/lib/busy-side-fee";

describe("busy-side fee wording (owner decision 2026-11-12, item 3)", () => {
  it("the line is the rate and the amount", () => {
    expect(busyFeeValue(500n, "60.25 USDC")).toBe("5.00% · 60.25 USDC");
  });
  it("Max forced 1x: the notice says leverage is fixed and the fee is not part of the entry price", () => {
    expect(busyFeeNotice(500n, "60.25 USDC", true)).toBe(
      "This side is busy. Leverage is fixed at 1x and a 5.00% busy-side fee (60.25 USDC) is included in the trading fee above. It is not part of your entry price.",
    );
  });
  it("Skeptic r9: the notice never says the fee is charged on top (it is inside the total Fee (est.)); the Risk example 0.46% / 2.99 USDC", () => {
    const t = busyFeeNotice(46n, "2.99 USDC", false);
    expect(t).toBe("This side is busy. A 0.46% busy-side fee (2.99 USDC) is included in the trading fee above. It is not part of your entry price.");
    expect(t).not.toContain("on top");
    expect(busyFeeNotice(46n, "2.99 USDC", true)).not.toContain("on top");
  });
  it("not at 1x: the same notice without the leverage sentence", () => {
    const t = busyFeeNotice(500n, "60.25 USDC", false);
    expect(t).toBe("This side is busy. A 5.00% busy-side fee (60.25 USDC) is included in the trading fee above. It is not part of your entry price.");
    expect(t).not.toContain("1x");
  });
});
