import { describe, it, expect } from "vitest";
import { formatUsdAmount } from "@/lib/format";

describe("formatUsdAmount", () => {
  it("two decimals from a cent up, signed", () => {
    expect(formatUsdAmount(5, "+")).toBe("+$5.00");
    expect(formatUsdAmount(-0.5, "-")).toBe("-$0.50");
    expect(formatUsdAmount(0.01, "+")).toBe("+$0.01");
  });
  it("under a cent keeps two significant digits instead of reading $0.00", () => {
    expect(formatUsdAmount(0.003, "+")).toBe("+$0.0030");
    expect(formatUsdAmount(0.00042, "-")).toBe("-$0.00042");
  });
  it("floors a vanishing amount and keeps an exact zero as $0.00", () => {
    expect(formatUsdAmount(0.00001, "+")).toBe("+<$0.0001");
    expect(formatUsdAmount(0)).toBe("$0.00");
    expect(formatUsdAmount(Number.NaN)).toBe("—");
  });
});
