// @vitest-environment node
import { describe, it, expect } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { encodeInitMarket } from "@percolatorct/sdk";
import {
  GROWTH_FEE_HEADROOM_BPS, GROWTH_SEED_ORDER, defaultGrowthLaunch, encodeInitMarketData, fundingE9PerSlotFor, fundingPctPerHour,
  growthMaxTradingFeeBps, growthTierX100, minJuniorAtoms, rGapRange, validateGrowthLaunch, withGrowthInitArgs, type GrowthLaunchInput,
} from "@/lib/v21/growth-launch";
import { buildV17InitMarketArgs } from "@/lib/create-market-args";
import { deriveLaunchMarketParams } from "@/lib/market-params";
import { buildP3BindIxs } from "@/lib/limits/p3-wizard";
import { buildM1Instructions } from "@/lib/create-market-m1";

const derived = deriveLaunchMarketParams({ initialMarginBps: 1000, lpCollateral: 0n, initialPriceE6: 1_000_000n }); // 10x
const params = { p3: {}, initialPriceE6: 1_000_000n, tradingFeeBps: 30 };
const base = (over: Partial<GrowthLaunchInput> = {}): GrowthLaunchInput => ({
  engineImrBps: derived.initialMarginBps,
  maintenanceMarginBps: derived.maintenanceMarginBps,
  maxPriceMoveBpsPerSlot: derived.maxPriceMoveBpsPerSlot,
  baseFeeBps: 30,
  juniorAtoms: 5_000_000n,
  collateralDecimals: 6,
  singleAsset: true,
  ...over,
});

describe("defaults", () => {
  it("funding: about 0.10%/h is 111 e9 per slot, and round-trips", () => {
    expect(fundingE9PerSlotFor(0.1)).toBe(111n);
    expect(fundingPctPerHour(111n)).toBeCloseTo(0.1, 2);
    expect(fundingE9PerSlotFor(0)).toBe(0n);
    expect(fundingE9PerSlotFor(-1)).toBe(0n);
    expect(fundingE9PerSlotFor(1e-12)).toBe(1n); // never rounds a positive ceiling down to "off"
  });
  it("tier is floor(1e6 / IMR); the fee cap is base + 600", () => {
    expect(growthTierX100(1000)).toBe(1000);
    expect(growthTierX100(1819)).toBe(549);
    expect(growthMaxTradingFeeBps(30)).toBe(630n);
    expect(GROWTH_FEE_HEADROOM_BPS).toBe(600n);
  });
  it("r_gap range: floor = move x 50, ceiling = MMR - 50; the default is the floor", () => {
    const r = rGapRange({ maxPriceMoveBpsPerSlot: 4, maintenanceMarginBps: 500 });
    expect(r).toEqual({ min: 200, max: 450, feasible: true });
    expect(rGapRange({ maxPriceMoveBpsPerSlot: 15, maintenanceMarginBps: 500 }).feasible).toBe(false);
    const d = defaultGrowthLaunch(base());
    expect(d.rGapBps).toBe(200);
    expect(d.lLaunchX100).toBe(500);
    expect(d.maxAbsFundingE9PerSlot).toBe(111n);
    expect(d.maxTradingFeeBps).toBe(630n);
  });
  it("the starting leverage never defaults above the tier", () => {
    expect(defaultGrowthLaunch(base({ engineImrBps: 5_000 })).lLaunchX100).toBe(200);
  });
});

describe("validateGrowthLaunch mirrors the wrapper's refusals (94)", () => {
  it("accepts the defaults", () => expect(validateGrowthLaunch(base())).toBeNull());
  it("leverage must be in [1x, tier]", () => {
    expect(validateGrowthLaunch(base({ lLaunchX100: 99 }))).toBe("leverage-out-of-range");
    expect(validateGrowthLaunch(base({ lLaunchX100: 1001 }))).toBe("leverage-out-of-range");
    expect(validateGrowthLaunch(base({ lLaunchX100: 100 }))).toBeNull();
    expect(validateGrowthLaunch(base({ lLaunchX100: 1000 }))).toBeNull();
  });
  it("r_gap must be within [move x 50, MMR - liq fee]", () => {
    expect(validateGrowthLaunch(base({ rGapBps: 199 }))).toBe("r-gap-out-of-range");
    expect(validateGrowthLaunch(base({ rGapBps: 451 }))).toBe("r-gap-out-of-range");
    expect(validateGrowthLaunch(base({ rGapBps: 450 }))).toBeNull();
    expect(validateGrowthLaunch(base({ rGapBps: 1 }))).toBe("r-gap-out-of-range"); // the L-2 finding
  });
  it("funding ceiling must be above zero; the fee cap must leave base + 600", () => {
    expect(validateGrowthLaunch(base({ maxAbsFundingE9PerSlot: 0n }))).toBe("funding-zero");
    expect(validateGrowthLaunch(base({ maxTradingFeeBps: 629n }))).toBe("fee-cap-too-low");
    expect(validateGrowthLaunch(base({ maxTradingFeeBps: 630n }))).toBeNull();
  });
  it("junior deposit is at least $1, and the market must be single-asset", () => {
    expect(minJuniorAtoms(6)).toBe(1_000_000n);
    expect(validateGrowthLaunch(base({ juniorAtoms: 999_999n }))).toBe("junior-below-minimum");
    expect(validateGrowthLaunch(base({ juniorAtoms: 1_000_000n }))).toBeNull();
    expect(validateGrowthLaunch(base({ singleAsset: false }))).toBe("not-single-asset");
  });
});

describe("wire: no growth => byte-for-byte today's InitMarket and bind", () => {
  const legacyArgs = buildV17InitMarketArgs(params, derived);
  it("InitMarket args are unchanged without a growth block", () => {
    expect(buildV17InitMarketArgs(params, derived)).toEqual(legacyArgs);
    expect(legacyArgs.maxTradingFeeBps).toBe("30");
    expect(legacyArgs.maxAbsFundingE9PerSlot).toBe("0");
    expect(withGrowthInitArgs(legacyArgs, undefined)).toBe(legacyArgs);
  });
  it("a growth block sets maxTradingFeeBps = base + 600 and a funding ceiling > 0", () => {
    const g = defaultGrowthLaunch(base());
    const a = buildV17InitMarketArgs({ ...params, growth: g }, derived);
    expect(a.maxTradingFeeBps).toBe("630");
    expect(a.tradeFeeBaseBps).toBe("30");
    expect(BigInt(a.maxAbsFundingE9PerSlot)).toBeGreaterThan(0n);
    expect(a.maxAbsFundingE9PerSlot).toBe("111");
  });
  it("InitMarket data: legacy bytes, then (r_gap u16, l_launch u16) only with growth", () => {
    const g = defaultGrowthLaunch(base());
    const a = buildV17InitMarketArgs({ ...params, growth: g }, derived);
    const legacy = encodeInitMarket(a);
    expect(Buffer.from(encodeInitMarketData(legacyArgs, undefined))).toEqual(Buffer.from(encodeInitMarket(legacyArgs)));
    const withG = encodeInitMarketData(a, g);
    expect(withG.length).toBe(legacy.length + 4);
    expect(Buffer.from(withG.subarray(0, legacy.length))).toEqual(Buffer.from(legacy));
    const dv = new DataView(withG.buffer, withG.byteOffset, withG.byteLength);
    expect(dv.getUint16(legacy.length, true)).toBe(g.rGapBps);
    expect(dv.getUint16(legacy.length + 2, true)).toBe(g.lLaunchX100);
  });
  it("the SDK refuses an r_gap below the floor before anything is signed", () => {
    const g = { ...defaultGrowthLaunch(base()), rGapBps: 100 };
    expect(() => encodeInitMarketData(buildV17InitMarketArgs({ ...params, growth: g }, derived), g)).toThrow(/floor/);
  });
});

describe("seed order: single-asset P3 bind, junior after the vault, in the right place", () => {
  const k = () => Keypair.generate().publicKey;
  const PROG = k();
  const MARKET = k();
  const mk = (growth?: { lLaunchX100: number }) =>
    buildP3BindIxs({
      market: { programId: PROG, market: MARKET, registry: k(), vaultLpState: k(), lpPortfolio: new PublicKey("11111111111111111111111111111112"), ledger: k(), siblingLedger: k() },
      creator: k(),
      vaultLpPortfolio: new PublicKey("11111111111111111111111111111112"),
      portfolioLen: 100,
      portfolioRentLamports: 1,
      matcherProgram: k(),
      matcherCtx: k(),
      matcherCtxRentLamports: 1,
      juniorFloorBps: 2000,
      juniorAtoms: 5_000_000n,
      creatorAta: k(),
      vaultToken: k(),
      ...(growth ? { growth } : {}),
    });
  it("94 (with l_launch) runs before 96, and legacy 94 is the 3-byte form", () => {
    const g = mk({ lLaunchX100: 550 });
    const tags = g.map((i) => i.data[0]);
    expect(tags.slice(-2)).toEqual([94, 96]);
    expect(Buffer.from(g[2].data)).toEqual(Buffer.from([94, 0xd0, 0x07, 0x26, 0x02])); // 2000 bps floor, 550 launch
    expect(mk().map((i) => i.data.length)[2]).toBe(3);
    expect(Buffer.from(mk()[2].data)).toEqual(Buffer.from([94, 0xd0, 0x07]));
  });
  it("the documented seed order puts the bind after the Earn seed and before StakeInitPool", () => {
    const o = [...GROWTH_SEED_ORDER];
    expect(o.indexOf("init-market")).toBe(0);
    expect(o.indexOf("create-lp-vault")).toBeLessThan(o.indexOf("earn-seed"));
    expect(o.indexOf("earn-seed")).toBeLessThan(o.indexOf("init-vault-lp"));
    expect(o.indexOf("init-vault-lp")).toBeLessThan(o.indexOf("deposit-junior"));
    expect(o.indexOf("deposit-junior")).toBeLessThan(o.indexOf("stake-init-pool"));
  });
  it("M1 carries the growth trailer only when asked", () => {
    const g = defaultGrowthLaunch(base());
    const args = buildV17InitMarketArgs({ ...params, growth: g }, derived);
    const m1 = (growth?: typeof g) =>
      buildM1Instructions({ programId: PROG, wallet: k(), slab: k(), mint: k(), vaultAta: k(), vaultPda: k(), nftRegistry: k(), slabRent: 1, slabSize: 100, initArgs: args, ...(growth ? { growth } : {}) } as never);
    const lenWith = m1(g).find((i) => i.programId.equals(PROG) && i.data[0] === 0)!.data.length;
    const lenWithout = m1().find((i) => i.programId.equals(PROG) && i.data[0] === 0)!.data.length;
    expect(lenWith - lenWithout).toBe(4);
  });
});
