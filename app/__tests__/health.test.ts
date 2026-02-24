import { describe, it, expect } from "vitest";
import { computeMarketHealth } from "../lib/health";
import type { EngineState } from "@percolator/sdk";

function makeEngine(overrides: Partial<EngineState> = {}): EngineState {
  return {
    vault: 0n, insuranceFund: { balance: 0n, feeRevenue: 0n },
    currentSlot: 0n, fundingIndexQpbE6: 0n, lastFundingSlot: 0n,
    fundingRateBpsPerSlotLast: 0n, lastCrankSlot: 0n, maxCrankStalenessSlots: 0n,
    totalOpenInterest: 0n, cTot: 0n, pnlPosTot: 0n,
    liqCursor: 0, gcCursor: 0, lastSweepStartSlot: 0n, lastSweepCompleteSlot: 0n,
    crankCursor: 0, sweepStartIdx: 0, lifetimeLiquidations: 0n, lifetimeForceCloses: 0n,
    netLpPos: 0n, lpSumAbs: 0n, lpMaxAbs: 0n, lpMaxAbsSweep: 0n,
    numUsedAccounts: 0, nextAccountId: 0n,
    ...overrides,
  };
}

describe("computeMarketHealth", () => {
  it("returns empty when capital and insurance are 0", () => {
    const h = computeMarketHealth(makeEngine());
    expect(h.level).toBe("empty");
  });

  it("returns healthy when OI is 0 but capital exists", () => {
    const h = computeMarketHealth(makeEngine({
      cTot: 1000000n,
      insuranceFund: { balance: 100000n, feeRevenue: 0n },
    }));
    expect(h.level).toBe("healthy");
    expect(h.insuranceRatio).toBe(Infinity);
  });

  it("returns warning when insurance ratio < 2%", () => {
    const h = computeMarketHealth(makeEngine({
      totalOpenInterest: 1000000n,
      cTot: 1000000n,
      insuranceFund: { balance: 10000n, feeRevenue: 0n }, // 1%
    }));
    expect(h.level).toBe("warning");
  });

  it("returns caution when insurance ratio < 5%", () => {
    const h = computeMarketHealth(makeEngine({
      totalOpenInterest: 1000000n,
      cTot: 1000000n,
      insuranceFund: { balance: 30000n, feeRevenue: 0n }, // 3%
    }));
    expect(h.level).toBe("caution");
  });

  it("returns healthy when ratios are good", () => {
    const h = computeMarketHealth(makeEngine({
      totalOpenInterest: 1000000n,
      cTot: 1000000n,
      insuranceFund: { balance: 100000n, feeRevenue: 0n }, // 10%
    }));
    expect(h.level).toBe("healthy");
  });

  it("returns warning when capital ratio < 0.5", () => {
    const h = computeMarketHealth(makeEngine({
      totalOpenInterest: 1000000n,
      cTot: 400000n, // 0.4
      insuranceFund: { balance: 100000n, feeRevenue: 0n },
    }));
    expect(h.level).toBe("warning");
  });
});
