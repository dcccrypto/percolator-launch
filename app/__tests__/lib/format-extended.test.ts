import { describe, it, expect } from "vitest";
import {
  formatTokenAmount,
  formatPriceE6,
  formatBps,
  formatUsd,
  formatLiqPrice,
  LIQ_PRICE_UNLIQUIDATABLE,
  shortenAddress,
  formatSlotAge,
  formatI128Amount,
  formatPnl,
  formatMarginPct,
  formatPercent,
  formatFundingRate,
} from "../../lib/format";

describe("formatTokenAmount (extended)", () => {
  it("handles null", () => expect(formatTokenAmount(null)).toBe("0"));
  it("handles undefined", () => expect(formatTokenAmount(undefined)).toBe("0"));
  it("handles negative values", () => expect(formatTokenAmount(-1_500_000n)).toBe("-1.5"));
  it("handles large values", () => expect(formatTokenAmount(1_000_000_000_000n)).toBe("1000000"));
  it("handles 9 decimals", () => expect(formatTokenAmount(1_500_000_000n, 9)).toBe("1.5"));
  it("handles sub-unit with 9 decimals", () => expect(formatTokenAmount(1n, 9)).toBe("0.000000001"));
});

describe("formatPriceE6", () => {
  it("delegates to formatTokenAmount with 6 decimals", () => {
    expect(formatPriceE6(1_000_000n)).toBe("1");
  });
  it("formats fractional prices", () => {
    expect(formatPriceE6(1_500_000n)).toBe("1.5");
  });
  it("formats sub-dollar prices", () => {
    expect(formatPriceE6(500n)).toBe("0.0005");
  });
});

describe("formatUsd (extended)", () => {
  it("returns $0.00 for null", () => expect(formatUsd(null)).toBe("$0.00"));
  it("returns $0.00 for undefined", () => expect(formatUsd(undefined)).toBe("$0.00"));
  it("formats zero as dash (PERC-297: 0 = oracle unavailable)", () => expect(formatUsd(0n)).toBe("$—"));
  it("formats large amounts", () => {
    const result = formatUsd(1_000_000_000_000n); // $1,000,000
    expect(result).toContain("$");
    expect(result).toContain("1");
  });
});

describe("formatLiqPrice", () => {
  it("returns '-' for null", () => expect(formatLiqPrice(null)).toBe("-"));
  it("returns '-' for undefined", () => expect(formatLiqPrice(undefined)).toBe("-"));
  it("returns '-' for zero", () => expect(formatLiqPrice(0n)).toBe("-"));
  it("returns '∞' for unliquidatable sentinel", () => {
    expect(formatLiqPrice(LIQ_PRICE_UNLIQUIDATABLE)).toBe("∞");
  });
  it("returns '∞' for values >= sentinel", () => {
    expect(formatLiqPrice(LIQ_PRICE_UNLIQUIDATABLE + 1n)).toBe("∞");
  });
  it("delegates to formatUsd for normal values", () => {
    const result = formatLiqPrice(1_000_000n);
    expect(result).toContain("$");
    expect(result).toContain("1");
  });
});

describe("LIQ_PRICE_UNLIQUIDATABLE", () => {
  it("equals max u64", () => {
    expect(LIQ_PRICE_UNLIQUIDATABLE).toBe(18446744073709551615n);
    expect(LIQ_PRICE_UNLIQUIDATABLE).toBe(2n ** 64n - 1n);
  });
});

describe("shortenAddress (extended)", () => {
  it("shortens with default chars=4", () => {
    expect(shortenAddress("1234567890abcdef")).toBe("1234...cdef");
  });
  it("shortens with custom chars", () => {
    expect(shortenAddress("1234567890abcdef", 6)).toBe("123456...abcdef");
  });
  it("handles short addresses", () => {
    expect(shortenAddress("abcd", 4)).toBe("abcd...abcd");
  });
});

describe("formatSlotAge (extended)", () => {
  it("returns '—' for null currentSlot", () => {
    expect(formatSlotAge(null, 100n)).toBe("—");
  });
  it("returns '—' for null targetSlot", () => {
    expect(formatSlotAge(100n, null)).toBe("—");
  });
  it("returns '—' for undefined slots", () => {
    expect(formatSlotAge(undefined, undefined)).toBe("—");
  });
  it("returns '0s' when target > current", () => {
    expect(formatSlotAge(50n, 100n)).toBe("0s");
  });
  it("formats minutes", () => {
    // 500 slots / 2.5 = 200 seconds = 3.33 min
    expect(formatSlotAge(600n, 100n)).toBe("3.3m");
  });
  it("formats hours", () => {
    // 36000 slots / 2.5 = 14400 seconds = 4 hours
    expect(formatSlotAge(36100n, 100n)).toBe("4.0h");
  });
});

describe("formatI128Amount", () => {
  it("formats positive value", () => {
    expect(formatI128Amount(1_500_000n)).toBe("1");
  });
  it("formats negative value", () => {
    expect(formatI128Amount(-2_000_000n)).toBe("-2");
  });
  it("formats zero", () => {
    expect(formatI128Amount(0n)).toBe("0");
  });
  it("respects custom decimals", () => {
    expect(formatI128Amount(1_500_000_000n, 9)).toBe("1");
  });
});

describe("formatPnl (extended)", () => {
  it("returns '0' for null", () => expect(formatPnl(null)).toBe("0"));
  it("returns '0' for undefined", () => expect(formatPnl(undefined)).toBe("0"));
  it("formats large positive PnL", () => {
    expect(formatPnl(100_500_000n)).toBe("+100.5");
  });
  it("formats large negative PnL", () => {
    expect(formatPnl(-100_500_000n)).toBe("-100.5");
  });
  it("formats with custom decimals", () => {
    expect(formatPnl(1_500_000_000n, 9)).toBe("+1.5");
  });
});

describe("formatMarginPct", () => {
  it("formats 100 bps as 1.0%", () => {
    expect(formatMarginPct(100)).toBe("1.0%");
  });
  it("formats 500 bps as 5.0%", () => {
    expect(formatMarginPct(500)).toBe("5.0%");
  });
  it("formats 10000 bps as 100.0%", () => {
    expect(formatMarginPct(10000)).toBe("100.0%");
  });
  it("formats 50 bps as 0.5%", () => {
    expect(formatMarginPct(50)).toBe("0.5%");
  });
});

describe("formatPercent", () => {
  it("formats positive percentage with + sign", () => {
    expect(formatPercent(12.34)).toBe("+12.34%");
  });
  it("formats negative percentage with - sign", () => {
    expect(formatPercent(-5.67)).toBe("-5.67%");
  });
  it("formats zero without sign", () => {
    expect(formatPercent(0)).toBe("0.00%");
  });
  it("respects custom decimal places", () => {
    expect(formatPercent(12.3456, 1)).toBe("+12.3%");
    expect(formatPercent(12.3456, 4)).toBe("+12.3456%");
  });
});

describe("formatFundingRate", () => {
  it("formats zero rate", () => {
    expect(formatFundingRate(0n)).toBe("0.00%");
  });
  it("formats positive funding rate", () => {
    const result = formatFundingRate(1n); // 1 bps/slot
    expect(result).toMatch(/^\+/);
    expect(result).toMatch(/%$/);
  });
  it("formats negative funding rate", () => {
    const result = formatFundingRate(-1n);
    expect(result).toMatch(/^-/);
    expect(result).toMatch(/%$/);
  });
  it("calculates annualized rate correctly", () => {
    // 1 bps/slot × (2.5 * 60 * 60 * 24 * 365) slots/yr / 100
    const slotsPerYear = 2.5 * 60 * 60 * 24 * 365;
    const expected = slotsPerYear / 100; // 1 bps/slot annualized to %
    const result = formatFundingRate(1n);
    const numericPart = parseFloat(result.replace("+", "").replace("%", ""));
    expect(numericPart).toBeCloseTo(expected, 0);
  });
});
