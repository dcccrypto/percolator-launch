import { describe, it, expect } from "vitest";
import { formatTokenAmount, formatBps, formatUsd, formatPnl, formatSlotAge, shortenAddress } from "../lib/format";

describe("formatTokenAmount", () => {
  it("formats zero", () => expect(formatTokenAmount(0n)).toBe("0"));
  it("formats whole number", () => expect(formatTokenAmount(1000000n)).toBe("1"));
  it("formats with decimals", () => expect(formatTokenAmount(1500000n)).toBe("1.5"));
  it("formats sub-unit", () => expect(formatTokenAmount(500n)).toBe("0.0005"));
  it("respects custom decimals", () => expect(formatTokenAmount(100n, 2)).toBe("1"));
});

describe("formatBps", () => {
  it("formats 100 bps as 1.00%", () => expect(formatBps(100)).toBe("1.00%"));
  it("formats 10000 bps as 100.00%", () => expect(formatBps(10000)).toBe("100.00%"));
  it("formats bigint", () => expect(formatBps(50n)).toBe("0.50%"));
});

describe("formatUsd", () => {
  it("formats $1", () => expect(formatUsd(1000000n)).toContain("1"));
  it("formats $0.50", () => expect(formatUsd(500000n)).toContain("0.5"));
});

describe("formatPnl", () => {
  it("formats positive PnL with +", () => expect(formatPnl(1500000n)).toBe("+1.5"));
  it("formats negative PnL with -", () => expect(formatPnl(-2000000n)).toBe("-2"));
  it("formats zero", () => expect(formatPnl(0n)).toBe("0"));
});

describe("formatSlotAge", () => {
  it("formats seconds", () => expect(formatSlotAge(100n, 90n)).toBe("4s"));
  it("formats zero for same slot", () => expect(formatSlotAge(100n, 100n)).toBe("0s"));
});

describe("shortenAddress", () => {
  it("shortens", () => expect(shortenAddress("abcdefghijklmnop")).toBe("abcd...mnop"));
});
