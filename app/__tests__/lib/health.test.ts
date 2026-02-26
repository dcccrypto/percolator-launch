import { describe, it, expect } from "vitest";
import { computeMarketHealth, computeMarketHealthFromStats, sanitizeOnChainValue, isSentinelValue, sanitizeAccountCount } from "../../lib/health";
import type { HealthLevel } from "../../lib/health";

/** Stub EngineState with only the fields computeMarketHealth uses */
function makeEngine(overrides: {
  totalOpenInterest?: bigint;
  cTot?: bigint;
  insuranceFundBalance?: bigint;
}) {
  return {
    totalOpenInterest: overrides.totalOpenInterest ?? 0n,
    cTot: overrides.cTot ?? 1_000_000n,
    insuranceFund: { balance: overrides.insuranceFundBalance ?? 100_000n },
  } as any;
}

describe("sanitizeOnChainValue", () => {
  it("returns 0n for u64::MAX sentinel", () => {
    expect(sanitizeOnChainValue(18446744073709551615n)).toBe(0n);
  });

  it("returns 0n for values near u64::MAX", () => {
    expect(sanitizeOnChainValue(18100000000000000000n)).toBe(0n);
  });

  it("returns the value for normal bigints", () => {
    expect(sanitizeOnChainValue(1_000_000n)).toBe(1_000_000n);
  });

  it("returns 0n for negative values", () => {
    expect(sanitizeOnChainValue(-100n)).toBe(0n);
  });

  it("returns 0n for zero", () => {
    expect(sanitizeOnChainValue(0n)).toBe(0n);
  });
});

describe("isSentinelValue", () => {
  it("detects u64::MAX as sentinel", () => {
    expect(isSentinelValue(18446744073709551615n)).toBe(true);
  });

  it("does not flag normal values", () => {
    expect(isSentinelValue(1_000_000_000n)).toBe(false);
  });
});

describe("computeMarketHealth", () => {
  // ── Empty states ──
  it('returns "empty" when all values are zero', () => {
    const result = computeMarketHealth(makeEngine({ cTot: 0n, insuranceFundBalance: 0n, totalOpenInterest: 0n }));
    expect(result.level).toBe("empty");
    expect(result.label).toBe("Empty");
    expect(result.insuranceRatio).toBe(0);
    expect(result.capitalRatio).toBe(0);
  });

  // ── Sentinel values (u64::MAX) treated as zero ──
  it('returns "empty" when insurance is u64::MAX sentinel and capital/OI are zero', () => {
    const result = computeMarketHealth(makeEngine({
      cTot: 0n,
      insuranceFundBalance: 18446744073709551615n, // u64::MAX
      totalOpenInterest: 0n,
    }));
    expect(result.level).toBe("empty");
  });

  it('returns "warning" when insurance is u64::MAX but OI exists', () => {
    const result = computeMarketHealth(makeEngine({
      cTot: 1_000_000n,
      insuranceFundBalance: 18446744073709551615n, // u64::MAX → sanitized to 0
      totalOpenInterest: 100_000n,
    }));
    // Capital ratio = 10 (healthy), but insurance = 0 → low insurance
    // insuranceRatio 0 < 0.02 → warning
    expect(result.level).toBe("warning");
  });

  // ── No open interest ──
  it('returns "healthy" with Infinity ratios when OI is zero but capital/insurance exist', () => {
    const result = computeMarketHealth(
      makeEngine({ cTot: 1_000_000n, insuranceFundBalance: 100_000n, totalOpenInterest: 0n })
    );
    expect(result.level).toBe("healthy");
    expect(result.insuranceRatio).toBe(Infinity);
    expect(result.capitalRatio).toBe(Infinity);
  });

  // ── OI but no capital or insurance ──
  it('returns "warning" when OI exists but capital and insurance are zero', () => {
    const result = computeMarketHealth(makeEngine({
      totalOpenInterest: 1_000_000n,
      cTot: 0n,
      insuranceFundBalance: 0n,
    }));
    expect(result.level).toBe("warning");
    expect(result.label).toBe("Low Liquidity");
  });

  // ── Healthy market ──
  it('returns "healthy" when both ratios are above thresholds', () => {
    const result = computeMarketHealth(
      makeEngine({
        totalOpenInterest: 1_000_000n,
        cTot: 1_000_000n,
        insuranceFundBalance: 100_000n,
      })
    );
    expect(result.level).toBe("healthy");
    expect(result.label).toBe("Healthy");
    expect(result.insuranceRatio).toBeCloseTo(0.1, 5);
    expect(result.capitalRatio).toBeCloseTo(1.0, 5);
  });

  // ── Caution market ──
  it('returns "caution" when insurance ratio is between 2% and 5%', () => {
    const result = computeMarketHealth(
      makeEngine({
        totalOpenInterest: 1_000_000n,
        cTot: 1_000_000n,
        insuranceFundBalance: 30_000n,
      })
    );
    expect(result.level).toBe("caution");
    expect(result.label).toBe("Caution");
  });

  it('returns "caution" when capital ratio is between 50% and 80%', () => {
    const result = computeMarketHealth(
      makeEngine({
        totalOpenInterest: 1_000_000n,
        cTot: 600_000n,
        insuranceFundBalance: 100_000n,
      })
    );
    expect(result.level).toBe("caution");
  });

  // ── Warning market ──
  it('returns "warning" when insurance ratio < 2%', () => {
    const result = computeMarketHealth(
      makeEngine({
        totalOpenInterest: 1_000_000n,
        cTot: 1_000_000n,
        insuranceFundBalance: 10_000n,
      })
    );
    expect(result.level).toBe("warning");
    expect(result.label).toBe("Low Liquidity");
  });

  it('returns "warning" when capital ratio < 50%', () => {
    const result = computeMarketHealth(
      makeEngine({
        totalOpenInterest: 1_000_000n,
        cTot: 400_000n,
        insuranceFundBalance: 100_000n,
      })
    );
    expect(result.level).toBe("warning");
  });

  // ── Edge cases ──
  it("returns correct ratios for large numbers", () => {
    const result = computeMarketHealth(
      makeEngine({
        totalOpenInterest: 1_000_000_000_000n,
        cTot: 500_000_000_000n,
        insuranceFundBalance: 50_000_000_000n,
      })
    );
    expect(result.capitalRatio).toBeCloseTo(0.5, 3);
    expect(result.insuranceRatio).toBeCloseTo(0.05, 3);
  });

  it('returns "warning" when insurance=0 with high capital and OI (low insurance ratio)', () => {
    const result = computeMarketHealth(
      makeEngine({
        totalOpenInterest: 100n,
        cTot: 1_000_000n,
        insuranceFundBalance: 0n,
      })
    );
    // insuranceRatio = 0 < 0.02 → warning
    expect(result.level).toBe("warning");
  });
});

describe("computeMarketHealthFromStats", () => {
  it('returns "empty" when all stats are zero', () => {
    const result = computeMarketHealthFromStats({
      total_open_interest: 0,
      insurance_balance: 0,
      c_tot: 0,
    });
    expect(result.level).toBe("empty");
  });

  it('returns "healthy" when ratios are good', () => {
    const result = computeMarketHealthFromStats({
      total_open_interest: 1_000_000,
      insurance_balance: 100_000,
      c_tot: 1_000_000,
    });
    expect(result.level).toBe("healthy");
  });

  it('returns "empty" when insurance is u64::MAX sentinel (numeric)', () => {
    const result = computeMarketHealthFromStats({
      total_open_interest: 0,
      insurance_balance: 1.8446744073709552e19, // JS number of u64::MAX
      c_tot: 0,
    });
    expect(result.level).toBe("empty");
  });

  it('returns "healthy" when OI is zero but capital exists', () => {
    const result = computeMarketHealthFromStats({
      total_open_interest: 0,
      insurance_balance: 100_000,
      c_tot: 500_000,
    });
    expect(result.level).toBe("healthy");
  });

  it('uses open_interest_long + short as fallback for total_open_interest', () => {
    const result = computeMarketHealthFromStats({
      open_interest_long: 500_000,
      open_interest_short: 500_000,
      insurance_balance: 100_000,
      c_tot: 1_000_000,
    });
    expect(result.level).toBe("healthy");
  });

  it('uses vault_balance as fallback for c_tot', () => {
    const result = computeMarketHealthFromStats({
      total_open_interest: 1_000_000,
      insurance_balance: 100_000,
      vault_balance: 1_000_000,
    });
    expect(result.level).toBe("healthy");
  });

  it('returns "warning" when insurance is very low', () => {
    const result = computeMarketHealthFromStats({
      total_open_interest: 1_000_000,
      insurance_balance: 10_000, // 1% < 2% threshold
      c_tot: 1_000_000,
    });
    expect(result.level).toBe("warning");
  });

  it('returns "caution" when capital ratio is between 50-80%', () => {
    const result = computeMarketHealthFromStats({
      total_open_interest: 1_000_000,
      insurance_balance: 100_000,
      c_tot: 600_000, // 60% → caution
    });
    expect(result.level).toBe("caution");
  });
});

describe("sanitizeAccountCount", () => {
  it("returns 0 for values exceeding max slab capacity (4096)", () => {
    expect(sanitizeAccountCount(29807)).toBe(0);
    expect(sanitizeAccountCount(13837)).toBe(0);
    expect(sanitizeAccountCount(65535)).toBe(0); // u16::MAX
  });

  it("returns the value for counts within valid range", () => {
    expect(sanitizeAccountCount(0)).toBe(0);
    expect(sanitizeAccountCount(1)).toBe(1);
    expect(sanitizeAccountCount(42)).toBe(42);
    expect(sanitizeAccountCount(256)).toBe(256);
    expect(sanitizeAccountCount(4096)).toBe(4096);
  });

  it("returns 0 for negative values", () => {
    expect(sanitizeAccountCount(-1)).toBe(0);
    expect(sanitizeAccountCount(-100)).toBe(0);
  });

  it("uses custom maxAccounts cap when provided", () => {
    // For a 256-slot slab, 300 accounts is invalid
    expect(sanitizeAccountCount(300, 256)).toBe(0);
    // But 200 is fine
    expect(sanitizeAccountCount(200, 256)).toBe(200);
    // Exactly at the cap is valid
    expect(sanitizeAccountCount(256, 256)).toBe(256);
  });

  it("falls back to default cap when maxAccounts is 0 or negative", () => {
    expect(sanitizeAccountCount(5000, 0)).toBe(0); // default 4096 applies
    expect(sanitizeAccountCount(5000, -1)).toBe(0);
    expect(sanitizeAccountCount(3000, 0)).toBe(3000); // under 4096
  });
});
