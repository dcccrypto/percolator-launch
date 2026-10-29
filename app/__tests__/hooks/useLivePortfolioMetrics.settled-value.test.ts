/**
 * #3534: the hero "Portfolio Value" is deposits + pending profit + the open positions' PnL. On the device a position was opened from the
 * PnL is measured from the cached fill price, while `capital` has already paid a loss a settle moved out of it, so the loss was in both
 * terms. One long unit, fill $100, price $90, settled: capital $10, pnl 0. The account is worth $10; the sum read $0.
 */
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useLivePortfolioMetrics } from "@/hooks/useLivePortfolioMetrics";
import type { PortfolioPosition } from "@/hooks/usePortfolio";
import { ADL_ONE, type AssetAdlFactors } from "@/lib/v17-adl";
import type { AssetSettleState, RiskLegSnap } from "@/lib/risk-entry";

const E6 = 1_000_000n;
const SETTLE: AssetSettleState = {
  effectivePriceE6: 90n * E6, kLong: -10n * ADL_ONE, kShort: 10n * ADL_ONE, fLong: 0n, fShort: 0n,
  kfEpochLong: 7n, kfEpochShort: 7n, bLong: 0n, bShort: 0n, epochLong: 0n, epochShort: 0n,
};
const FACTORS: AssetAdlFactors = { aLong: ADL_ONE, aShort: ADL_ONE, epochLong: 0n, epochShort: 0n, modeLong: 0, modeShort: 0, settle: SETTLE };
const LEG: RiskLegSnap = { side: 0, kSnap: SETTLE.kLong, fSnap: 0n, kfEpochSnap: 7n, epochSnap: 0n, bSnap: 0n, bEpochSnap: 0n, stale: false, bStale: false };

const position = (riskLeg: RiskLegSnap | null): PortfolioPosition =>
  ({
    slabAddress: "SlabSettledValue1111111111111111111111111111",
    account: { positionSize: 1_000_000n, adlABasis: ADL_ONE, adlEpochSnap: 0n, pnl: 0n, capital: 10n * E6, riskLeg, activeLegCount: 1 },
    adlFactors: FACTORS,
    adlApplicable: true,
    effectiveEntryPrice: 100n * E6,
    entryPriceSource: "cache",
    initialMarginBps: 1000n,
    maintenanceMarginBps: 500n,
    oraclePriceE6: 90n * E6,
    unrealizedPnl: -10n * E6,
  }) as unknown as PortfolioPosition;

describe("useLivePortfolioMetrics totalValue on a settled loss (#3534)", () => {
  it("a settled leg is worth its capital: $10, not $0; the PnL since entry still reads -$10", () => {
    const { result } = renderHook(() => useLivePortfolioMetrics([position(LEG)], 10n * E6));
    expect(result.current.totalValue).toBe(10n * E6);
    expect(result.current.totalUnrealizedPnl).toBe(-10n * E6);
  });
  it("CONTROL: with nothing settled (no risk leg) value = deposits + the since-entry PnL, as before", () => {
    const { result } = renderHook(() => useLivePortfolioMetrics([position(null)], 20n * E6));
    expect(result.current.totalValue).toBe(10n * E6);
    expect(result.current.totalUnrealizedPnl).toBe(-10n * E6);
  });
});
