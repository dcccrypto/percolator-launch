/** M7: the wording of a finished trade's result, the per-device ledger, and the neutral tag for pending value. */
import { beforeEach, describe, expect, it } from "vitest";
import { closeResultText, formatSignedAtoms, getLastResult, getRealized, pendingTag, recordRealized } from "@/lib/realized-pnl";

describe("close toast text", () => {
  it("a loss reads with a real minus, never as profit, and says what it excludes", () => {
    expect(formatSignedAtoms(-56_043n, 6, "USDC")).toBe("−0.056043 USDC");
    const t = closeResultText({ base: "Position closed.", execPriceText: "$89.419", result: -412_000n, decimals: 6, symbol: "USDC" });
    expect(t).toBe("Position closed. Effective price $89.419. Trade result −0.412 USDC (trading fees, spread and other non-base fees included; funding and maintenance fees not included).");
    expect(t).not.toMatch(/profit/i);
  });
  it("unmeasured halves are left out, never zeroed", () => {
    expect(closeResultText({ base: "Position closed.", execPriceText: null, result: null, decimals: 6, symbol: "USDC" })).toBe("Position closed.");
  });
});

describe("device ledger", () => {
  beforeEach(() => localStorage.clear());
  it("sums finished trades per wallet + market and remembers the last", () => {
    expect(getRealized("W", "S")).toBeNull();
    recordRealized("W", "S", -412_000n);
    recordRealized("W", "S", 300_000n);
    expect(getRealized("W", "S")).toBe(-112_000n);
    expect(getLastResult("W", "S")).toBe(300_000n);
    expect(getRealized("W", "OTHER")).toBeNull();
  });
});

describe("pendingTag: 'profit' only for a measured gain", () => {
  it("a loss, or an unknown result, reads neutral", () => {
    expect(pendingTag(21_000n, -56_043n)).toBe("claim pending");
    expect(pendingTag(21_000n, 0n)).toBe("claim pending");
    expect(pendingTag(21_000n, null)).toBe("claim pending");
  });
  it("a measured gain reads 'profit settling'; nothing pending is idle", () => {
    expect(pendingTag(21_000n, 500_000n)).toBe("profit settling");
    expect(pendingTag(0n, -5n)).toBe("idle collateral");
  });
});
