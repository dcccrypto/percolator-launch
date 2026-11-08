/** M7: realized PnL reconciles with the chain: the change of (capital + settled pnl) across the close, spread and fees included. */
import { beforeEach, describe, expect, it } from "vitest";
import { closeResultText, formatSignedAtoms, getRealized, pendingTag, realizedFromEquity, recordRealized } from "@/lib/realized-pnl";

describe("realizedFromEquity", () => {
  it("council round trip: 44.14 capital in, 43.728 out is a -0.412 loss (fee 0.24 + spread 0.172), not the fee-only -0.20", () => {
    const r = realizedFromEquity({ capital: 44_140_000n, pnl: 0n }, { capital: 43_728_000n, pnl: 0n });
    expect(r).toBe(-412_000n);
  });
  it("a gain that lands in pnl counts, and a gain+loss across the two fields nets", () => {
    expect(realizedFromEquity({ capital: 10_000_000n, pnl: 0n }, { capital: 9_900_000n, pnl: 600_000n })).toBe(500_000n);
    expect(realizedFromEquity({ capital: 10_000_000n, pnl: 300_000n }, { capital: 9_000_000n, pnl: 0n })).toBe(-1_300_000n);
  });
});

describe("close toast text", () => {
  it("a loss reads with a real minus and never as profit", () => {
    expect(formatSignedAtoms(-412_000n, 6, "USDC")).toBe("−0.412 USDC");
    expect(formatSignedAtoms(21_000n, 6, "USDC")).toBe("+0.021 USDC");
    const t = closeResultText({ base: "Position closed.", execPriceText: "$89.311989", realized: -412_000n, decimals: 6, symbol: "USDC" });
    expect(t).toBe("Position closed. Executed at $89.311989. Realized −0.412 USDC (fees and spread included).");
    expect(t).not.toMatch(/profit/i);
  });
  it("unmeasured halves are left out, never zeroed", () => {
    expect(closeResultText({ base: "Position closed.", execPriceText: null, realized: null, decimals: 6, symbol: "USDC" })).toBe("Position closed.");
  });
});

describe("device ledger", () => {
  beforeEach(() => localStorage.clear());
  it("sums the measured results per wallet + market", () => {
    expect(getRealized("W", "S")).toBeNull();
    recordRealized("W", "S", -412_000n);
    recordRealized("W", "S", -300_000n);
    expect(getRealized("W", "S")).toBe(-712_000n);
    expect(getRealized("W", "OTHER")).toBeNull();
    expect(getRealized("W2", "S")).toBeNull();
  });
});

describe("pendingTag: a loss is never 'profit settling'", () => {
  it("recorded net loss with pending value reads 'claim pending'", () => {
    expect(pendingTag(21_000n, -1_020_000n, 0n)).toBe("claim pending");
  });
  it("recorded net gain reads 'profit settling'", () => {
    expect(pendingTag(21_000n, 500_000n, 0n)).toBe("profit settling");
  });
  it("nothing recorded but the chain crystallized a loss: 'claim pending'", () => {
    expect(pendingTag(21_000n, null, 200_000n)).toBe("claim pending");
  });
  it("nothing recorded and no loss: unchanged 'profit settling'; nothing pending: idle", () => {
    expect(pendingTag(21_000n, null, 0n)).toBe("profit settling");
    expect(pendingTag(0n, -5n, 0n)).toBe("idle collateral");
  });
});
