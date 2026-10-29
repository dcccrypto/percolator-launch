/**
 * #3534 (the value side). The risk entry already fixed liquidation price, cushion and health. These figures add the since-entry PnL
 * to `capital` and counted a settled loss twice on the opening device: the portfolio's total value and the close form's balance-after.
 * Worked example (the issue's): one long unit, fill $100, $20 capital; price $90 and a crank settles it. Capital is $10 and pnl 0, so the
 * account is worth $10. The cached-entry sum read $0.
 */
import { describe, it, expect } from "vitest";
import { ADL_ONE, type AssetAdlFactors } from "@/lib/v17-adl";
import type { AssetSettleState, RiskLegSnap } from "@/lib/risk-entry";
import { computePositionPnl, type PositionPnlInput } from "@/lib/position-pnl";
import { positionValuePnl } from "@/hooks/usePortfolio";

const E6 = 1_000_000n;
const UNIT = 1_000_000n;
const SETTLE: AssetSettleState = {
  effectivePriceE6: 90n * E6, kLong: -10n * ADL_ONE, kShort: 10n * ADL_ONE, fLong: 0n, fShort: 0n,
  kfEpochLong: 7n, kfEpochShort: 7n, bLong: 0n, bShort: 0n, epochLong: 0n, epochShort: 0n,
};
const FACTORS: AssetAdlFactors = { aLong: ADL_ONE, aShort: ADL_ONE, epochLong: 0n, epochShort: 0n, modeLong: 0, modeShort: 0, settle: SETTLE };
const LEG: RiskLegSnap = { side: 0, kSnap: SETTLE.kLong, fSnap: 0n, kfEpochSnap: 7n, epochSnap: 0n, bSnap: 0n, bEpochSnap: 0n, stale: false, bStale: false };
const input = (o: Partial<PositionPnlInput> = {}): PositionPnlInput => ({
  basisQ: UNIT, aBasis: ADL_ONE, epochSnap: 0n, adlFactors: FACTORS, markE6: 90n * E6, anchorMarkE6: 90n * E6,
  cachedEntryE6: 100n * E6, onChainPnl: 0n, initialMarginBps: 1000n, maintenanceMarginBps: 500n, capital: 10n * E6,
  riskLeg: LEG, activeLegCount: 1, ...o,
});

describe("riskUnrealizedPnl: the PnL that sits on top of capital", () => {
  it("settled loss: capital + riskUnrealizedPnl is the true $10, where capital + unrealizedPnl read $0", () => {
    const r = computePositionPnl(input());
    expect(r.unrealizedPnl).toBe(-10n * E6); // the honest since-entry figure, unchanged
    expect(r.riskUnrealizedPnl).toBe(0n);
    expect(10n * E6 + r.riskUnrealizedPnl!).toBe(10n * E6);
    expect(10n * E6 + r.unrealizedPnl!).toBe(0n); // the double count
  });
  it("part-settled (pnl -3 still in pnl, capital 13): the same $10", () => {
    const r = computePositionPnl(input({ onChainPnl: -3n * E6, capital: 13n * E6 }));
    expect(13n * E6 + r.riskUnrealizedPnl!).toBe(10n * E6);
  });
  it("a short: equity = capital + q x (mark - riskEntry)", () => {
    const r = computePositionPnl(input({ basisQ: -UNIT, riskLeg: { ...LEG, side: 1, kSnap: SETTLE.kShort }, onChainPnl: -2n * E6, capital: 12n * E6 }));
    expect(12n * E6 + r.riskUnrealizedPnl!).toBe(10n * E6);
  });
  it("CONTROL: nothing settled / not eligible (no risk leg) = the since-entry figure, unchanged", () => {
    const r = computePositionPnl(input({ riskLeg: null, capital: 20n * E6 }));
    expect(r.riskEntrySettled).toBe(false);
    expect(r.riskUnrealizedPnl).toBe(r.unrealizedPnl);
  });
  it("CONTROL: a K still pending falls back to the since-entry figure (errs toward too risky)", () => {
    const r = computePositionPnl(input({ riskLeg: { ...LEG, kSnap: SETTLE.kLong + ADL_ONE } }));
    expect(r.riskUnrealizedPnl).toBe(r.unrealizedPnl);
  });
  it("flat is 0, unknown ADL state is null", () => {
    expect(computePositionPnl(input({ basisQ: 0n })).riskUnrealizedPnl).toBe(0n);
    expect(computePositionPnl(input({ adlFactors: null })).riskUnrealizedPnl).toBeNull();
  });
  it("positionValuePnl prefers the risk figure and falls back to the since-entry one", () => {
    expect(positionValuePnl({ unrealizedPnl: -10n, riskUnrealizedPnl: 0n })).toBe(0n);
    expect(positionValuePnl({ unrealizedPnl: -10n })).toBe(-10n);
  });
});
