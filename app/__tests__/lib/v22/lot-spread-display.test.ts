import { describe, it, expect } from "vitest";
import { formatLotSpread } from "@/lib/v22/lot";
import { formatSpreadUsd } from "@/lib/format";

// lotExp = 3: one lot = 1000 tokens, so per-token = per-lot / 1000.
describe("formatLotSpread (lot branch)", () => {
  it("zero diff", () => {
    expect(formatLotSpread(5_000_000n, 5_000_000n, 0, 3)).toBe("$0.00 (0.00%)");
  });
  it("positive diff", () => {
    const s = formatLotSpread(5_100_000n, 5_000_000n, 200, 3);
    expect(s.startsWith("+")).toBe(true);
    expect(s.endsWith("(+2.00%)")).toBe(true);
  });
  it("negative diff", () => {
    const s = formatLotSpread(4_900_000n, 5_000_000n, -200, 3);
    expect(s.startsWith("−")).toBe(true);
    expect(s.endsWith("(−2.00%)")).toBe(true);
  });
  it("sub-micro negative diff keeps one consistent sign (per-token spread truncates to 0n)", () => {
    // diff = -100 per lot e6 => -0.1 e6 per token, which truncates to 0n
    const s = formatLotSpread(4_999_900n, 5_000_000n, -5, 3);
    expect(s.startsWith("−")).toBe(true);
    expect(s).toContain("(−0.05%)");
    expect(s).not.toContain("+0.05%");
  });
  it("sub-micro positive diff", () => {
    const s = formatLotSpread(5_000_100n, 5_000_000n, 5, 3);
    expect(s.startsWith("+")).toBe(true);
    expect(s).toContain("(+0.05%)");
  });
});

describe("formatLotSpread at lotExp 0 is the legacy output", () => {
  const legacy = (m: bigint, i: bigint, bps: number) => {
    const abs = m - i;
    const sign = abs >= 0n ? "+" : "−";
    const pct = bps === 0 ? "0.00%" : `${sign}${Math.abs(bps / 100).toFixed(2)}%`;
    return `${formatSpreadUsd(abs)} (${pct})`;
  };
  it.each([
    [150_000_000n, 150_000_000n, 0],
    [150_060_000n, 150_000_000n, 4],
    [149_940_000n, 150_000_000n, -4],
    [150_000_001n, 150_000_000n, 0],
    [149_999_999n, 150_000_000n, 0],
  ])("%s vs %s", (m, i, bps) => {
    expect(formatLotSpread(m, i, bps, 0)).toBe(legacy(m, i, bps));
  });
});
