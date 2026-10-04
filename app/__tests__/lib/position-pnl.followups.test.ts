/**
 * #3077 follow-ups (reviewer notes on #3084): liquidation price and ROE on
 * EFFECTIVE size, invalid / reset legs are unknown, and the v17 on-chain mark is
 * never inverted twice. Every item has a negative control.
 */
import { describe, expect, it } from "vitest";
import { computePositionPnl, onChainMarkE6, unknownPnlCaveat, type PositionPnlInput } from "@/lib/position-pnl";
import { computeEngineLiqPrice } from "@/lib/liquidation-risk";
import { effectiveExposureQ, type AssetAdlFactors } from "@/lib/v17-adl";

const ONE = 1_000_000_000_000_000n;
const MIN_A_SIDE = ONE / 10n;
const sides = (over: Partial<AssetAdlFactors> = {}): AssetAdlFactors => ({
  aLong: ONE / 2n,
  aShort: ONE,
  epochLong: 0n,
  epochShort: 0n,
  modeLong: 0,
  modeShort: 0,
  ...over,
});
const base: PositionPnlInput = {
  basisQ: 80_000_000n, // raw; 40 effective at a_long = 50%
  aBasis: ONE,
  epochSnap: 0n,
  adlFactors: sides(),
  markE6: 100_000_000n,
  cachedEntryE6: 99_875_000n,
  onChainPnl: 5_000_000n,
  initialMarginBps: 1000n,
  maintenanceMarginBps: 500n,
  capital: 1_000_000_000n,
};

describe("1. liquidation price on EFFECTIVE size", () => {
  it("is computed over effective_abs_q, not raw basis", () => {
    const r = computePositionPnl(base);
    const onEffective = computeEngineLiqPrice(99_875_000n, base.capital, 40_000_000n, 500n);
    const onRaw = computeEngineLiqPrice(99_875_000n, base.capital, 80_000_000n, 500n);
    expect(r.liquidationPriceE6).toBe(onEffective);
    // NEGATIVE CONTROL: the raw-size number (what the surfaces used to show) is a different price.
    expect(onRaw).not.toBe(onEffective);
    expect(r.liquidationPriceE6).not.toBe(onRaw);
  });

  it("is null (never from raw basis) when the ADL state is unknown", () => {
    expect(computePositionPnl({ ...base, adlFactors: null }).liquidationPriceE6).toBeNull();
    // control: known factors give a price
    expect(computePositionPnl(base).liquidationPriceE6).not.toBeNull();
  });
});

describe("4. ROE on EFFECTIVE initial margin (pinned numerically)", () => {
  it("40 effective tokens: +$5.00 on $399.50 margin = 1.25%", () => {
    const r = computePositionPnl(base);
    expect(r.unrealizedPnl).toBe(5_000_000n);
    // IM = 40 x $99.875 x 10% = 399.5 USDC -> 5 / 399.5 = 1.2516%
    expect(r.roe).toBeCloseTo(1.25, 1);
  });

  it("NEGATIVE CONTROL: margin on RAW basis (80 tokens) would read half that, 0.63%", () => {
    // Same PnL over the doubled raw margin: the number a raw-basis denominator prints.
    const rawRoe = (5_000_000 / 799_000_000) * 100;
    expect(rawRoe).toBeCloseTo(0.63, 1);
    expect(computePositionPnl(base).roe).not.toBeCloseTo(rawRoe, 1);
  });
});

describe("5. unknown / reset legs mirror the engine", () => {
  it("a_side > a_basis is InvalidLeg: unknown, never raw", () => {
    const r = computePositionPnl({ ...base, aBasis: ONE / 2n, adlFactors: sides({ aLong: ONE }) });
    expect(r.adlKnown).toBe(false);
    expect(r.effectiveSize).toBeNull();
    expect(r.pnlKnown).toBe(false);
    expect(r.liquidationPriceE6).toBeNull();
  });

  it("a_basis below MIN_A_SIDE is InvalidLeg", () => {
    const r = computePositionPnl({ ...base, aBasis: MIN_A_SIDE - 1n, adlFactors: sides({ aLong: MIN_A_SIDE - 1n }) });
    expect(r.pnlKnown).toBe(false);
  });

  it("an epoch that no longer matches (not a reset obligation) is InvalidLeg: unknown", () => {
    const r = computePositionPnl({ ...base, epochSnap: 3n, adlFactors: sides({ epochLong: 5n }) });
    expect(r.pnlKnown).toBe(false);
    expect(r.effectiveSize).toBeNull();
  });

  it("a prior-reset obligation (ResetPending, epoch_snap + 1 == epoch) owns 0 and withholds PnL", () => {
    const r = computePositionPnl({ ...base, epochSnap: 4n, adlFactors: sides({ epochLong: 5n, modeLong: 2 }) });
    expect(r.effectiveSize).toBe(0n);
    expect(r.pnlKnown).toBe(false);
    expect(r.unrealizedPnl).toBeNull();
  });

  it("CONTROL: the same leg in the current epoch is known", () => {
    const r = computePositionPnl({ ...base, epochSnap: 5n, adlFactors: sides({ epochLong: 5n }) });
    expect(r.pnlKnown).toBe(true);
    expect(r.effectiveSize).toBe(40_000_000n);
  });

  it("drained a_side far below MIN_A_SIDE is still a valid, known leg", () => {
    const r = computePositionPnl({ ...base, adlFactors: sides({ aLong: ONE / 20n }) });
    expect(r.pnlKnown).toBe(true);
    expect(r.effectiveSize).toBe(4_000_000n);
    expect(r.unrealizedPnl).toBe(500_000n);
  });

  it("effectiveExposureQ never returns raw size for a leg the engine would refuse", () => {
    expect(effectiveExposureQ(80_000_000n, ONE, ONE / 2n)).toBe(40_000_000n);
    expect(effectiveExposureQ(80_000_000n, ONE / 2n, ONE)).toBeNull(); // a_side > a_basis
    expect(effectiveExposureQ(80_000_000n, 0n, ONE)).toBeNull(); // no frozen a_basis
    expect(effectiveExposureQ(80_000_000n, ONE, 0n)).toBeNull(); // no side factor
    expect(effectiveExposureQ(-80_000_000n, ONE, ONE / 2n)).toBe(-40_000_000n);
    expect(effectiveExposureQ(0n, 0n, 0n)).toBe(0n);
  });
});

describe("6. the v17 on-chain mark is already post-inversion", () => {
  const cfg = { lastEffectivePriceE6: 100_000_000n, invert: 1 };
  it("v17: invert is NOT applied again", () => {
    expect(onChainMarkE6(cfg, true)).toBe(100_000_000n);
  });
  it("NEGATIVE CONTROL: legacy v12 still applies the flag (raw 0.01 -> $100)", () => {
    expect(onChainMarkE6({ lastEffectivePriceE6: 10_000n, invert: 1 }, false)).toBe(100_000_000n);
    // ... and applying it to the already-inverted v17 value would give the reciprocal.
    expect(onChainMarkE6(cfg, false)).toBe(10_000n);
    expect(onChainMarkE6(cfg, false)).not.toBe(onChainMarkE6(cfg, true));
  });
  it("null config -> null", () => {
    expect(onChainMarkE6(null, true)).toBeNull();
  });
});

describe("2. aggregate caveat copy", () => {
  it("says how many positions are excluded, and nothing when none are", () => {
    expect(unknownPnlCaveat(0)).toBeNull();
    expect(unknownPnlCaveat(1)).toMatch(/Excludes 1 position /);
    expect(unknownPnlCaveat(3)).toMatch(/Excludes 3 positions /);
  });
});
