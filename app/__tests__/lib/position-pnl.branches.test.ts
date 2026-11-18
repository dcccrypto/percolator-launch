/**
 * Branch coverage for lib/position-pnl.ts: short vs long, zero / negative capital, settled vs booked basis,
 * funding-so-far, the live-cache and terminal adapters, a missing mark and huge bigint values. Every expectation is a
 * hand-computed bigint (the arithmetic is in the comment above it), never a snapshot.
 *
 * Conventions: sizes are 6-dp tokens (40_000_000n = 40 tokens), prices e6 ($100 = 100_000_000n), collateral atoms 6 dp.
 *   linear PnL = size x (mark - entry) / 1e6 (floored)      native PnL = |size| x (+-)(mark - entry) / mark (truncated)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ pct: "real" as "real" | "throw" | "nan", holdingFee: false }));

vi.mock("@percolatorct/sdk", async (importOriginal) => {
  const real = await importOriginal<typeof import("@percolatorct/sdk")>();
  return {
    ...real,
    computePnlPercent: (pnl: bigint, cap: bigint) => {
      if (hoisted.pct === "throw") throw new Error("overflow");
      if (hoisted.pct === "nan") return Number.NaN;
      return real.computePnlPercent(pnl, cap);
    },
  };
});
vi.mock("@/lib/v22/lot-registry", () => ({ holdingFeeMayApply: () => hoisted.holdingFee }));

import {
  computePositionPnl,
  lookupKnownEntries,
  portfolioPositionPnl,
  terminalPositionPnl,
  valueAtMark,
  type PortfolioPnlSource,
  type PositionPnlInput,
} from "@/lib/position-pnl";
import { saveEntryPrice } from "@/lib/entry-price";
import { saveBook } from "@/lib/trade-book";
import type { AssetAdlFactors } from "@/lib/v17-adl";
import type { AssetSettleState, RiskLegSnap } from "@/lib/risk-entry";

const ONE = 1_000_000_000_000_000n; // ADL_ONE
const MAX_SAFE_PCT = Number.MAX_SAFE_INTEGER / 100;

const settle = (over: Partial<AssetSettleState> = {}): AssetSettleState => ({
  effectivePriceE6: 100_000_000n,
  kLong: 0n, kShort: 0n, fLong: 0n, fShort: 0n,
  kfEpochLong: 0n, kfEpochShort: 0n, bLong: 0n, bShort: 0n,
  epochLong: 0n, epochShort: 0n,
  ...over,
});
const sides = (over: Partial<AssetAdlFactors> = {}): AssetAdlFactors => ({
  aLong: ONE / 2n, aShort: ONE / 2n, epochLong: 0n, epochShort: 0n, modeLong: 0, modeShort: 0, ...over,
});
const leg = (over: Partial<RiskLegSnap> = {}): RiskLegSnap => ({
  side: 0, kSnap: 0n, fSnap: 0n, kfEpochSnap: 0n, epochSnap: 0n, bSnap: 0n, bEpochSnap: 0n, stale: false, bStale: false, ...over,
});
// raw 80e6 at a_side = 50%  ->  effective +-40e6
const base: PositionPnlInput = {
  basisQ: 80_000_000n,
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

beforeEach(() => {
  localStorage.clear();
  hoisted.pct = "real";
  hoisted.holdingFee = false;
});

describe("valueAtMark: long vs short, capital, huge values", () => {
  const v = { initialMarginBps: 1000n, capital: 1_000_000_000n };

  it("long +$10: native 40e6 x 10e6 / 110e6 = 3_636_363, linear 40e6 x 10e6 / 1e6 = 400_000_000, ROE 400e6/1e9 = 40%", () => {
    const r = valueAtMark({ ...v, effectiveSize: 40_000_000n, entryE6: 100_000_000n, markE6: 110_000_000n });
    expect(r.pnlNative).toBe(3_636_363n);
    expect(r.unrealizedPnl).toBe(400_000_000n);
    expect(r.roe).toBe(40);
  });
  it("short +$10 (mark falls to 90): native 40e6 x 10e6 / 90e6 = 4_444_444, linear +400_000_000, ROE 40%", () => {
    const r = valueAtMark({ ...v, effectiveSize: -40_000_000n, entryE6: 100_000_000n, markE6: 90_000_000n });
    expect(r.pnlNative).toBe(4_444_444n);
    expect(r.unrealizedPnl).toBe(400_000_000n);
    expect(r.roe).toBe(40);
  });
  it("short losing $10 (mark 110): native -3_636_363 (truncated toward zero), linear -400_000_000, ROE -40%", () => {
    const r = valueAtMark({ ...v, effectiveSize: -40_000_000n, entryE6: 100_000_000n, markE6: 110_000_000n });
    expect(r.pnlNative).toBe(-3_636_363n);
    expect(r.unrealizedPnl).toBe(-400_000_000n);
    expect(r.roe).toBe(-40);
  });
  it("a loss that is not a whole atom floors AWAY from zero (-1 x 1 / 1e6 -> -1) while native truncates to 0", () => {
    const r = valueAtMark({ ...v, effectiveSize: -1n, entryE6: 1_000_000n, markE6: 1_000_001n });
    expect(r.unrealizedPnl).toBe(-1n);
    expect(r.pnlNative).toBe(0n);
  });
  it("capital 0: ROE falls back to the position's initial margin: 40e6 x 100e6 / 1e6 = 4e9 notional x 10% = 400e6 -> +400e6/400e6 = 100%", () => {
    const r = valueAtMark({ ...v, capital: 0n, effectiveSize: 40_000_000n, entryE6: 100_000_000n, markE6: 110_000_000n });
    expect(r.roe).toBe(100);
  });
  it("NEGATIVE capital is never a denominator (same 100%), control: positive capital divides by capital (40%)", () => {
    const neg = valueAtMark({ ...v, capital: -5n, effectiveSize: 40_000_000n, entryE6: 100_000_000n, markE6: 110_000_000n });
    expect(neg.roe).toBe(100);
    const pos = valueAtMark({ ...v, effectiveSize: 40_000_000n, entryE6: 100_000_000n, markE6: 110_000_000n });
    expect(pos.roe).toBe(40);
  });
  it("capitalIsPositionMargin=false: positive capital is NOT used, the position's own margin is (400e6 -> 100%)", () => {
    const r = valueAtMark({ ...v, capitalIsPositionMargin: false, effectiveSize: 40_000_000n, entryE6: 100_000_000n, markE6: 110_000_000n });
    expect(r.roe).toBe(100);
  });
  it("dust margin (notional 1e0 x 1e0 / 1e6 = 0 -> margin 0) with capital 1000: ROE = 1 x 10000 / 1000 / 100 = 0.1", () => {
    const r = valueAtMark({ initialMarginBps: 1000n, capital: 1000n, capitalIsPositionMargin: false, effectiveSize: 1n, entryE6: 1n, markE6: 2_000_000n });
    expect(r.unrealizedPnl).toBe(1n);
    expect(r.roe).toBe(0.1);
  });
  it("dust margin and no capital: ROE 0, never NaN", () => {
    const r = valueAtMark({ initialMarginBps: 1000n, capital: 0n, effectiveSize: 1n, entryE6: 1n, markE6: 2_000_000n });
    expect(r.roe).toBe(0);
  });
  it("zero-size position: PnL 0 and ROE 0 on any mark", () => {
    const r = valueAtMark({ ...v, effectiveSize: 0n, entryE6: 100_000_000n, markE6: 110_000_000n });
    expect([r.pnlNative, r.unrealizedPnl, r.roe]).toEqual([0n, 0n, 0]);
  });
  it("a throwing percent helper is swallowed: ROE 0 but the bigint PnL is intact", () => {
    hoisted.pct = "throw";
    const r = valueAtMark({ ...v, effectiveSize: 40_000_000n, entryE6: 100_000_000n, markE6: 110_000_000n });
    expect(r.roe).toBe(0);
    expect(r.unrealizedPnl).toBe(400_000_000n);
  });
  it("a non-finite percent is replaced by 0", () => {
    hoisted.pct = "nan";
    expect(valueAtMark({ ...v, effectiveSize: 40_000_000n, entryE6: 100_000_000n, markE6: 110_000_000n }).roe).toBe(0);
  });

  it("HUGE: 1e30 size, $500k -> $1M: linear = 1e30 x 5e11 / 1e6 = 5e35 EXACT (a Number would round it), native = 1e30 x 5e11 / 1e12 = 5e29", () => {
    const r = valueAtMark({ ...v, effectiveSize: 10n ** 30n, entryE6: 500_000_000_000n, markE6: 1_000_000_000_000n });
    expect(r.unrealizedPnl).toBe(5n * 10n ** 35n);
    expect(r.pnlNative).toBe(5n * 10n ** 29n);
    expect(r.roe).toBe(MAX_SAFE_PCT); // clamped, finite
  });
  it("HUGE loss clamps ROE to -MAX_SAFE/100 and keeps the exact bigint loss", () => {
    const r = valueAtMark({ ...v, effectiveSize: 10n ** 30n, entryE6: 1_000_000_000_000n, markE6: 500_000_000_000n });
    expect(r.unrealizedPnl).toBe(-5n * 10n ** 35n);
    expect(r.roe).toBe(-MAX_SAFE_PCT);
  });
  it("size past 2^53 keeps every digit: (2^53+1) x $1 -> $2 = 9007199254740993 atoms exactly (Number(...) would print ...992)", () => {
    const size = 9_007_199_254_740_993n;
    const r = valueAtMark({ ...v, effectiveSize: size, entryE6: 1_000_000n, markE6: 2_000_000n });
    expect(r.unrealizedPnl).toBe(size);
    expect(BigInt(Number(size))).not.toBe(size);
  });
});

describe("computePositionPnl: effective size", () => {
  it("flat: size 0, known, zero PnL/ROE, riskKnown, no liquidation price", () => {
    const r = computePositionPnl({ ...base, basisQ: 0n });
    expect(r).toMatchObject({ effectiveSize: 0n, adlKnown: true, pnlKnown: true, pnlNative: 0n, unrealizedPnl: 0n, riskUnrealizedPnl: 0n, roe: 0, riskKnown: true, liquidationPriceE6: 0n });
  });
  it("legacy engine (adlApplicable false): raw basis IS the exposure, long and short, even with factors null", () => {
    const long = computePositionPnl({ ...base, adlApplicable: false, adlFactors: null });
    expect(long.effectiveSize).toBe(80_000_000n);
    // 80e6 x (100e6 - 99_875_000) / 1e6 = 80e6 x 125_000 / 1e6 = 10_000_000
    expect(long.unrealizedPnl).toBe(10_000_000n);
    const short = computePositionPnl({ ...base, basisQ: -80_000_000n, adlApplicable: false, adlFactors: null });
    expect(short.effectiveSize).toBe(-80_000_000n);
    // -80e6 x (100e6 - 99_875_000) / 1e6 = -10_000_000
    expect(short.unrealizedPnl).toBe(-10_000_000n);
  });
  it("factors without epochs: long scales by aLong, short by aShort, rounded UP (ceil)", () => {
    const f: AssetAdlFactors = { aLong: ONE / 2n, aShort: ONE / 4n };
    const noEpoch = { ...base, epochSnap: undefined, adlFactors: f };
    expect(computePositionPnl(noEpoch).effectiveSize).toBe(40_000_000n);
    // 33_333_333 x 0.25 = 8_333_333.25 -> ceil 8_333_334, short = negative
    expect(computePositionPnl({ ...noEpoch, basisQ: -33_333_333n }).effectiveSize).toBe(-8_333_334n);
  });
  it("epochs present but epochSnap omitted still takes the no-epoch path", () => {
    // a stale epoch in the factors: the epoch path says unknown, the no-epoch path ignores epochs and scales
    expect(computePositionPnl({ ...base, epochSnap: undefined, adlFactors: sides({ epochLong: 1n }) }).effectiveSize).toBe(40_000_000n);
    expect(computePositionPnl({ ...base, adlFactors: sides({ epochLong: 1n }) }).effectiveSize).toBeNull();
  });
  it("an invalid leg (a_side > a_basis) is unknown, via both paths, and shows no PnL and no liquidation price", () => {
    for (const p of [base, { ...base, epochSnap: undefined }]) {
      const r = computePositionPnl({ ...p, adlFactors: sides({ aLong: ONE + 1n }) });
      expect(r.effectiveSize).toBeNull();
      expect(r.adlKnown).toBe(false);
      expect(r.pnlKnown).toBe(false);
      expect(r.liquidationPriceE6).toBeNull();
      expect(r.riskKnown).toBe(false);
    }
  });
  it("a leg on a past epoch whose side is ResetPending owns 0 and its PnL is withheld", () => {
    const r = computePositionPnl({ ...base, adlFactors: sides({ epochLong: 1n, modeLong: 2 }) });
    expect(r.effectiveSize).toBe(0n);
    expect(r.pnlKnown).toBe(false);
    expect(r.unrealizedPnl).toBeNull();
    expect(r.riskKnown).toBe(false);
  });
  it("a leg on a past epoch with the side NOT resetting is unknown (not zero)", () => {
    const r = computePositionPnl({ ...base, adlFactors: sides({ epochLong: 1n, modeLong: 0 }) });
    expect(r.effectiveSize).toBeNull();
  });
});

describe("computePositionPnl: entry resolution", () => {
  it("unknown size still honours a recorded entry: server first, then cache, else unknown at the anchor", () => {
    const nul = { ...base, adlFactors: null };
    const s = computePositionPnl({ ...nul, serverEntryE6: 90_000_000n });
    expect([s.entrySource, s.entry]).toEqual(["server", 90_000_000n]);
    const c = computePositionPnl(nul);
    expect([c.entrySource, c.entry]).toEqual(["cache", 99_875_000n]);
    const u = computePositionPnl({ ...nul, cachedEntryE6: 0n, anchorMarkE6: 95_000_000n });
    expect([u.entrySource, u.entry]).toEqual(["unknown", 95_000_000n]);
    for (const r of [s, c, u]) expect(r.unrealizedPnl).toBeNull();
  });
  it("anchor: a positive anchorMarkE6 is the back-solve anchor, 0n and undefined fall back to the mark", () => {
    const noCache = { ...base, cachedEntryE6: 0n };
    // back-solve: entry = anchor - 5e6 x 1e6 / 40e6 = anchor - 125_000
    expect(computePositionPnl({ ...noCache, anchorMarkE6: 120_000_000n }).entry).toBe(119_875_000n);
    expect(computePositionPnl({ ...noCache, anchorMarkE6: 0n }).entry).toBe(99_875_000n);
    expect(computePositionPnl(noCache).entry).toBe(99_875_000n);
  });
  it("a sentinel onChainPnl is treated as 0: nothing to back-solve from, so the entry is unknown", () => {
    const r = computePositionPnl({ ...base, cachedEntryE6: 0n, onChainPnl: 18_446_744_073_709_551_615n });
    expect(r.entrySource).toBe("unknown");
    expect(r.pnlKnown).toBe(false);
  });
  it("cache check: a record saved for the SAME effective size counts, another size is dropped to a derived estimate", () => {
    const same = computePositionPnl({ ...base, cachedEntryCheck: { sizeQ: 40_000_000n, pending: false } });
    expect(same.entrySource).toBe("cache");
    const other = computePositionPnl({ ...base, cachedBusyFeeAtoms: 123n, cachedEntryCheck: { sizeQ: 50_000_000n, pending: false } });
    expect(other.entrySource).toBe("derived");
    expect(other.isEstimate).toBe(true);
    expect(other.busyFeePaidAtoms).toBeNull();
  });
  it("cache check: a size-less record counts only while pending", () => {
    expect(computePositionPnl({ ...base, cachedEntryCheck: { sizeQ: null, pending: true } }).entrySource).toBe("cache");
    expect(computePositionPnl({ ...base, cachedEntryCheck: { sizeQ: null, pending: false } }).entrySource).toBe("derived");
  });
  it("busy fee rides only with a CURRENT cache entry", () => {
    expect(computePositionPnl({ ...base, cachedBusyFeeAtoms: 123n }).busyFeePaidAtoms).toBe(123n);
    expect(computePositionPnl(base).busyFeePaidAtoms).toBeNull();
    expect(computePositionPnl({ ...base, cachedBusyFeeAtoms: 123n, serverEntryE6: 99_000_000n }).busyFeePaidAtoms).toBeNull();
  });
  it("holdingFeeExcluded mirrors the input flag only when exactly true", () => {
    expect(computePositionPnl({ ...base, holdingFeeMayApply: true }).holdingFeeExcluded).toBe(true);
    expect(computePositionPnl({ ...base, holdingFeeMayApply: false }).holdingFeeExcluded).toBe(false);
    expect(computePositionPnl(base).holdingFeeExcluded).toBe(false);
  });
});

describe("computePositionPnl: missing mark, derived, risk gating", () => {
  it("mark 0: PnL unknown, riskKnown false (a flat position stays known)", () => {
    const r = computePositionPnl({ ...base, markE6: 0n });
    expect(r.pnlKnown).toBe(false);
    expect(r.unrealizedPnl).toBeNull();
    expect(r.roe).toBeNull();
    expect(r.riskKnown).toBe(false);
    expect(computePositionPnl({ ...base, basisQ: 0n, markE6: 0n }).riskKnown).toBe(true);
  });
  it("long and short with a recorded entry: PnL at the mark and ROE on capital", () => {
    // long: 40e6 x (101e6 - 99_875_000) / 1e6 = 40e6 x 1_125_000 / 1e6 = 45_000_000; ROE 45e6 x 1e4 / 1e9 = 450 -> 4.5%
    const long = computePositionPnl({ ...base, markE6: 101_000_000n });
    expect(long.unrealizedPnl).toBe(45_000_000n);
    expect(long.roe).toBe(4.5);
    // short at mark 98e6: -40e6 x (98e6 - 99_875_000) / 1e6 = 40e6 x 1_875_000 / 1e6 = 75_000_000; ROE 7.5%
    const short = computePositionPnl({ ...base, basisQ: -80_000_000n, markE6: 98_000_000n });
    expect(short.effectiveSize).toBe(-40_000_000n);
    expect(short.unrealizedPnl).toBe(75_000_000n);
    expect(short.roe).toBe(7.5);
  });
  it("zero and negative capital still give a ROE, on the position's margin: 45e6 / (40e6 x 99_875_000 / 1e6 x 10% = 399_500_000) = 11.26%", () => {
    for (const capital of [0n, -1n]) {
      const r = computePositionPnl({ ...base, capital, markE6: 101_000_000n });
      expect(r.unrealizedPnl).toBe(45_000_000n);
      // 45e6 x 1e4 / 399_500_000 = 1126 (integer) -> 11.26
      expect(r.roe).toBe(11.26);
    }
  });
  it("derived entry: PnL and ROE withheld, but the VALUE side keeps the chain-faithful PnL (+5_000_000)", () => {
    const r = computePositionPnl({ ...base, cachedEntryE6: 0n });
    expect(r.entrySource).toBe("derived");
    expect(r.pnlKnown).toBe(false);
    expect(r.roe).toBeNull();
    // entry 99_875_000 valued at mark 100e6 on 40e6 = 5_000_000
    expect(r.riskUnrealizedPnl).toBe(5_000_000n);
  });
  it("derived with several legs sharing capital takes the same value-side path", () => {
    const r = computePositionPnl({ ...base, cachedEntryE6: 0n, activeLegCount: 2 });
    expect(r.riskUnrealizedPnl).toBe(5_000_000n);
    expect(r.pnlKnown).toBe(false);
  });
});

describe("computePositionPnl: settled vs booked risk basis", () => {
  const settled = (over: Partial<PositionPnlInput> = {}): PositionPnlInput => ({
    ...base,
    adlFactors: sides({ settle: settle() }),
    riskLeg: leg(),
    activeLegCount: 1,
    cachedEntryE6: 99_500_000n,
    ...over,
  });

  it("long, fully settled: risk entry = 100e6 - 5e6 x 1e6 / 40e6 = 99_875_000; displayed PnL stays at the fill (40e6 x 500_000 / 1e6 = 20_000_000), value PnL is 40e6 x 125_000 / 1e6 = 5_000_000", () => {
    const r = computePositionPnl(settled());
    expect(r.riskEntrySettled).toBe(true);
    expect(r.riskEntry).toBe(99_875_000n);
    expect(r.entry).toBe(99_500_000n);
    expect(r.unrealizedPnl).toBe(20_000_000n);
    expect(r.riskUnrealizedPnl).toBe(5_000_000n);
  });
  it("short, fully settled: risk entry = 100e6 + 125_000 = 100_125_000", () => {
    const r = computePositionPnl(settled({ basisQ: -80_000_000n, riskLeg: leg({ side: 1 }) }));
    expect(r.riskEntrySettled).toBe(true);
    expect(r.riskEntry).toBe(100_125_000n);
  });
  it("derived + settled: value PnL comes from the settled risk entry (5_000_000), display stays withheld", () => {
    const r = computePositionPnl(settled({ cachedEntryE6: 0n }));
    expect(r.entrySource).toBe("derived");
    expect(r.riskEntrySettled).toBe(true);
    expect(r.riskUnrealizedPnl).toBe(5_000_000n);
    expect(r.unrealizedPnl).toBeNull();
  });
  it("not settled when anything could be pending: a second leg, a side mismatch, a stale leg, a moved K, a sentinel pnl, a missing leg", () => {
    const cases: Partial<PositionPnlInput>[] = [
      { activeLegCount: 2 },
      { riskLeg: leg({ side: 1 }) }, // long position, short leg snapshot
      { riskLeg: leg({ stale: true }) },
      { adlFactors: sides({ settle: settle({ kLong: 7n }) }) },
      { onChainPnl: 18_446_744_073_709_551_615n },
      { riskLeg: null },
      { adlFactors: sides({ settle: null }) },
    ];
    for (const c of cases) {
      const r = computePositionPnl(settled(c));
      expect(r.riskEntrySettled).toBe(false);
      // falls back to the displayed entry; for the sentinel (pnl read as 0) the cache entry is still the booked basis
      expect(r.riskEntry).toBe(99_500_000n);
    }
  });
  it("a settled back-solve that would not be a positive price keeps the booked basis", () => {
    // pnl so large the long's entry 100e6 - 5e6 x 1e6/40e6 x 1200 (pnl 6e9) goes negative -> null
    const r = computePositionPnl(settled({ onChainPnl: 6_000_000_000n }));
    expect(r.riskEntrySettled).toBe(false);
    expect(r.riskEntry).toBe(99_500_000n);
  });
  it("booked basis: a current cache entry's booked price drives risk math, the fill price drives display", () => {
    const r = computePositionPnl({ ...base, cachedEntryE6: 99_000_000n, cachedRiskEntryE6: 99_875_000n });
    expect(r.entry).toBe(99_000_000n);
    expect(r.riskEntry).toBe(99_875_000n);
    expect(r.riskEntrySettled).toBe(false);
    expect(r.unrealizedPnl).toBe(40_000_000n); // 40e6 x 1_000_000 / 1e6
    expect(r.riskUnrealizedPnl).toBe(5_000_000n); // 40e6 x 125_000 / 1e6
    // liquidation on the BOOKED basis: (99_875_000 x 40e6 - 1e9 x 1e6) = 2.995e15; x 1e4 / (40e6 x 9500) = 78_815_789.47 -> ceil
    expect(r.liquidationPriceE6).toBe(78_815_790n);
  });
  it("booked basis is ignored for a server entry, a stale cache entry, and when equal to the entry", () => {
    const server = computePositionPnl({ ...base, serverEntryE6: 99_000_000n, cachedRiskEntryE6: 99_875_000n });
    expect(server.riskEntry).toBe(99_000_000n);
    expect(server.riskUnrealizedPnl).toBe(server.unrealizedPnl);
    const stale = computePositionPnl({ ...base, cachedEntryCheck: { sizeQ: 1n, pending: false }, cachedRiskEntryE6: 99_900_000n });
    expect(stale.entrySource).toBe("derived");
    expect(stale.riskEntry).toBe(stale.entry);
    const same = computePositionPnl({ ...base, cachedRiskEntryE6: 99_875_000n });
    expect(same.riskUnrealizedPnl).toBe(same.unrealizedPnl);
  });
  it("no maintenance bps: no liquidation price, even with a known size", () => {
    expect(computePositionPnl({ ...base, maintenanceMarginBps: undefined }).liquidationPriceE6).toBeNull();
  });
});

describe("computePositionPnl: funding so far", () => {
  // d = fLong - fSnap = 37_500_000_000_000; pending = -floor(80e6 x d / (ONE x 1e6)) = -floor(3e21 / 1e21) = -3
  const f = (over: Partial<PositionPnlInput> = {}, st: Partial<AssetSettleState> = {}): PositionPnlInput => ({
    ...base,
    adlFactors: sides({ settle: settle({ fLong: 37_500_000_000_000n, ...st }) }),
    riskLeg: leg(),
    activeLegCount: 1,
    fundingNetPaidAtoms: 1000n,
    cachedFundingBook: { fundingBase: 100n, q: 40_000_000n },
    ...over,
  });
  it("paid = net now - base + pending = 1000 - 100 + (-3) = 897", () => {
    const r = computePositionPnl(f());
    expect(r.fundingPaidAtoms).toBe(897n);
    expect(r.fundingLoading).toBe(false);
  });
  it("a leg AHEAD of the side's kf epoch is catching up: no number, loading (and not loading when an input is absent)", () => {
    const r = computePositionPnl(f({ riskLeg: leg({ kfEpochSnap: 5n }) }));
    expect(r.fundingPaidAtoms).toBeNull();
    expect(r.fundingLoading).toBe(true);
    expect(computePositionPnl(f({ riskLeg: leg({ kfEpochSnap: 5n }), fundingNetPaidAtoms: null })).fundingLoading).toBe(false);
    expect(computePositionPnl(f({ riskLeg: leg({ kfEpochSnap: 5n }), cachedFundingBook: { fundingBase: null, q: 40_000_000n } })).fundingLoading).toBe(false);
  });
  it("unknown (null, not loading) when: no book, a book for another size, several legs, no net counter, a flat or reset or unknown-size leg", () => {
    const cases: Partial<PositionPnlInput>[] = [
      { cachedFundingBook: null },
      { cachedFundingBook: { fundingBase: 100n, q: 50_000_000n } },
      { activeLegCount: 2 },
      { activeLegCount: null },
      { fundingNetPaidAtoms: null },
      { basisQ: 0n },
      { adlFactors: sides({ epochLong: 1n, modeLong: 2, settle: settle() }) },
      { adlFactors: null },
    ];
    for (const c of cases) {
      const r = computePositionPnl(f(c));
      expect(r.fundingPaidAtoms).toBeNull();
      expect(r.fundingLoading).toBe(false);
    }
  });
});

describe("lookupKnownEntries + the portfolio adapter (live cache read)", () => {
  const W = "Wallet1";
  const S = "SlabA";
  const account = { positionSize: 80_000_000n, adlABasis: ONE, adlEpochSnap: 0n, pnl: 5_000_000n, capital: 1_000_000_000n };
  const pos = (over: Partial<PortfolioPnlSource> = {}): PortfolioPnlSource => ({
    account,
    adlFactors: sides(),
    effectiveEntryPrice: 0n,
    entryPriceSource: "derived",
    initialMarginBps: 1000n,
    maintenanceMarginBps: 500n,
    oraclePriceE6: 100_000_000n,
    slabAddress: S,
    idx: 0,
    entryCacheWallet: W,
    ...over,
  });

  it("lookupKnownEntries exposes this device's trade book, and none for an empty wallet", () => {
    saveBook(W, S, "P1", { q: 40_000_000n, avgE6: 99_875_000n, fees: 0n, pnl: 0n, fundingBase: 100n });
    expect(lookupKnownEntries(S, 0, W).cachedFundingBook).toEqual({ fundingBase: 100n, q: 40_000_000n });
    expect(lookupKnownEntries(S, 0, "").cachedFundingBook).toBeNull();
  });

  it("a live saved entry beats the snapshot: recorded entry, size check passes, PnL at the live mark", () => {
    saveEntryPrice(S, 0, 99_875_000n, undefined, W, 40_000_000n);
    const r = portfolioPositionPnl(pos(), 101_000_000n);
    expect(r.entrySource).toBe("cache");
    expect(r.unrealizedPnl).toBe(45_000_000n); // 40e6 x 1_125_000 / 1e6
    expect(r.roe).toBe(4.5);
  });
  it("a live record for another size is not trusted: the entry falls to a derived estimate", () => {
    saveEntryPrice(S, 0, 99_875_000n, undefined, W, 99_000_000n);
    const r = portfolioPositionPnl(pos(), null);
    expect(r.entrySource).toBe("derived");
    expect(r.pnlKnown).toBe(false);
  });
  it("cache key present but NO record: a snapshot 'cache' entry must not stand in (zeros), even though the row says cache", () => {
    const r = portfolioPositionPnl(pos({ entryPriceSource: "cache", effectiveEntryPrice: 99_000_000n }), 100_000_000n);
    expect(r.entrySource).toBe("derived");
  });
  it("no cache key to read: a snapshot cache entry is re-fed, any other source is not", () => {
    const noKey = { entryCacheWallet: undefined, slabAddress: undefined, idx: undefined };
    const cache = portfolioPositionPnl(pos({ ...noKey, entryPriceSource: "cache", effectiveEntryPrice: 99_875_000n }), 100_000_000n);
    expect(cache.entrySource).toBe("cache");
    expect(cache.unrealizedPnl).toBe(5_000_000n);
    const derived = portfolioPositionPnl(pos({ ...noKey, entryPriceSource: "derived", effectiveEntryPrice: 99_875_000n }), 100_000_000n);
    expect(derived.entrySource).toBe("derived");
    // a key with idx missing is also "no key"
    expect(portfolioPositionPnl(pos({ idx: undefined, entryPriceSource: "cache", effectiveEntryPrice: 99_875_000n }), 100_000_000n).entrySource).toBe("cache");
  });
  it("a server row is fed as the server entry (priority over everything): 40e6 x 1e6 / 1e6 = 40_000_000", () => {
    const r = portfolioPositionPnl(pos({ entryPriceSource: "server", effectiveEntryPrice: 99_000_000n }), 100_000_000n);
    expect(r.entrySource).toBe("server");
    expect(r.unrealizedPnl).toBe(40_000_000n);
  });
  it("live mark: null / 0 / negative fall back to the row's oracle price; a positive live mark wins", () => {
    saveEntryPrice(S, 0, 99_875_000n, undefined, W, 40_000_000n);
    expect(portfolioPositionPnl(pos(), undefined).unrealizedPnl).toBe(5_000_000n);
    expect(portfolioPositionPnl(pos(), 0n).unrealizedPnl).toBe(5_000_000n);
    expect(portfolioPositionPnl(pos(), -1n).unrealizedPnl).toBe(5_000_000n);
    expect(portfolioPositionPnl(pos(), 110_000_000n).unrealizedPnl).toBe(405_000_000n); // 40e6 x (110e6 - 99_875_000) / 1e6 = 40e6 x 10_125_000 / 1e6
  });
  it("a missing account is a flat position; missing factors on a live row are unknown; adlApplicable false uses raw basis", () => {
    const flat = portfolioPositionPnl(pos({ account: null }), 100_000_000n);
    expect(flat.effectiveSize).toBe(0n);
    expect(flat.pnlKnown).toBe(true);
    expect(portfolioPositionPnl(pos({ adlFactors: undefined }), 100_000_000n).adlKnown).toBe(false);
    expect(portfolioPositionPnl(pos({ adlFactors: undefined, adlApplicable: false }), 100_000_000n).effectiveSize).toBe(80_000_000n);
  });
  it("funding book + the account's net counter flow through: 1000 - 100 + (-3) = 897", () => {
    saveEntryPrice(S, 0, 99_875_000n, undefined, W, 40_000_000n);
    saveBook(W, S, "P1", { q: 40_000_000n, avgE6: 99_875_000n, fees: 0n, pnl: 0n, fundingBase: 100n });
    const acct = { ...account, fundingNetPaidAtoms: 1000n, riskLeg: leg(), activeLegCount: 1 };
    const r = portfolioPositionPnl(pos({ account: acct, adlFactors: sides({ settle: settle({ fLong: 37_500_000_000_000n }) }) }), 100_000_000n);
    expect(r.fundingPaidAtoms).toBe(897n);
    // no wallet -> no book
    const noWallet = portfolioPositionPnl(pos({ account: acct, entryCacheWallet: undefined, adlFactors: sides({ settle: settle({ fLong: 37_500_000_000_000n }) }) }), 100_000_000n);
    expect(noWallet.fundingPaidAtoms).toBeNull();
  });
  it("holding-fee flag comes from the lot registry for the slab", () => {
    hoisted.holdingFee = true;
    expect(portfolioPositionPnl(pos(), 100_000_000n).holdingFeeExcluded).toBe(true);
    hoisted.holdingFee = false;
    expect(portfolioPositionPnl(pos(), 100_000_000n).holdingFeeExcluded).toBe(false);
  });
});

describe("terminalPositionPnl adapter", () => {
  const owner = { toBase58: () => "OwnerW" };
  const acct = { positionSize: 80_000_000n, adlABasis: ONE, adlEpochSnap: 0n, pnl: 5_000_000n, capital: 1_000_000_000n, owner };
  const args = { account: acct, slabAddress: "SlabT", accountIdx: 0, adlFactors: sides(), adlApplicable: true, markE6: 100_000_000n, initialMarginBps: 1000n, maintenanceMarginBps: 500n };

  it("reads the cache scoped to the account owner: PnL 5_000_000, ROE 0.5%", () => {
    saveEntryPrice("SlabT", 0, 99_875_000n, undefined, "OwnerW", 40_000_000n);
    const r = terminalPositionPnl(args);
    expect(r.entrySource).toBe("cache");
    expect(r.unrealizedPnl).toBe(5_000_000n);
    expect(r.roe).toBe(0.5);
  });
  it("another wallet's cache is not read: derived, PnL withheld", () => {
    saveEntryPrice("SlabT", 0, 99_875_000n, undefined, "Other", 40_000_000n);
    expect(terminalPositionPnl(args).entrySource).toBe("derived");
  });
  it("an on-chain entry (v12.x) wins over the cache and carries no size check", () => {
    saveEntryPrice("SlabT", 0, 90_000_000n, undefined, "OwnerW", 99_000_000n);
    const r = terminalPositionPnl({ ...args, account: { ...acct, entryPrice: 99_000_000n } });
    expect(r.entrySource).toBe("cache");
    expect(r.entry).toBe(99_000_000n);
    expect(r.unrealizedPnl).toBe(40_000_000n);
  });
  it("a partial account (no owner, no frozen factor) degrades instead of throwing", () => {
    const partial = { positionSize: 80_000_000n, pnl: 5_000_000n, capital: 1_000_000_000n } as unknown as typeof acct;
    const r = terminalPositionPnl({ ...args, account: partial, anchorMarkE6: 100_000_000n });
    // aBasis 0n is below MIN_A_SIDE: the leg is invalid, so unknown
    expect(r.effectiveSize).toBeNull();
    expect(r.pnlKnown).toBe(false);
  });
  it("holding-fee flag is forwarded", () => {
    hoisted.holdingFee = true;
    expect(terminalPositionPnl(args).holdingFeeExcluded).toBe(true);
  });
});
