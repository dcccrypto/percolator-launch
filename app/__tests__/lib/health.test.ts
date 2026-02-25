import { describe, it, expect } from "vitest";
import { computeMarketHealth } from "../../lib/health";
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

describe("computeMarketHealth", () => {
  // ── Empty states ──
  it('returns "empty" when capital is zero', () => {
    const result = computeMarketHealth(makeEngine({ cTot: 0n }));
    expect(result.level).toBe("empty");
    expect(result.label).toBe("Empty");
    expect(result.insuranceRatio).toBe(0);
    expect(result.capitalRatio).toBe(0);
  });

  it('returns "empty" when insurance is zero', () => {
    const result = computeMarketHealth(makeEngine({ insuranceFundBalance: 0n }));
    expect(result.level).toBe("empty");
  });

  it('returns "empty" when both capital and insurance are zero', () => {
    const result = computeMarketHealth(makeEngine({ cTot: 0n, insuranceFundBalance: 0n }));
    expect(result.level).toBe("empty");
  });

  // ── No open interest ──
  it('returns "healthy" with Infinity ratios when OI is zero', () => {
    const result = computeMarketHealth(
      makeEngine({ cTot: 1_000_000n, insuranceFundBalance: 100_000n, totalOpenInterest: 0n })
    );
    expect(result.level).toBe("healthy");
    expect(result.insuranceRatio).toBe(Infinity);
    expect(result.capitalRatio).toBe(Infinity);
  });

  // ── Healthy market ──
  it('returns "healthy" when both ratios are above thresholds', () => {
    // insurance >= 5% of OI, capital >= 80% of OI
    const result = computeMarketHealth(
      makeEngine({
        totalOpenInterest: 1_000_000n,
        cTot: 1_000_000n,        // 100% capital ratio
        insuranceFundBalance: 100_000n, // 10% insurance ratio
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
        cTot: 1_000_000n,        // 100% capital ratio → healthy
        insuranceFundBalance: 30_000n,  // 3% insurance ratio → caution
      })
    );
    expect(result.level).toBe("caution");
    expect(result.label).toBe("Caution");
  });

  it('returns "caution" when capital ratio is between 50% and 80%', () => {
    const result = computeMarketHealth(
      makeEngine({
        totalOpenInterest: 1_000_000n,
        cTot: 600_000n,           // 60% capital ratio → caution
        insuranceFundBalance: 100_000n, // 10% insurance ratio → healthy
      })
    );
    expect(result.level).toBe("caution");
  });

  // ── Warning market ──
  it('returns "warning" when insurance ratio < 2%', () => {
    const result = computeMarketHealth(
      makeEngine({
        totalOpenInterest: 1_000_000n,
        cTot: 1_000_000n,        // 100% capital → healthy
        insuranceFundBalance: 10_000n,  // 1% insurance → warning
      })
    );
    expect(result.level).toBe("warning");
    expect(result.label).toBe("Low Liquidity");
  });

  it('returns "warning" when capital ratio < 50%', () => {
    const result = computeMarketHealth(
      makeEngine({
        totalOpenInterest: 1_000_000n,
        cTot: 400_000n,           // 40% capital → warning
        insuranceFundBalance: 100_000n, // 10% insurance → healthy
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

  it('considers insurance=0 as "empty" even with high capital', () => {
    const result = computeMarketHealth(
      makeEngine({
        totalOpenInterest: 100n,
        cTot: 1_000_000n,
        insuranceFundBalance: 0n,
      })
    );
    expect(result.level).toBe("empty");
  });
});
