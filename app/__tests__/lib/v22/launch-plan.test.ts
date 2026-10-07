// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Keypair, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  DEFAULT_BOND,
  DEFAULT_RENT,
  LOT_PRICE_CEILING_E6,
  holdingFeePctPerDay,
  isMemecoinPreset,
  lotTooltip,
  planLaunchV22,
  toLaunchParams,
  type LaunchPlanInput,
} from "@/lib/v22/launch-plan";
import {
  LOT_PRICE_FLOOR_E6_V22,
  LaunchBundleTooLargeError,
  buildCreateLpPortfolioIxV22,
  buildLaunchBundleV22,
  bandDefaultsV22,
  encodeInitBondTrancheV22,
  forcedRecoveryMinutesV22,
  IX_TAG_V22,
} from "@/lib/v22/sdk";
import { V22_COPY } from "@/lib/v22/copy";
import { __setLotMarketsEnabledForTest } from "@/lib/v22/lot";
// Lot markets are only creatable once every trade surface is lot-aware (review F3); these tests exercise the lot path itself.
__setLotMarketsEnabledForTest(true);

const base = (over: Partial<LaunchPlanInput> = {}): LaunchPlanInput => ({
  tokenPriceE6: 400n,
  collateralDecimals: 6,
  oracleMode: "keeper",
  growthOn: true,
  ...over,
});

describe("lot size is automatic and never below the $10 per-lot floor", () => {
  const prices: bigint[] = [1n, 7n, 400n, 12_345n, 999_999n, 1_000_000n, 9_999_999n, 10_000_000n, 54_000_000n, 1_000_000_000n, 100_000_000_000n];
  for (const p of prices) {
    it(`token price e6=${p}: per-lot price >= $10 and the smallest exponent that gets there`, () => {
      const plan = planLaunchV22(base({ tokenPriceE6: p }));
      expect(plan.available).toBe(true);
      expect(plan.perLotPriceE6).toBe(p * 10n ** BigInt(plan.lotExp));
      expect(plan.perLotPriceE6 >= LOT_PRICE_FLOOR_E6_V22).toBe(true);
      if (plan.perLotPriceE6 <= LOT_PRICE_CEILING_E6) expect(plan.issues.find((x) => x.code === "price-ceiling")).toBeUndefined();
      if (plan.lotExp > 0) expect(p * 10n ** BigInt(plan.lotExp - 1) < LOT_PRICE_FLOOR_E6_V22).toBe(true);
    });
  }
  it("NEGATIVE CONTROL: a price whose lot would exceed $10,000 per lot gets the ceiling refusal, not a silent launch", () => {
    const plan = planLaunchV22(base({ tokenPriceE6: 100_000_000_000n }));
    expect(plan.issues.map((i) => i.code)).toContain("price-ceiling");
    expect(plan.issues[0]!.message).toBe(V22_COPY.wizard.priceCeiling("$10,000"));
    expect(toLaunchParams(plan)).toBeUndefined();
    // control: a price inside the window has no issue and yields params
    expect(toLaunchParams(planLaunchV22(base({ tokenPriceE6: 54_000_000n })))).toBeDefined();
  });
  it("unknown price: the clear one-liner, no params", () => {
    const plan = planLaunchV22(base({ tokenPriceE6: 0n }));
    expect(plan.issues[0]).toEqual({ code: "price-unknown", message: V22_COPY.wizard.priceUnknown });
    expect(toLaunchParams(plan)).toBeUndefined();
  });
  it("the smallest representable price still reaches the floor with an exponent in range", () => {
    expect(planLaunchV22(base({ tokenPriceE6: 1n })).lotExp).toBe(7);
  });
  it("the user never sees the exponent: no issue / note / tooltip text carries protocol names", () => {
    const plan = planLaunchV22(base());
    const text = [...plan.notes, ...plan.issues.map((i) => i.message), lotTooltip(plan.lotExp, "TOK") ?? ""].join(" ");
    expect(text).not.toMatch(/lot_?exp|kink|band_bps|tag \d+/i);
  });
  it("the tooltip is quiet: only when a lot is bigger than one token", () => {
    expect(lotTooltip(0, "TOK")).toBeNull();
    expect(lotTooltip(5, "TOK")).toBe("1 lot = 100,000 TOK");
  });
});

describe("v2.2 options exist only where the program accepts them", () => {
  it("growth block off: nothing", () => {
    expect(planLaunchV22(base({ growthOn: false })).available).toBe(false);
  });
  it("hyperp (EWMA) mark: no lot / band / rent; a sub-$10 token gets the clear refusal because the growth floor still applies", () => {
    const low = planLaunchV22(base({ oracleMode: "hyperp", tokenPriceE6: 400n }));
    expect(low.available).toBe(false);
    expect(low.issues[0]!.message).toBe(V22_COPY.wizard.priceFloorNoLot);
    const ok = planLaunchV22(base({ oracleMode: "hyperp", tokenPriceE6: 12_000_000n }));
    expect(ok.issues).toHaveLength(0);
    expect(toLaunchParams(ok)).toBeUndefined();
  });
  it("pyth: nothing", () => expect(planLaunchV22(base({ oracleMode: "pyth" })).available).toBe(false));
});

describe("price protection and holding fee presets", () => {
  it("memecoin (keeper-priced) preset: both ON by default; admin oracle: both OFF", () => {
    expect(isMemecoinPreset("keeper")).toBe(true);
    const k = planLaunchV22(base());
    expect([k.protection, k.holdingFee]).toEqual([true, true]);
    const a = planLaunchV22(base({ oracleMode: "admin" }));
    expect([a.protection, a.holdingFee]).toEqual([false, false]);
    expect(a.band).toBeUndefined();
    expect(a.rent).toBeUndefined();
  });
  it("defaults are E=600, Pmax=9000, minimum leg 100 whole tokens, and the recovery line is 64 minutes", () => {
    const p = planLaunchV22(base({ tokenPriceE6: 5_000_000n }));
    expect(p.band).toEqual({ bandBps: 130, bandMaxEpochSlots: 600, bandMaxPinSlots: 9_000, bandMinLegNotional: 100_000_000n });
    expect(p.recoveryMinutes).toBe(Math.round(forcedRecoveryMinutesV22(p.band!)));
    expect(p.recoveryMinutes).toBe(64);
    expect(p.minPositionTokens).toBe(100);
    expect(p.notes).toContain(V22_COPY.wizard.recovery(64));
    expect(p.notes.join(" ")).toContain("Minimum position size $100.");
  });
  it("collateral decimals scale the minimum leg (9 decimals -> 100e9 atoms)", () => {
    expect(planLaunchV22(base({ collateralDecimals: 9 })).band!.bandMinLegNotional).toBe(100_000_000_000n);
  });
  it("band only (no holding fee) still sends a zero-rent block, because the grammar is [rent [band]]", () => {
    const p = planLaunchV22(base({ holdingFee: false }));
    expect(p.rent).toEqual({ rentMaxE9PerSlot: 0, rentKinkBps: 0 });
    expect(p.band).toBeDefined();
  });
  it("holding fee only: rent block, no band", () => {
    const p = planLaunchV22(base({ protection: false }));
    expect(p.rent).toEqual({ ...DEFAULT_RENT });
    expect(p.band).toBeUndefined();
  });
  it("rent default satisfies the program rule (>= 10, kink <= 80%) and reads as about 0.5% per day", () => {
    expect(DEFAULT_RENT.rentMaxE9PerSlot).toBeGreaterThanOrEqual(10);
    expect(DEFAULT_RENT.rentKinkBps).toBeLessThanOrEqual(8_000);
    expect(holdingFeePctPerDay(DEFAULT_RENT)).toBe("0.50%");
  });
  it("params carry lot, rent and band into InitMarket", () => {
    const p = planLaunchV22(base());
    const params = toLaunchParams(p)!;
    expect(params.lotExp).toBe(p.lotExp);
    expect(params.band).toEqual(bandDefaultsV22(6));
    expect(params.bond).toBeUndefined();
  });
});

describe("capacity bond at launch", () => {
  it("off by default; on adds validated dials; honest copy", () => {
    expect(planLaunchV22(base()).bond).toBe(false);
    const p = planLaunchV22(base({ bond: true }));
    expect(p.bondArgs).toEqual({ ...DEFAULT_BOND });
    expect(toLaunchParams(p)!.bond).toEqual({ ...DEFAULT_BOND });
    expect(V22_COPY.bond.absorbs).toBe("Losses come after the creator's first-loss stake and before Earn.");
    expect(V22_COPY.bond.coupon).toMatch(/fees and is capped/);
    expect(V22_COPY.bond.exit).toMatch(/flat/);
  });
  it("NEGATIVE CONTROL: dials the program would refuse become an issue and no params", () => {
    for (const bad of [{ ...DEFAULT_BOND, utilBonusBps: 1 }, { ...DEFAULT_BOND, cooldownSlots: 8_999 }, { ...DEFAULT_BOND, couponBps: 2_001 }, { ...DEFAULT_BOND, capBps: 5_001 }]) {
      const p = planLaunchV22(base({ bond: true, bondDials: bad }));
      expect(p.issues.map((i) => i.code)).toContain("bond-invalid");
      expect(toLaunchParams(p)).toBeUndefined();
      expect(() => encodeInitBondTrancheV22(bad)).toThrow();
    }
  });
  it("the SDK's 74 + 94 + 107 bundle is ONE transaction in that order; a wrong tag or too large is refused, never split", () => {
    const payer = Keypair.generate().publicKey;
    const prog = Keypair.generate().publicKey;
    const k = () => Keypair.generate().publicKey;
    const wix = (tag: number, n = 3) =>
      new TransactionInstruction({
        programId: prog,
        keys: Array.from({ length: n }, () => ({ pubkey: k(), isSigner: false, isWritable: true })),
        data: Buffer.from([tag, ...encodeInitBondTrancheV22(DEFAULT_BOND).slice(1)]),
      });
    const portfolio = buildCreateLpPortfolioIxV22(payer, k(), 1, prog);
    const plan = buildLaunchBundleV22({ payer, createAccounts: [portfolio], createVaultLp: wix(74), initVaultLp: wix(94), initBondTranche: wix(IX_TAG_V22.InitBondTranche), supportsV1: true });
    expect(plan.instructions.slice(-3).map((i) => i.data[0])).toEqual([74, 94, 107]);
    expect(plan.bytes).toBeLessThanOrEqual(plan.limit);
    // NEGATIVE CONTROL: the wrong tag in the 107 slot is refused
    expect(() => buildLaunchBundleV22({ payer, createAccounts: [portfolio], createVaultLp: wix(74), initVaultLp: wix(94), initBondTranche: wix(94), supportsV1: true })).toThrow(/tag 107/);
    // Oversize -> LaunchBundleTooLargeError (never a split)
    const big = (tag: number) => wix(tag, 40);
    expect(() =>
      buildLaunchBundleV22({ payer, createAccounts: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: k(), lamports: 1 })], createVaultLp: big(74), initVaultLp: big(94), initBondTranche: big(107), supportsV1: false }),
    ).toThrow(LaunchBundleTooLargeError);
  });
});

describe("F3: lot markets are refused until every surface is lot-aware", () => {
  it("a sub-$10 token is refused with the calm line while lot markets are disabled; a $10+ token is untouched", () => {
    __setLotMarketsEnabledForTest(false);
    try {
      const small = planLaunchV22({ tokenPriceE6: 400n, collateralDecimals: 6, oracleMode: "keeper", growthOn: true });
      expect(small.issues[0]?.message).toMatch(/under \$10/);
      expect(small.lotExp).toBe(0);
      const big = planLaunchV22({ tokenPriceE6: 25_000_000n, collateralDecimals: 6, oracleMode: "keeper", growthOn: true });
      expect(big.issues).toEqual([]);
    } finally {
      __setLotMarketsEnabledForTest(true);
    }
  });
});
