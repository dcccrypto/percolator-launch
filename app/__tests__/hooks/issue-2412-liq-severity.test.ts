import { describe, expect, it } from "vitest";
import { getLiquidationSeverity } from "../../hooks/usePortfolio";

// #2412 — both comparisons are FALSE for NaN, so an unguarded non-finite
// distance fell through to "safe": a position at liquidation risk rendering as
// fine. That is the one direction a risk indicator must never fail in.
describe("#2412 getLiquidationSeverity never reports safe on bad data", () => {
  it("does not report NaN as safe", () => {
    expect(getLiquidationSeverity(NaN)).not.toBe("safe");
  });

  it("does not report Infinity as safe", () => {
    expect(getLiquidationSeverity(Infinity)).not.toBe("safe");
    expect(getLiquidationSeverity(-Infinity)).not.toBe("safe");
  });

  it("fails toward danger, not merely warning", () => {
    // A suppressed warning is a liquidation the user never saw coming; a
    // spurious one is noise. The asymmetry justifies the loudest bucket.
    expect(getLiquidationSeverity(NaN)).toBe("danger");
  });

  it("still classifies real values correctly — the guard did not flatten it", () => {
    expect(getLiquidationSeverity(5)).toBe("danger");
    expect(getLiquidationSeverity(10)).toBe("danger");
    expect(getLiquidationSeverity(20)).toBe("warning");
    expect(getLiquidationSeverity(30)).toBe("warning");
    expect(getLiquidationSeverity(31)).toBe("safe");
    expect(getLiquidationSeverity(100)).toBe("safe");
  });
});
