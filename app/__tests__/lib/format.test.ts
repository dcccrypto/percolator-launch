import { describe, it, expect } from "vitest";
import {
  formatTokenAmount,
  formatPriceE6,
  formatBps,
  LIQ_PRICE_UNLIQUIDATABLE,
  formatUsd,
  formatLiqPrice,
  shortenAddress,
  formatSlotAge,
  formatI128Amount,
  formatPnl,
  formatMarginPct,
  formatPercent,
  formatFundingRate,
} from "../../lib/format";

describe("formatTokenAmount", () => {
  it("returns '0' for null", () => {
    expect(formatTokenAmount(null)).toBe("0");
  });

  it("returns '0' for undefined", () => {
    expect(formatTokenAmount(undefined)).toBe("0");
  });

  it("formats zero", () => {
    expect(formatTokenAmount(0n)).toBe("0");
  });

  it("formats whole number without trailing zeros", () => {
    expect(formatTokenAmount(1_000_000n, 6)).toBe("1");
  });

  it("formats fractional amount", () => {
    expect(formatTokenAmount(1_500_000n, 6)).toBe("1.5");
  });

  it("formats small fractional amount", () => {
    expect(formatTokenAmount(100n, 6)).toBe("0.0001");
  });

  it("formats negative value", () => {
    expect(formatTokenAmount(-1_000_000n, 6)).toBe("-1");
  });

  it("formats negative fractional", () => {
    expect(formatTokenAmount(-1_234_567n, 6)).toBe("-1.234567");
  });

  it("respects custom decimals", () => {
    expect(formatTokenAmount(12345n, 2)).toBe("123.45");
  });

  it("formats large values", () => {
    expect(formatTokenAmount(1_000_000_000_000n, 6)).toBe("1000000");
  });

  it("strips trailing zeros from fractional part", () => {
    expect(formatTokenAmount(1_100_000n, 6)).toBe("1.1");
  });
});

describe("formatPriceE6", () => {
  it("delegates to formatTokenAmount with 6 decimals", () => {
    expect(formatPriceE6(1_000_000n)).toBe("1");
  });

  it("formats fractional price", () => {
    expect(formatPriceE6(42_690_000n)).toBe("42.69");
  });

  it("formats sub-dollar price", () => {
    expect(formatPriceE6(500_000n)).toBe("0.5");
  });
});

describe("formatBps", () => {
  it("formats bigint bps", () => {
    expect(formatBps(500n)).toBe("5.00%");
  });

  it("formats number bps", () => {
    expect(formatBps(100)).toBe("1.00%");
  });

  it("formats zero", () => {
    expect(formatBps(0)).toBe("0.00%");
  });

  it("formats fractional bps", () => {
    expect(formatBps(1)).toBe("0.01%");
  });

  it("formats large bps", () => {
    expect(formatBps(10000)).toBe("100.00%");
  });
});

describe("LIQ_PRICE_UNLIQUIDATABLE", () => {
  it("equals max u64", () => {
    expect(LIQ_PRICE_UNLIQUIDATABLE).toBe(18446744073709551615n);
  });
});

describe("formatUsd", () => {
  it("returns '$0.00' for null", () => {
    expect(formatUsd(null)).toBe("$0.00");
  });

  it("returns '$0.00' for undefined", () => {
    expect(formatUsd(undefined)).toBe("$0.00");
  });

  it("formats dollar amount", () => {
    const result = formatUsd(42_690_000n);
    expect(result).toContain("42.69");
    expect(result.startsWith("$")).toBe(true);
  });

  it("formats small amount", () => {
    const result = formatUsd(1n);
    expect(result).toContain("0.000001");
  });

  it("formats zero", () => {
    const result = formatUsd(0n);
    expect(result).toBe("$0.00");
  });

  it("returns '$—' for absurdly large prices (defense-in-depth)", () => {
    // The $13T bug: raw on-chain value exceeds MAX_ORACLE_PRICE
    expect(formatUsd(13_065_687_626_137_560_000n)).toBe("$—");
    // Just over the MAX_ORACLE_PRICE threshold
    expect(formatUsd(1_000_000_000_000_001n)).toBe("$—");
  });

  it("returns '$—' for negative prices", () => {
    expect(formatUsd(-1n)).toBe("$—");
  });

  it("formats prices at the MAX_ORACLE_PRICE boundary", () => {
    // Exactly at limit ($1B) — should still format normally
    const result = formatUsd(1_000_000_000_000_000n);
    expect(result).not.toBe("$—");
    expect(result).toContain("1,000,000,000");
  });
});

describe("formatLiqPrice", () => {
  it("returns '-' for null", () => {
    expect(formatLiqPrice(null)).toBe("-");
  });

  it("returns '-' for zero", () => {
    expect(formatLiqPrice(0n)).toBe("-");
  });

  it("returns '∞' for unliquidatable sentinel", () => {
    expect(formatLiqPrice(LIQ_PRICE_UNLIQUIDATABLE)).toBe("∞");
  });

  it("returns '∞' for values >= sentinel", () => {
    expect(formatLiqPrice(LIQ_PRICE_UNLIQUIDATABLE + 1n)).toBe("∞");
  });

  it("formats normal price via formatUsd", () => {
    const result = formatLiqPrice(100_000_000n);
    expect(result).toContain("100");
    expect(result.startsWith("$")).toBe(true);
  });
});

describe("shortenAddress", () => {
  const addr = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

  it("shortens with default chars=4", () => {
    expect(shortenAddress(addr)).toBe("7xKX...gAsU");
  });

  it("shortens with custom chars", () => {
    expect(shortenAddress(addr, 6)).toBe("7xKXtg...osgAsU");
  });

  it("handles very short address", () => {
    expect(shortenAddress("abcd", 2)).toBe("ab...cd");
  });
});

describe("formatSlotAge", () => {
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
    expect(formatSlotAge(100n, 200n)).toBe("0s");
  });

  it("returns '0s' when equal", () => {
    expect(formatSlotAge(100n, 100n)).toBe("0s");
  });

  it("formats seconds", () => {
    // 25 slots = 10 seconds at 2.5 slots/sec
    expect(formatSlotAge(125n, 100n)).toBe("10s");
  });

  it("formats minutes", () => {
    // 150 slots = 60 seconds = 1 minute
    expect(formatSlotAge(250n, 100n)).toBe("1.0m");
  });

  it("formats hours", () => {
    // 9000 slots = 3600 seconds = 1 hour
    expect(formatSlotAge(9100n, 100n)).toBe("1.0h");
  });
});

describe("formatI128Amount", () => {
  it("formats positive value", () => {
    expect(formatI128Amount(1_000_000n, 6)).toBe("1");
  });

  it("formats negative value", () => {
    expect(formatI128Amount(-5_000_000n, 6)).toBe("-5");
  });

  it("formats zero", () => {
    expect(formatI128Amount(0n, 6)).toBe("0");
  });

  it("truncates fractional part (integer division)", () => {
    expect(formatI128Amount(1_500_000n, 6)).toBe("1");
  });

  it("respects custom decimals", () => {
    expect(formatI128Amount(12345n, 2)).toBe("123");
  });
});

describe("formatPnl", () => {
  it("returns '0' for null", () => {
    expect(formatPnl(null)).toBe("0");
  });

  it("returns '0' for undefined", () => {
    expect(formatPnl(undefined)).toBe("0");
  });

  it("formats zero without sign", () => {
    expect(formatPnl(0n)).toBe("0");
  });

  it("formats positive PnL with + prefix", () => {
    expect(formatPnl(1_000_000n)).toBe("+1");
  });

  it("formats negative PnL with - prefix", () => {
    expect(formatPnl(-1_000_000n)).toBe("-1");
  });

  it("formats fractional PnL", () => {
    expect(formatPnl(1_234_567n)).toBe("+1.234567");
  });

  it("formats negative fractional PnL", () => {
    expect(formatPnl(-500_000n)).toBe("-0.5");
  });

  it("formats with custom decimals", () => {
    expect(formatPnl(150n, 2)).toBe("+1.5");
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

  it("formats 0 bps as 0.0%", () => {
    expect(formatMarginPct(0)).toBe("0.0%");
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
    expect(formatPercent(3.14159, 4)).toBe("+3.1416%");
  });

  it("formats with 0 decimals", () => {
    expect(formatPercent(42.7, 0)).toBe("+43%");
  });
});

describe("formatFundingRate", () => {
  it("formats zero rate", () => {
    expect(formatFundingRate(0n)).toBe("0.00%");
  });

  it("formats positive funding rate with + sign", () => {
    const result = formatFundingRate(1n);
    expect(result.startsWith("+")).toBe(true);
    expect(result.endsWith("%")).toBe(true);
  });

  it("formats negative funding rate with - sign", () => {
    const result = formatFundingRate(-1n);
    expect(result.startsWith("-")).toBe(true);
    expect(result.endsWith("%")).toBe(true);
  });

  it("calculates annualized rate correctly", () => {
    // 1 bps/slot * (2.5 * 60 * 60 * 24 * 365) slots/yr / 100 = 788,400% per year
    const slotsPerYear = 2.5 * 60 * 60 * 24 * 365;
    const expected = slotsPerYear / 100; // 788400
    const result = formatFundingRate(1n);
    expect(result).toBe(`+${expected.toFixed(2)}%`);
  });
});
