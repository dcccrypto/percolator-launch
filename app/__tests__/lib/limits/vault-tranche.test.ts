// @vitest-environment node
/** P3 behaviour: NAV share price, cushion, withdrawals, step-down, funding drift, APY, creator caps. */
import { describe, it, expect } from "vitest";
import {
  apyFromFeeSnapshots,
  combineFundingRateE9,
  effectiveSeniorClaim,
  firstLossCushionBps,
  fundingPerHourAtoms,
  juniorWithdrawableAtoms,
  juniorWithdrawAllowed,
  projectCreatorCaps,
  projectLiqDrift,
  recallLimit,
  seniorAtomsForRedemption,
  seniorImpaired,
  seniorSharePriceE6,
  skewFundingRateE9,
  stepDownMaxLeverage,
  trancheSplit,
  MIN_APY_WINDOW_SECS,
} from "@/lib/limits/vault-tranche";

describe("waterfall + NAV share price", () => {
  it("junior absorbs losses first; senior share price holds until the junior is gone", () => {
    const C = 1_000n;
    const S = 1_000n;
    // V = 1150: senior whole, junior 150
    let s = trancheSplit(1_150n, C);
    expect(s).toEqual({ senior: 1_000n, junior: 150n });
    expect(seniorSharePriceE6(s.senior, S)).toBe(1_000_000n);
    // a 100 loss hits only the junior
    s = trancheSplit(1_050n, C);
    expect(s.senior).toBe(1_000n);
    expect(firstLossCushionBps(s.junior, C)).toBe(500);
    // past the junior: seniors take the rest, price falls
    s = trancheSplit(900n, C);
    expect(s).toEqual({ senior: 900n, junior: 0n });
    expect(seniorSharePriceE6(s.senior, S)).toBe(900_000n);
    expect(seniorImpaired(900n, C)).toBe(true);
  });

  it("harvestable fees are priced into the senior claim (crank timing can't be gamed)", () => {
    expect(effectiveSeniorClaim(1_000n, 101n, 10_000)).toBe(1_101n);
    expect(effectiveSeniorClaim(1_000n, 101n, 5_000)).toBe(1_050n);
  });

  it("redemption pays floor(shares·senior/S)", () => {
    expect(seniorAtomsForRedemption(333n, 1_000n, 900n)).toBe(299n);
    expect(seniorAtomsForRedemption(1_001n, 1_000n, 900n)).toBeNull();
    expect(seniorSharePriceE6(0n, 0n)).toBeNull();
  });
});

describe("junior withdrawals", () => {
  it("allowed only above the floor and only while backing covers the senior", () => {
    // V 1200, C 1000, floor 10% => junior 200, floor 100 => 100 withdrawable
    expect(juniorWithdrawableAtoms(1_200n, 1_000n, 1_000n, 1_000)).toBe(100n);
    expect(juniorWithdrawAllowed(1_200n, 1_000n, 1_000n, 100n, 1_000)).toBe(true);
    expect(juniorWithdrawAllowed(1_200n, 1_000n, 1_000n, 101n, 1_000)).toBe(false);
    // backing short of C => nothing
    expect(juniorWithdrawableAtoms(1_200n, 1_000n, 999n, 1_000)).toBe(0n);
    expect(recallLimit(1_000n, 999n)).toBe(1n);
  });
});

describe("skew funding + drift warning", () => {
  it("a short vault LP (traders long) => longs pay, capped, then combined within the engine bound", () => {
    const r = skewFundingRateE9(-500n, 1_000n, 1_000n, 300n);
    expect(r).toBe(300n); // 1000*0.5 = 500 > cap 300
    expect(skewFundingRateE9(500n, 1_000n, 1_000n, 300n)).toBe(-300n);
    expect(combineFundingRateE9(200n, 300n, 400n)).toBe(400n);
  });

  it("per-hour funding: longs pay a positive rate, shorts receive", () => {
    // 1000 units at $1 = $1000 notional (1e9 atoms); rate 10 e9/slot = 1e-8/slot; 9000 slots/h
    expect(fundingPerHourAtoms(1_000_000_000n, 1_000_000n, 10n)).toBe(90_000n); // $0.09/h
    expect(fundingPerHourAtoms(-1_000_000_000n, 1_000_000n, 10n)).toBe(-90_000n);
  });

  it("warns when a day of funding eats >= 10% of the margin above maintenance; receivers never warn", () => {
    const d = projectLiqDrift(1_000_000_000n, 1_000_000n, 10n, 20_000_000n); // $20 buffer, $2.16/day
    expect(d.consumedAtoms).toBe(2_160_000n);
    expect(d.warn).toBe(true);
    expect(d.liqMoveE6).toBe(2_160n); // liq moves $0.00216
    expect(projectLiqDrift(1_000_000_000n, 1_000_000n, 10n, 30_000_000n).warn).toBe(false);
    expect(projectLiqDrift(-1_000_000_000n, 1_000_000n, 10n, 1n).warn).toBe(false);
  });
});

describe("leverage step-down", () => {
  // base IMR 10% (10x), cap N = 1000 units, max IMR 50% (2x)
  it("joining the crowd lowers max leverage; the thin side keeps base leverage", () => {
    // vault LP short 400 (traders long). Taker long 200 => LP short 600 => crowd 60% => IMR 50% cap... 6000 bps > 5000 => 5000
    const joined = stepDownMaxLeverage(-400n, 200n, true, 1_000n, 1_000n, 5_000);
    expect(joined).toEqual({ maxLeverage: 2, stepped: true, imrBps: 5_000n });
    const mid = stepDownMaxLeverage(-100n, 100n, true, 1_000n, 1_000n, 5_000); // 20% crowd => 2000 bps => 5x
    expect(mid).toEqual({ maxLeverage: 5, stepped: true, imrBps: 2_000n });
    const thin = stepDownMaxLeverage(-400n, 200n, false, 1_000n, 1_000n, 5_000);
    expect(thin).toEqual({ maxLeverage: 10, stepped: false, imrBps: 1_000n });
  });
  it("off when cap is 0", () => {
    expect(stepDownMaxLeverage(-400n, 200n, true, 0n, 1_000n, 5_000).maxLeverage).toBe(10);
  });
});

describe("APY from real fee credits only", () => {
  const t0 = 1_700_000_000;
  it("null below 24 h, with no principal, or when the counter resets", () => {
    const a = { t: t0, seniorFeeCreditedAtoms: 0n, seniorClaimAtoms: 1_000_000n };
    expect(apyFromFeeSnapshots(a, { ...a, t: t0 + MIN_APY_WINDOW_SECS - 1, seniorFeeCreditedAtoms: 10n })).toBeNull();
    expect(apyFromFeeSnapshots({ ...a, seniorClaimAtoms: 0n }, { t: t0 + 86_400, seniorFeeCreditedAtoms: 10n, seniorClaimAtoms: 0n })).toBeNull();
    expect(apyFromFeeSnapshots({ ...a, seniorFeeCreditedAtoms: 50n }, { ...a, t: t0 + 86_400, seniorFeeCreditedAtoms: 10n })).toBeNull();
  });
  it("annualises the credited fees over average principal", () => {
    // 1,000 fee atoms/day on 1,000,000 principal = 0.1%/day = 36.5%/yr = 3650 bps
    const a = { t: t0, seniorFeeCreditedAtoms: 0n, seniorClaimAtoms: 1_000_000n };
    const b = { t: t0 + 86_400, seniorFeeCreditedAtoms: 1_000n, seniorClaimAtoms: 1_000_000n };
    expect(apyFromFeeSnapshots(a, b)).toBe(3_650);
  });
});

describe("creator wizard projection", () => {
  it("junior $1,000 at 10x and a 10% floor: $10k LP exposure, $10k of Earn deposits", () => {
    expect(projectCreatorCaps(1_000_000_000n, 100_000, 1_000)).toEqual({
      maxLpNotionalAtoms: 10_000_000_000n,
      maxSeniorAtoms: 10_000_000_000n,
    });
  });
});

import { earnTrancheView, rollFeeSnapshots } from "@/lib/limits/vault-tranche";

describe("earnTrancheView", () => {
  const base = {
    seniorClaimAtoms: 1_000_000_000n,
    juniorFloorBps: 1_000,
    seniorFeeShareBps: 10_000,
    backingNavAtoms: 1_000_000_000n,
    harvestableAtoms: 0n as bigint | null,
    lpValue: { kind: "certified", atoms: 200_000_000n } as const,
    totalShares: 1_000_000_000n,
    withdrawShares: 0n,
  };
  it("covered: price 1.0, 20% cushion, normal withdrawal", () => {
    const v = earnTrancheView({ ...base, withdrawShares: 100_000_000n })!;
    expect(v.valuation).toBe("certified");
    expect(v.sharePriceE6).toBe(1_000_000n);
    expect(v.junior).toBe(200_000_000n);
    expect(v.cushionBps).toBe(2_000);
    expect(v.withdrawAtoms).toBe(100_000_000n);
    expect(v.withdrawKind).toBe("normal");
    expect(v.juniorFloorAtoms).toBe(100_000_000n);
    expect(v.excludesUncrankedFees).toBe(false);
  });
  it("illiquid: backing short of C, junior in the LP covers it", () => {
    const v = earnTrancheView({ ...base, backingNavAtoms: 900_000_000n })!;
    expect(v.impaired).toBe(false);
    expect(v.illiquid).toBe(true);
    expect(v.withdrawKind).toBe("illiquid");
  });
  it("impaired: junior exhausted, price below 1, redemptions pay pro-rata of senior", () => {
    const v = earnTrancheView({ ...base, backingNavAtoms: 700_000_000n, lpValue: { kind: "certified", atoms: 100_000_000n }, withdrawShares: 100_000_000n })!;
    expect(v.impaired).toBe(true);
    expect(v.sharePriceE6).toBe(800_000n);
    expect(v.withdrawAtoms).toBe(80_000_000n);
    expect(v.withdrawKind).toBe("impaired");
    expect(v.junior).toBe(0n);
  });
  it("pending (harvestable) fees count: into V AND into C_eff (senior share 100%)", () => {
    const v = earnTrancheView({ ...base, harvestableAtoms: 50_000_000n })!;
    expect(v.seniorClaimEff).toBe(1_050_000_000n);
    expect(v.vaultValue).toBe(1_250_000_000n);
    expect(v.junior).toBe(200_000_000n);
    expect(v.backingCover).toBe(1_050_000_000n);
  });
  it("unreadable fee leg => counted as 0 and labelled", () => {
    const v = earnTrancheView({ ...base, harvestableAtoms: null })!;
    expect(v.excludesUncrankedFees).toBe(true);
    expect(v.harvestable).toBe(0n);
  });
  it("stale LP: covered by backing => senior known (liveness shortcut), junior unknown", () => {
    const v = earnTrancheView({ ...base, lpValue: { kind: "stale" } })!;
    expect(v.valuation).toBe("stale");
    expect(v.senior).toBe(1_000_000_000n);
    expect(v.junior).toBeNull();
    expect(v.impaired).toBe(false);
  });
  it("stale LP and backing short => nothing guessed", () => {
    const v = earnTrancheView({ ...base, backingNavAtoms: 900_000_000n, lpValue: { kind: "stale" }, withdrawShares: 1n })!;
    expect(v.senior).toBeNull();
    expect(v.sharePriceE6).toBeNull();
    expect(v.impaired).toBeNull();
    expect(v.withdrawKind).toBe("stale");
  });
});

describe("rollFeeSnapshots", () => {
  it("accumulates hourly snapshots and reports APY only after 24 h", () => {
    let list: { t: number; seniorFeeCreditedAtoms: bigint; seniorClaimAtoms: bigint }[] = [];
    let apy: number | null = null;
    for (let h = 0; h <= 25; h++) {
      const r = rollFeeSnapshots(list, { t: 1_000_000 + h * 3_600, seniorFeeCreditedAtoms: BigInt(h) * 1_000n, seniorClaimAtoms: 24_000_000n });
      list = r.list;
      apy = r.apyBps;
      if (h < 24) expect(apy).toBeNull();
    }
    expect(list.length).toBe(26);
    // 24,000 atoms/day on 24,000,000 = 0.1%/day = 3650 bps
    expect(apy).toBe(3_650);
  });
  it("does not add a snapshot inside the min gap", () => {
    const r = rollFeeSnapshots([{ t: 100, seniorFeeCreditedAtoms: 0n, seniorClaimAtoms: 1n }], { t: 200, seniorFeeCreditedAtoms: 0n, seniorClaimAtoms: 1n });
    expect(r.list.length).toBe(1);
  });
});

import { vaultSkewRateE9 } from "@/lib/limits/vault-tranche";

describe("vaultSkewRateE9 (vault_lp_skew_rate_e9_view)", () => {
  it("uses max(OI long, OI short); off when unbound or slope 0", () => {
    const v = { bound: true, skewSlopeE9: 1_000n, skewMaxE9: 10_000n, lpNetQ: -250n };
    expect(vaultSkewRateE9(v, 1_000n, 500n)).toBe(250n); // 1000 * 250/1000
    expect(vaultSkewRateE9(v, 500n, 1_000n)).toBe(250n);
    expect(vaultSkewRateE9({ ...v, bound: false }, 1_000n, 500n)).toBe(0n);
    expect(vaultSkewRateE9({ ...v, skewSlopeE9: 0n }, 1_000n, 500n)).toBe(0n);
    expect(vaultSkewRateE9(null, 1_000n, 500n)).toBe(0n);
  });
});

// ── coverage extension: P3 valuation, deposit gate, rounding, zero supply, max-u64 ──────────────
import {
  conservativeEquity,
  earnAbsorbed,
  earnDepositBlock,
  harvestableFeeAtoms,
  joinsCrowd,
  juniorFloorAtoms,
  juniorResolvedSurplusAtoms,
  leverageGateOk,
  seniorSharesForDeposit,
  stepImrBps,
  vaultLpCapQ,
  vaultLpExposureAllowed,
  vaultLpValueAtoms,
  vaultValue,
  type EarnTrancheInput,
} from "@/lib/limits/vault-tranche";

const U64 = (1n << 64n) - 1n;
const U128 = (1n << 128n) - 1n;
const I128 = (1n << 127n) - 1n;

describe("bps rounding direction + max-u64", () => {
  it("floor for the harvest share, ceil for the junior floor", () => {
    expect(effectiveSeniorClaim(0n, U64, 1_000)).toBe(1_844_674_407_370_955_161n); // floor(…161.5)
    expect(juniorFloorAtoms(U64, 1_000)).toBe(1_844_674_407_370_955_162n); // ceil(…161.5)
    expect(juniorFloorAtoms(10_000n, 1_000)).toBe(1_000n); // exact: no round-up
    expect(juniorFloorAtoms(10_001n, 1_000)).toBe(1_001n); // 1000.1 -> 1001
    expect(effectiveSeniorClaim(100n, 19n, 5_000)).toBe(109n); // floor(9.5)=9
  });
  it("bps above 100% fail closed", () => {
    expect(effectiveSeniorClaim(100n, 100n, 10_001)).toBeNull();
    expect(juniorFloorAtoms(100n, 10_001)).toBeNull();
    expect(juniorWithdrawAllowed(1_000n, 100n, 100n, 1n, 10_001)).toBe(false);
    expect(juniorWithdrawableAtoms(1_000n, 100n, 100n, 10_001)).toBe(0n);
  });
  it("vaultValue and tranche split at max u64", () => {
    expect(vaultValue(U64, U64, U64)).toBe(3n * U64);
    expect(trancheSplit(U64, U64)).toEqual({ senior: U64, junior: 0n });
    expect(trancheSplit(0n, U64)).toEqual({ senior: 0n, junior: 0n });
  });
});

describe("share maths: zero supply, rounding, overflow", () => {
  it("genesis deposit is 1:1; zero senior with shares outstanding refuses", () => {
    expect(seniorSharesForDeposit(10n, 0n, 0n)).toBe(10n);
    expect(seniorSharesForDeposit(10n, 0n, 999n)).toBe(10n);
    expect(seniorSharesForDeposit(10n, 5n, 0n)).toBeNull();
  });
  it("deposit shares round DOWN; max u64 stays exact; u128 overflow fails closed", () => {
    expect(seniorSharesForDeposit(7n, 3n, 2n)).toBe(10n); // floor(10.5)
    expect(seniorSharesForDeposit(1n, 1n, 3n)).toBe(0n);
    expect(seniorSharesForDeposit(U64, U64, U64)).toBe(U64);
    expect(seniorSharesForDeposit(U128, 2n, 1n)).toBeNull();
    expect(seniorSharesForDeposit(1n << 100n, 1n << 100n, 1n)).toBeNull();
  });
  it("redemption: zero supply or over-redeem is null; floors; overflow null", () => {
    expect(seniorAtomsForRedemption(0n, 0n, 100n)).toBeNull();
    expect(seniorAtomsForRedemption(4n, 3n, 10n)).toBeNull();
    expect(seniorAtomsForRedemption(0n, 3n, 10n)).toBe(0n);
    expect(seniorAtomsForRedemption(1n, 3n, 10n)).toBe(3n); // floor(3.33)
    expect(seniorAtomsForRedemption(2n, 3n, 10n)).toBe(6n); // floor(6.67)
    expect(seniorAtomsForRedemption(U64, U64, U64)).toBe(U64);
    expect(seniorAtomsForRedemption(1n << 100n, 1n << 100n, 1n << 100n)).toBeNull();
  });
  it("share price floors; zero supply null; cushion clamps at 1,000,000 bps", () => {
    expect(seniorSharePriceE6(1n, 3n)).toBe(333_333n);
    expect(seniorSharePriceE6(5n, 0n)).toBeNull();
    expect(firstLossCushionBps(200n, 1_000n)).toBe(2_000);
    expect(firstLossCushionBps(5n, 0n)).toBeNull();
    expect(firstLossCushionBps(U64, 1n)).toBe(1_000_000);
  });
  it("recallLimit and resolved surplus never go negative", () => {
    expect(recallLimit(100n, 40n)).toBe(60n);
    expect(recallLimit(40n, 100n)).toBe(0n);
    expect(juniorResolvedSurplusAtoms(100n, 40n)).toBe(60n);
    expect(juniorResolvedSurplusAtoms(40n, 100n)).toBe(0n);
    expect(juniorResolvedSurplusAtoms(5n, 5n)).toBe(0n);
    expect(juniorResolvedSurplusAtoms(U64, 0n)).toBe(U64);
  });
  it("senior impaired is strict", () => {
    expect(seniorImpaired(99n, 100n)).toBe(true);
    expect(seniorImpaired(100n, 100n)).toBe(false);
  });
});

describe("conservativeEquity", () => {
  it("only negative pnl / fee credits reduce capital; floors at 0", () => {
    expect(conservativeEquity(100n, 50n, 50n)).toBe(100n);
    expect(conservativeEquity(100n, -30n, -20n)).toBe(50n);
    expect(conservativeEquity(100n, -30n, -80n)).toBe(0n);
    expect(conservativeEquity(0n, 0n, 0n)).toBe(0n);
  });
  it("capital above i128::MAX is null (overflow); i128::MAX is exact", () => {
    expect(conservativeEquity(1n << 127n, 0n, 0n)).toBeNull();
    expect(conservativeEquity(I128, 0n, 0n)).toBe(I128);
    expect(conservativeEquity(I128, -I128, 0n)).toBe(0n);
  });
});

describe("harvestableFeeAtoms", () => {
  const base = {
    lpFeeAccruedAtoms: 300n,
    lpFeeWithdrawnAtoms: 200n,
    insuranceAtoms: 500n,
    sourceInsuranceCreditReservedTotal: 200n,
    insuranceDomainBudgetRemainingTotal: 100n,
    vaultAtoms: 1_000n,
  };
  it("withdrawn > accrued is null (EngineCounterUnderflow)", () => {
    expect(harvestableFeeAtoms({ ...base, lpFeeWithdrawnAtoms: 301n })).toBeNull();
  });
  it("= min(claim, surplus avail, vault)", () => {
    expect(harvestableFeeAtoms(base)).toBe(100n); // claim 100, avail 200
    expect(harvestableFeeAtoms({ ...base, lpFeeAccruedAtoms: 1_000n, lpFeeWithdrawnAtoms: 0n })).toBe(200n); // avail binds
    expect(harvestableFeeAtoms({ ...base, vaultAtoms: 40n })).toBe(40n); // vault binds
    expect(harvestableFeeAtoms({ ...base, lpFeeWithdrawnAtoms: 300n })).toBe(0n); // nothing claimable
  });
  it("saturating subtraction: reserved/budget above insurance => 0", () => {
    expect(harvestableFeeAtoms({ ...base, sourceInsuranceCreditReservedTotal: 600n })).toBe(0n);
    expect(harvestableFeeAtoms({ ...base, insuranceDomainBudgetRemainingTotal: 300n })).toBe(0n);
    expect(harvestableFeeAtoms({ ...base, insuranceDomainBudgetRemainingTotal: 300n, vaultAtoms: 0n })).toBe(0n);
  });
  it("max u64 inputs stay exact", () => {
    expect(
      harvestableFeeAtoms({
        lpFeeAccruedAtoms: U64,
        lpFeeWithdrawnAtoms: 0n,
        insuranceAtoms: U64,
        sourceInsuranceCreditReservedTotal: 0n,
        insuranceDomainBudgetRemainingTotal: 0n,
        vaultAtoms: U64,
      }),
    ).toBe(U64);
  });
});

describe("vaultLpValueAtoms", () => {
  const m = { oracleEpoch: 1n, fundingEpoch: 2n, riskEpoch: 3n, assetSetEpoch: 4n };
  const mk = (over: Record<string, unknown> = {}, cert: Record<string, unknown> = {}) => ({
    capital: 1_000n,
    pnl: -100n,
    feeCredits: -50n,
    activeBitmap: 0n,
    staleState: 0,
    bStaleState: 0,
    cert: {
      certifiedEquity: 777n,
      oracleEpoch: 1n,
      fundingEpoch: 2n,
      riskEpoch: 3n,
      assetSetEpoch: 4n,
      activeBitmapAtCert: 0n,
      validByte: 1,
      ...cert,
    },
    ...over,
  });
  it("a current certificate wins", () => {
    expect(vaultLpValueAtoms(mk(), m)).toEqual({ kind: "certified", atoms: 777n });
    expect(vaultLpValueAtoms(mk({ activeBitmap: 5n }, { activeBitmapAtCert: 5n }), m)).toEqual({ kind: "certified", atoms: 777n });
  });
  it("negative or zero certified equity floors at 0", () => {
    expect(vaultLpValueAtoms(mk({}, { certifiedEquity: -5n }), m)).toEqual({ kind: "certified", atoms: 0n });
    expect(vaultLpValueAtoms(mk({}, { certifiedEquity: 0n }), m)).toEqual({ kind: "certified", atoms: 0n });
  });
  it.each([
    ["staleState", { staleState: 1 }, {}],
    ["bStaleState", { bStaleState: 1 }, {}],
    ["validByte", {}, { validByte: 0 }],
    ["oracleEpoch", {}, { oracleEpoch: 9n }],
    ["fundingEpoch", {}, { fundingEpoch: 9n }],
    ["riskEpoch", {}, { riskEpoch: 9n }],
    ["assetSetEpoch", {}, { assetSetEpoch: 9n }],
    ["bitmap drift", {}, { activeBitmapAtCert: 1n }],
  ])("not current (%s) + flat LP => conservative equity", (_n, over, cert) => {
    expect(vaultLpValueAtoms(mk(over, cert), m)).toEqual({ kind: "flat", atoms: 850n });
  });
  it("not current with an open position => stale", () => {
    expect(vaultLpValueAtoms(mk({ activeBitmap: 1n, staleState: 1 }), m)).toEqual({ kind: "stale" });
    expect(vaultLpValueAtoms(mk({ activeBitmap: 1n }, { activeBitmapAtCert: 0n }), m)).toEqual({ kind: "stale" });
  });
  it("flat but conservative equity overflows => stale", () => {
    expect(vaultLpValueAtoms(mk({ capital: 1n << 127n, staleState: 1 }), m)).toEqual({ kind: "stale" });
  });
});

describe("vaultLpExposureAllowed + vaultLpCapQ", () => {
  it("a fill that does not grow |lp| is always allowed", () => {
    expect(vaultLpExposureAllowed(-2_000_000n, -1_000_000n, 0n, 0, 1_000_000n)).toBe(true);
    expect(vaultLpExposureAllowed(-1_000_000n, -1_000_000n, 0n, 0, 1_000_000n)).toBe(true);
  });
  it("growing: notional <= floor(equity·lev/1e4), boundary exact", () => {
    // |after| 2e6, price 1e6 -> notional 2_000_000
    expect(vaultLpExposureAllowed(0n, -2_000_000n, 1_000_000n, 20_000, 1_000_000n)).toBe(true);
    expect(vaultLpExposureAllowed(0n, 2_000_000n, 1_000_000n, 19_999, 1_000_000n)).toBe(false); // cap 1_999_900
  });
  it("rounds the notional DOWN", () => {
    // notional = floor(1·1_999_999/1e6) = 1 <= cap 1 (a ceil would give 2 and refuse)
    expect(vaultLpExposureAllowed(0n, 1n, 1n, 10_000, 1_999_999n)).toBe(true);
    expect(vaultLpExposureAllowed(0n, 1n, 1n, 10_000, 2_000_000n)).toBe(false); // notional 2 > 1
  });
  it("fails closed on posScale 0 and u128 overflow", () => {
    expect(vaultLpExposureAllowed(0n, 5n, 100n, 10_000, 1n, 0n)).toBe(false);
    expect(vaultLpExposureAllowed(0n, 1n << 100n, 1n << 60n, 10_000, 1n << 100n)).toBe(false); // |after|·price
    expect(vaultLpExposureAllowed(0n, 1n, U128, 2, 1n)).toBe(false); // equity·lev
    expect(vaultLpExposureAllowed(0n, 1n, U128, 0, 1n)).toBe(true); // notional floor(1/1e6)=0 <= cap 0
  });
  it("custom posScale", () => {
    expect(vaultLpExposureAllowed(0n, 10n, 10n, 10_000, 5n, 1n)).toBe(false); // notional 50 > 10
    expect(vaultLpExposureAllowed(0n, 10n, 50n, 10_000, 5n, 1n)).toBe(true);
  });
  it("cap is the exact boundary of the admit rule", () => {
    expect(vaultLpCapQ(1_000_000n, 20_000, 1_000_000n)).toBe(2_000_000n);
    expect(vaultLpCapQ(1_000_000n, 20_000, 3n)).toBe(666_666_999_999n);
    for (const [eq, lev, px] of [
      [1_000_000n, 20_000, 1_000_000n],
      [1_000_000n, 20_000, 3n],
      [12_345n, 7_777, 999_983n],
    ] as const) {
      const cap = vaultLpCapQ(eq, lev, px);
      expect(vaultLpExposureAllowed(0n, cap, eq, lev, px)).toBe(true);
      expect(vaultLpExposureAllowed(0n, cap + 1n, eq, lev, px)).toBe(false);
    }
  });
  it("zero price => 0 (fail closed); zero equity admits only dust", () => {
    expect(vaultLpCapQ(1_000n, 10_000, 0n)).toBe(0n);
    expect(vaultLpCapQ(0n, 10_000, 1_000_000n)).toBe(0n);
  });
});

describe("earnAbsorbed", () => {
  it("null when nothing was ever drawn / fields absent", () => {
    expect(earnAbsorbed({})).toBeNull();
    expect(earnAbsorbed({ seniorDrawnAtoms: 0n, seniorDrawOutstandingAtoms: 0n })).toBeNull();
  });
  it("restored = drawn - outstanding, floored at 0", () => {
    expect(earnAbsorbed({ seniorDrawnAtoms: 100n, seniorDrawOutstandingAtoms: 30n })).toEqual({ outstanding: 30n, drawn: 100n, restored: 70n });
    expect(earnAbsorbed({ seniorDrawnAtoms: 100n, seniorDrawOutstandingAtoms: 100n })).toEqual({ outstanding: 100n, drawn: 100n, restored: 0n });
    expect(earnAbsorbed({ seniorDrawOutstandingAtoms: 50n })).toEqual({ outstanding: 50n, drawn: 0n, restored: 0n });
    expect(earnAbsorbed({ seniorDrawnAtoms: 9n })).toEqual({ outstanding: 0n, drawn: 9n, restored: 9n });
    expect(earnAbsorbed({ seniorDrawnAtoms: U64, seniorDrawOutstandingAtoms: 1n })).toEqual({ outstanding: 1n, drawn: U64, restored: U64 - 1n });
  });
});

describe("earnDepositBlock", () => {
  const inp = (over: Partial<EarnTrancheInput> = {}): EarnTrancheInput => ({
    seniorClaimAtoms: 1_000n,
    juniorFloorBps: 1_000,
    seniorFeeShareBps: 0,
    backingNavAtoms: 1_000n,
    harvestableAtoms: 0n,
    lpValue: { kind: "flat", atoms: 0n },
    totalShares: 1_000n,
    withdrawShares: 0n,
    ...over,
  });
  const gate = (over: Partial<EarnTrancheInput> = {}, shares = 1_000n) => earnDepositBlock(earnTrancheView(inp(over)), shares);
  it("no view => no block", () => {
    expect(earnDepositBlock(null, 0n)).toBeNull();
  });
  it("genesis with harvestable fees => harvest-pending; genesis without => open", () => {
    expect(gate({ harvestableAtoms: 5n }, 0n)).toBe("harvest-pending");
    expect(gate({ harvestableAtoms: 0n }, 0n)).toBeNull();
    expect(gate({ harvestableAtoms: null }, 0n)).toBeNull(); // unreadable counts as 0
  });
  it("covered by backing => open even if stale", () => {
    expect(gate()).toBeNull();
    expect(gate({ lpValue: { kind: "stale" } })).toBeNull();
  });
  it("backing short + stale => valuation-stale", () => {
    expect(gate({ backingNavAtoms: 400n, lpValue: { kind: "stale" } })).toBe("valuation-stale");
  });
  it("backing short + impaired => senior-impaired", () => {
    expect(gate({ backingNavAtoms: 400n, lpValue: { kind: "flat", atoms: 100n } })).toBe("senior-impaired");
  });
  it("backing short but LP covers the senior => open", () => {
    expect(gate({ backingNavAtoms: 400n, lpValue: { kind: "certified", atoms: 700n } })).toBeNull();
  });
  it("harvest-pending takes priority over stale", () => {
    expect(gate({ harvestableAtoms: 5n, backingNavAtoms: 0n, lpValue: { kind: "stale" } }, 0n)).toBe("harvest-pending");
  });
});

describe("earnTrancheView extra branches", () => {
  const inp = (over: Partial<EarnTrancheInput> = {}): EarnTrancheInput => ({
    seniorClaimAtoms: 1_000n,
    juniorFloorBps: 1_000,
    seniorFeeShareBps: 0,
    backingNavAtoms: 1_000n,
    harvestableAtoms: 0n,
    lpValue: { kind: "flat", atoms: 0n },
    totalShares: 1_000n,
    withdrawShares: 0n,
    ...over,
  });
  it("senior-fee-share above 100% => no view", () => {
    expect(earnTrancheView(inp({ seniorFeeShareBps: 10_001, harvestableAtoms: 10n }))).toBeNull();
  });
  it("junior floor bps above 100% degrades the floor to 0 instead of failing", () => {
    expect(earnTrancheView(inp({ juniorFloorBps: 10_001 }))?.juniorFloorAtoms).toBe(0n);
  });
  it("stale + covered, withdrawing: priced at C, share price from C", () => {
    const v = earnTrancheView(inp({ lpValue: { kind: "stale" }, withdrawShares: 250n }))!;
    expect(v.senior).toBe(1_000n);
    expect(v.sharePriceE6).toBe(1_000_000n);
    expect(v.withdrawAtoms).toBe(250n);
    expect(v.withdrawKind).toBe("normal");
    expect(v.impaired).toBe(false);
    expect(v.juniorFloorAtoms).toBe(100n);
  });
  it("stale + covered with zero supply: no share price, withdrawal null", () => {
    const v = earnTrancheView(inp({ lpValue: { kind: "stale" }, totalShares: 0n, withdrawShares: 5n }))!;
    expect(v.sharePriceE6).toBeNull();
    expect(v.withdrawAtoms).toBeNull();
  });
  it("stale + illiquid: withdrawal null even when shares are typed", () => {
    const v = earnTrancheView(inp({ lpValue: { kind: "stale" }, backingNavAtoms: 10n, withdrawShares: 5n }))!;
    expect(v.withdrawAtoms).toBeNull();
    expect(v.withdrawKind).toBe("stale");
    expect(v.impaired).toBeNull();
    expect(v.illiquid).toBe(true);
  });
  it("zero supply (non-stale): no price, no withdrawal quote", () => {
    const v = earnTrancheView(inp({ totalShares: 0n, withdrawShares: 5n }))!;
    expect(v.sharePriceE6).toBeNull();
    expect(v.withdrawAtoms).toBeNull();
  });
  it("max-u64 claim and backing stay exact", () => {
    const v = earnTrancheView(inp({ seniorClaimAtoms: U64, backingNavAtoms: U64, totalShares: U64, withdrawShares: U64 }))!;
    expect(v.senior).toBe(U64);
    expect(v.junior).toBe(0n);
    expect(v.withdrawAtoms).toBe(U64);
    expect(v.juniorFloorAtoms).toBe(1_844_674_407_370_955_162n);
  });
});

describe("step IMR + leverage gate", () => {
  it("clamps crowd into [base, max]", () => {
    expect(stepImrBps(5_000n, 0n, 1_000n, 8_000)).toBe(1_000n); // cap 0
    expect(stepImrBps(5_000n, 10_000n, 9_000n, 8_000)).toBe(9_000n); // max <= base
    expect(stepImrBps(500n, 10_000n, 1_000n, 8_000)).toBe(1_000n); // crowd <= base
    expect(stepImrBps(5_000n, 10_000n, 1_000n, 8_000)).toBe(5_000n); // in range
    expect(stepImrBps(9_000n, 10_000n, 1_000n, 8_000)).toBe(8_000n); // >= max
    expect(stepImrBps(30_000n, 10_000n, 1_000n, 8_000)).toBe(8_000n); // crowd > 100% clamps
    expect(stepImrBps(30_000n, 10_000n, 1_000n, 20_000)).toBe(10_000n); // crowd clamp binds (max above 100%)
  });
  it("joinsCrowd compares absolute inventory", () => {
    expect(joinsCrowd(0n, -5n)).toBe(true);
    expect(joinsCrowd(-5n, 3n)).toBe(false);
    expect(joinsCrowd(-5n, -5n)).toBe(false);
    expect(joinsCrowd(-5n, 6n)).toBe(true);
  });
  it("leverageGateOk uses a ceil requirement and fails closed above 100%", () => {
    expect(leverageGateOk(100n, 1_000n, 1_000n)).toBe(true);
    expect(leverageGateOk(99n, 1_000n, 1_000n)).toBe(false);
    expect(leverageGateOk(100n, 1_001n, 1_000n)).toBe(false); // ceil(100.1)=101
    expect(leverageGateOk(101n, 1_001n, 1_000n)).toBe(true);
    expect(leverageGateOk(U64, 1n, 10_001n)).toBe(false);
    expect(leverageGateOk(0n, 0n, 0n)).toBe(true);
  });
  it("stepDownMaxLeverage with a zero base IMR divides by 1", () => {
    expect(stepDownMaxLeverage(-10n, 10n, false, 100n, 0n, 5_000)).toEqual({ maxLeverage: 10_000, stepped: false, imrBps: 0n });
    expect(stepDownMaxLeverage(0n, 10n, true, 100n, 0n, 5_000)).toEqual({ maxLeverage: 10, stepped: true, imrBps: 1_000n });
    expect(stepDownMaxLeverage(0n, 10n, true, 0n, 0n, 5_000)).toEqual({ maxLeverage: 10_000, stepped: false, imrBps: 0n });
  });
});

describe("skew funding / drift extra branches", () => {
  it("zero guards and cap by oi side", () => {
    expect(skewFundingRateE9(0n, 1_000n, 1_000_000_000n, 1_000_000_000n)).toBe(0n);
    expect(skewFundingRateE9(-5n, 0n, 1_000_000_000n, 1_000_000_000n)).toBe(0n);
    expect(skewFundingRateE9(-5n, 10n, 0n, 1_000_000_000n)).toBe(0n);
    expect(skewFundingRateE9(-5n, 10n, 1_000_000_000n, 0n)).toBe(0n);
    expect(skewFundingRateE9(-500n, 1_000n, 1_000_000_000n, 1_000_000_000n)).toBe(500_000_000n);
    expect(skewFundingRateE9(500n, 1_000n, 1_000_000_000n, 1_000_000_000n)).toBe(-500_000_000n);
    expect(skewFundingRateE9(-2_000n, 1_000n, 1_000_000_000n, 600_000_000n)).toBe(600_000_000n);
    expect(skewFundingRateE9(-2_000n, 1_000n, 1_000_000_000n, 5_000_000_000n)).toBe(1_000_000_000n); // share clamp binds
  });
  it("combine clamps both ways", () => {
    expect(combineFundingRateE9(5n, 3n, 6n)).toBe(6n);
    expect(combineFundingRateE9(-5n, -3n, 6n)).toBe(-6n);
    expect(combineFundingRateE9(1n, 2n, 6n)).toBe(3n);
  });
  it("a short pays when the rate is negative; warn boundary is inclusive", () => {
    expect(fundingPerHourAtoms(-2_000_000n, 1_000_000n, -1_000_000n)).toBe(18_000_000n);
    const d = (margin: bigint) => projectLiqDrift(-2_000_000n, 1_000_000n, -1_000_000n, margin);
    expect(d(0n)).toEqual({ consumedAtoms: 432_000_000n, liqMoveE6: 216_000_000n, warn: true });
    expect(d(10_000_000_000n).warn).toBe(false);
    expect(d(4_320_000_000n).warn).toBe(true); // consumed·1e4 == margin·1000
    expect(d(4_320_000_001n).warn).toBe(false);
  });
  it("zero position / receiving never warns", () => {
    expect(projectLiqDrift(0n, 1_000_000n, 5n, 0n)).toEqual({ consumedAtoms: 0n, liqMoveE6: 0n, warn: false });
    expect(projectLiqDrift(1_000_000n, 1_000_000n, -1_000_000n, 0n).warn).toBe(false);
  });
  it("creator caps treat floor 0 as 1", () => {
    expect(projectCreatorCaps(100n, 10_000, 0)).toEqual({ maxLpNotionalAtoms: 100n, maxSeniorAtoms: 1_000_000n });
  });
});
