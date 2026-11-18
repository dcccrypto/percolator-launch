// @vitest-environment node
/**
 * matcher-quote.ts branch coverage: every primitive and every preTradeQuote cap path, asserting exact
 * integer quote numbers (hand-derived from the v2.rs formulas quoted in each case).
 */
import { describe, it, expect } from "vitest";
import {
  SKEW_REF_MAX_INVENTORY_Q,
  adaptiveFeeBps,
  cpImpactBps,
  inventoryClip,
  isqrt,
  preTradeQuote,
  priceWithTotalBps,
  quoteAdaptive,
  skewIndicatorBps,
  skewNetBps,
  skewPotentialNum,
  volUpdate,
  type AdaptiveQuoteIn,
} from "@/lib/limits/matcher-quote";
import type { MatcherCtxView, V2BlockView } from "@/lib/limits/decode";

const v2: V2BlockView = {
  flags: 1,
  feeLoBps: 10,
  feeHiBps: 80,
  feeColdBps: 10,
  volAMilli: 1000,
  volBDen: 100,
  volAlphaBps: 1000,
  volWarmupLeft: 0,
  volMoveCap10bps: 100,
  volRefSlots: 25,
  thinRebateMultBps: 100,
  skewCapBps: 100,
  rebateCapBps: 50,
  maxMarkAgeSlots: 150,
  observedStaleSlots: 0,
  boundAssetPlus1: 1,
  skewRefInventory: 1_000_000_000n,
  volVarE4: 0n,
  volLastPriceE6: 0n,
  volLastSlot: 0n,
};
const ctx = (over: Partial<MatcherCtxView> = {}): MatcherCtxView => ({
  kind: 2,
  tradingFeeBps: 0,
  baseSpreadBps: 5,
  maxTotalBps: 100,
  impactKBps: 5000,
  liquidityNotionalE6: 1_000_000_000_000n,
  maxFillAbs: 100_000_000_000n,
  inventoryBase: 0n,
  maxInventoryAbs: 0n,
  skewSpreadMultBps: 300,
  v2,
  ...over,
});
const ORACLE = 1_000_000n;

describe("isqrt", () => {
  it("floors the square root", () => {
    expect(isqrt(0n)).toBe(0n);
    expect(isqrt(1n)).toBe(1n);
    expect(isqrt(2n)).toBe(1n);
    expect(isqrt(15n)).toBe(3n);
    expect(isqrt(16n)).toBe(4n);
    expect(isqrt(17n)).toBe(4n);
    expect(isqrt(10n ** 30n)).toBe(10n ** 15n);
    expect(isqrt(10n ** 30n - 1n)).toBe(10n ** 15n - 1n);
  });
});

describe("adaptiveFeeBps", () => {
  it("warming up: the cold fee clamped into [lo, hi]", () => {
    expect(adaptiveFeeBps({ ...v2, volWarmupLeft: 1, feeColdBps: 5 })).toBe(10n);
    expect(adaptiveFeeBps({ ...v2, volWarmupLeft: 1, feeColdBps: 40 })).toBe(40n);
    expect(adaptiveFeeBps({ ...v2, volWarmupLeft: 1, feeColdBps: 200 })).toBe(80n);
  });
  it("hi below lo collapses the band to lo", () => {
    expect(adaptiveFeeBps({ ...v2, feeLoBps: 30, feeHiBps: 10, volVarE4: 10n ** 15n })).toBe(30n);
  });
  it("lo + a*sigma + sigma^2/b, truncating", () => {
    // var=10000 -> sigma=100; lin = 1000*100/100000 = 1; quad = 10000/(100*10000) = 0
    expect(adaptiveFeeBps({ ...v2, volVarE4: 10_000n })).toBe(11n);
    // var=4e8 -> sigma=20000; lin = 200; clamps to hi 80 (check the quad term separately below)
    expect(adaptiveFeeBps({ ...v2, volVarE4: 400_000_000n })).toBe(80n);
    // wide band: var=4e8, hi=1000 -> lin 200 + quad 4e8/(100*1e4)=400 -> 10+200+400
    expect(adaptiveFeeBps({ ...v2, feeHiBps: 1000, volVarE4: 400_000_000n })).toBe(610n);
  });
  it("volBDen 0 disables the quadratic term", () => {
    expect(adaptiveFeeBps({ ...v2, feeHiBps: 1000, volBDen: 0, volVarE4: 400_000_000n })).toBe(210n);
  });
});

describe("cpImpactBps", () => {
  it("zero k or zero notional is free", () => {
    expect(cpImpactBps(100n, 1000n, 0)).toBe(0n);
    expect(cpImpactBps(0n, 1000n, 50)).toBe(0n);
  });
  it("notional at or past depth is infinite (null)", () => {
    expect(cpImpactBps(1000n, 1000n, 50)).toBeNull();
    expect(cpImpactBps(2000n, 1000n, 50)).toBeNull();
  });
  it("rounds up toward the LP", () => {
    expect(cpImpactBps(1n, 4n, 100)).toBe(34n); // 100/3 = 33.33
    expect(cpImpactBps(1n, 3n, 100)).toBe(50n); // 100/2 exact
  });
});

describe("skewPotentialNum", () => {
  it("zero mult, cap or size is 0", () => {
    expect(skewPotentialNum(10n, 0, 100, 1000n)).toBe(0n);
    expect(skewPotentialNum(10n, 300, 0, 1000n)).toBe(0n);
    expect(skewPotentialNum(0n, 300, 100, 1000n)).toBe(0n);
  });
  it("quadratic to the knee (c*ref/m = 333), linear after", () => {
    expect(skewPotentialNum(100n, 300, 100, 1000n)).toBe(3_000_000n);
    expect(skewPotentialNum(333n, 300, 100, 1000n)).toBe(300n * 333n * 333n);
    // x=500: 300*333^2 + 2*1000*100*167
    expect(skewPotentialNum(500n, 300, 100, 1000n)).toBe(33_266_700n + 33_400_000n);
  });
});

describe("skewNetBps", () => {
  const f = (pre: bigint, fill: bigint, lpSells: boolean) => skewNetBps(pre, fill, lpSells, 300, 100, 100, 50, 1000n);
  it("no-op inputs return 0", () => {
    expect(skewNetBps(0n, 0n, true, 300, 100, 100, 50, 1000n)).toBe(0n);
    expect(skewNetBps(0n, 10n, true, 300, 100, 100, 50, 0n)).toBe(0n);
    expect(skewNetBps(0n, 10n, true, 0, 0, 100, 50, 1000n)).toBe(0n);
  });
  it("growing |inventory| pays a ceil'd surcharge", () => {
    // ws(100)=3e6, den=2*1000*100 -> 15
    expect(f(0n, 100n, false)).toBe(15n);
    // LP short growing further (lpSells from 0): same magnitude
    expect(f(0n, 100n, true)).toBe(15n);
  });
  it("reducing |inventory| earns a rebate truncated toward zero", () => {
    expect(f(200n, 100n, true)).toBe(-15n); // (4e6-1e6)/2e5
    expect(f(100n, 1n, true)).toBe(-9n); // 19_900/2_000 = 9.95 -> 9
    expect(f(-200n, 100n, false)).toBe(-15n); // mirror: LP short, taker sells
  });
  it("crossing zero: surcharge on the new side minus the rebate on the old side", () => {
    expect(f(100n, 200n, true)).toBe(5n); // (3e6-1e6)/(2*1000*200)
    expect(f(500n, 600n, true)).toBe(-18n); // (3e6-25e6)/1.2e6 = -18.33 -> -18
    expect(f(-100n, 200n, false)).toBe(5n);
  });
});

describe("priceWithTotalBps", () => {
  it("total over 100% is rejected", () => {
    expect(priceWithTotalBps(ORACLE, 10_001n, true)).toBeNull();
  });
  it("buy rounds up, sell rounds down", () => {
    expect(priceWithTotalBps(1_000_001n, 15n, true)).toBe(1_001_502n); // 1001501.0015
    expect(priceWithTotalBps(1_000_001n, 15n, false)).toBe(998_500n); // 998500.9985
    expect(priceWithTotalBps(ORACLE, 100n, true)).toBe(1_010_000n);
    expect(priceWithTotalBps(ORACLE, 100n, false)).toBe(990_000n);
  });
  it("a zero or u64-overflowing price is null", () => {
    expect(priceWithTotalBps(ORACLE, 10_000n, false)).toBeNull();
    expect(priceWithTotalBps(1n << 64n, 1n, true)).toBeNull();
  });
});

describe("quoteAdaptive", () => {
  const base: AdaptiveQuoteIn = {
    oracleE6: ORACLE,
    fill: 1_000_000_000n,
    takerBuys: true,
    invPre: 0n,
    baseSpreadBps: 5,
    maxTotalBps: 100,
    feeBps: 10n,
    impactKBps: 5000,
    depthE6: 1_000_000_000_000n,
    sMultBps: 300,
    rMultBps: 100,
    skewCapBps: 100,
    rebateCapBps: 50,
    refInv: 1_000_000_000n,
  };
  it("fill 0 returns the zero quote at the oracle", () => {
    expect(quoteAdaptive({ ...base, fill: 0n })).toEqual({
      fill: 0n,
      priceE6: ORACLE,
      totalBps: 0n,
      impactBps: 0n,
      skewBps: 0n,
      clippedByTotal: false,
    });
  });
  it("a request inside max_total fills in full with the exact breakdown", () => {
    // 100 units: impact ceil(5000*1e8/(1e12-1e8)) = 1, skew 15
    const q = quoteAdaptive({ ...base, fill: 100_000_000n })!;
    expect(q).toEqual({ fill: 100_000_000n, priceE6: 1_003_100n, totalBps: 31n, impactBps: 1n, skewBps: 15n, clippedByTotal: false });
  });
  it("a request over max_total is binary-search clipped to the exact boundary fill", () => {
    const q = quoteAdaptive(base)!;
    expect(q).toEqual({ fill: 833_333_333n, priceE6: 1_010_000n, totalBps: 100n, impactBps: 5n, skewBps: 80n, clippedByTotal: true });
    // boundary: the chosen fill is within max_total, one more unit is not
    const gross = (fill: bigint) => {
      const notional = (fill * ORACLE) / 1_000_000n;
      const impact = cpImpactBps(notional, base.depthE6, base.impactKBps)!;
      const skew = skewNetBps(0n, fill, true, 300, 100, 100, 50, base.refInv);
      return 5n + 10n + impact + (skew > 0n ? skew : 0n);
    };
    expect(gross(833_333_333n) <= 100n).toBe(true);
    expect(gross(833_333_334n) > 100n).toBe(true);
  });
  it("maxTotal is capped at 9000 bps", () => {
    const q = quoteAdaptive({ ...base, maxTotalBps: 50_000, baseSpreadBps: 9_500, feeBps: 0n, impactKBps: 0, sMultBps: 0, rMultBps: 0, fill: 100n });
    expect(q).toEqual({ fill: 0n, priceE6: ORACLE, totalBps: 0n, impactBps: 0n, skewBps: 0n, clippedByTotal: true });
  });
  it("zero fillable (base spread alone exceeds max_total) is a clipped zero quote", () => {
    const q = quoteAdaptive({ ...base, baseSpreadBps: 200, feeBps: 0n, impactKBps: 0, fill: 1000n });
    expect(q).toEqual({ fill: 0n, priceE6: ORACLE, totalBps: 0n, impactBps: 0n, skewBps: 0n, clippedByTotal: true });
  });
  it("a request that reduces the LP's inventory is exempt up to |inventory|, priced at the clamp", () => {
    // LP long 20k units, taker buys 50k with max_total 20: exempt fill 20k units; impact ceil(5e3*2e10/(1e12-2e10)) = 103
    const q = quoteAdaptive({ ...base, fill: 50_000_000_000n, invPre: 20_000_000_000n, maxTotalBps: 20 })!;
    expect(q).toEqual({ fill: 20_000_000_000n, priceE6: 1_002_000n, totalBps: 20n, impactBps: 103n, skewBps: -49n, clippedByTotal: true });
    // sell side mirror: LP short, taker sells
    const s = quoteAdaptive({ ...base, takerBuys: false, fill: 50_000_000_000n, invPre: -20_000_000_000n, maxTotalBps: 20 })!;
    expect(s.fill).toBe(20_000_000_000n);
    expect(s.priceE6).toBe(998_000n);
    expect(s.totalBps).toBe(20n);
  });
  it("exempt fill is the request when it is smaller than |inventory|", () => {
    const q = quoteAdaptive({ ...base, fill: 10_000_000_000n, invPre: 20_000_000_000n, maxTotalBps: 20 })!;
    expect(q.fill).toBe(10_000_000_000n);
    expect(q.clippedByTotal).toBe(false);
    // 5 base + 10 fee + impact ceil(5000*1e10/(1e12-1e10)) = 51 + rebate -50 (uncapped, below max_total 20)
    expect(q.impactBps).toBe(51n);
    expect(q.skewBps).toBe(-50n);
    expect(q.totalBps).toBe(16n);
  });
  it("notional at depth reads as infinite impact, then the search finds the largest finite fill, impact capped at 9000", () => {
    const q = quoteAdaptive({ ...base, depthE6: 1000n, fill: 10_000n, maxTotalBps: 20_000 })!;
    // fill 642: impact ceil(5000*642/358) = 8967, skew 1 -> 5+10+8967+1 = 8983
    expect(q).toEqual({ fill: 642n, priceE6: 1_898_300n, totalBps: 8_983n, impactBps: 8_967n, skewBps: 1n, clippedByTotal: true });
  });
  it("a thin-side rebate larger than the other terms floors the total at 0", () => {
    const q = quoteAdaptive({ ...base, invPre: 500_000_000n, fill: 100_000_000n, baseSpreadBps: 0, feeBps: 0n, impactKBps: 0 })!;
    expect(q).toEqual({ fill: 100_000_000n, priceE6: ORACLE, totalBps: 0n, impactBps: 0n, skewBps: -45n, clippedByTotal: false });
  });
  it("a price that rounds to zero is null (program fails the call)", () => {
    const q = quoteAdaptive({ ...base, oracleE6: 1n, takerBuys: false, fill: 1_000_000n, baseSpreadBps: 1, feeBps: 0n, impactKBps: 0, sMultBps: 0, rMultBps: 0 });
    expect(q).toBeNull();
  });
});

describe("inventoryClip", () => {
  it("sell side: LP inventory grows toward +cap", () => {
    expect(inventoryClip(0n, 100n, 150n, false)).toBe(100n);
    expect(inventoryClip(100n, 100n, 5n, false)).toBe(0n);
    expect(inventoryClip(60n, 100n, 150n, false)).toBe(40n);
    expect(inventoryClip(-60n, 100n, 150n, false)).toBe(150n); // lands at +90, inside
    expect(inventoryClip(60n, 100n, 30n, false)).toBe(30n);
  });
  it("buy side: room smaller than the request is returned, larger is not", () => {
    expect(inventoryClip(-60n, 100n, 150n, true)).toBe(40n);
    expect(inventoryClip(-90n, 100n, 5n, true)).toBe(5n);
  });
});

describe("volUpdate", () => {
  const warm = { ...v2, volLastPriceE6: 1_000_000n, volLastSlot: 100n, volWarmupLeft: 3 };
  it("zero price, stale slot, or sub-window dt leave the estimate untouched", () => {
    expect(volUpdate(warm, 0n, 200n)).toBe(warm);
    expect(volUpdate(warm, 1_010_000n, 99n)).toBe(warm);
    expect(volUpdate(warm, 1_010_000n, 124n)).toBe(warm);
  });
  it("first observation seeds last price/slot only", () => {
    expect(volUpdate(v2, 1_000_000n, 7n)).toEqual({ ...v2, volLastPriceE6: 1_000_000n, volLastSlot: 7n });
  });
  it("EWMA step: move 100 bps over one window with alpha 10%", () => {
    // moveBps=100, r2 = 100^2*1e4*25/25 = 1e8, delta = 1e8*1000/1e4 = 1e7
    const n = volUpdate(warm, 1_010_000n, 125n);
    expect(n.volVarE4).toBe(10_000_000n);
    expect(n.volWarmupLeft).toBe(2);
    expect(n.volLastPriceE6).toBe(1_010_000n);
    expect(n.volLastSlot).toBe(125n);
  });
  it("a long gap scales r2 down by refSlots/dt", () => {
    // dt=50 -> r2 = 1e8*25/50 = 5e7 -> delta 5e6
    expect(volUpdate(warm, 1_010_000n, 150n).volVarE4).toBe(5_000_000n);
  });
  it("downward move uses |diff| and falling variance is reduced", () => {
    const n = volUpdate({ ...warm, volVarE4: 5_000_000_000n }, 1_000_000n, 125n);
    // moveBps 0, r2 0: delta = -5e9*1000/1e4 = -5e8
    expect(n.volVarE4).toBe(4_500_000_000n);
    expect(volUpdate(warm, 990_000n, 125n).volVarE4).toBe(10_000_000n);
  });
  it("move and r2 are capped (cap = volMoveCap10bps*10 bps)", () => {
    // 100% move -> moveBps capped to 1000 -> r2 = 1e10 (also r2Max); alpha 10% -> 1e9
    expect(volUpdate(warm, 2_000_000n, 125n).volVarE4).toBe(1_000_000_000n);
    // dt=1 would not pass the window; use refSlots 25 with dt 25 but cap tiny to hit r2Max via refSlots>dt impossible, so check cap 1 -> 10 bps
    expect(volUpdate({ ...warm, volMoveCap10bps: 0 }, 2_000_000n, 125n).volVarE4).toBe(10n * 10n * 10_000n * 1000n / 10_000n);
  });
  it("r2 over r2Max is clamped when refSlots is large relative to dt", () => {
    // refSlots 1000, dt 1000 (window passes): r2 = move^2*1e4; move 1000 -> 1e10 == r2Max (no clamp needed); use refSlots=0 -> 1
    const n = volUpdate({ ...warm, volRefSlots: 0 }, 2_000_000n, 101n);
    // refSlots=1, dt=1: r2 = 1000^2*1e4*1/1 = 1e10; alpha 10% -> 1e9
    expect(n.volVarE4).toBe(1_000_000_000n);
  });
  it("alpha is clamped into [1, 10000] bps", () => {
    expect(volUpdate({ ...warm, volAlphaBps: 0 }, 1_010_000n, 125n).volVarE4).toBe(10_000n); // 1e8*1/1e4
    expect(volUpdate({ ...warm, volAlphaBps: 20_000 }, 1_010_000n, 125n).volVarE4).toBe(100_000_000n);
  });
  it("variance is saturated at u64::MAX and warm-up floors at 0", () => {
    const n = volUpdate({ ...warm, volVarE4: 1n << 70n, volWarmupLeft: 0 }, 1_000_000n, 125n);
    expect(n.volVarE4).toBe(0xffff_ffff_ffff_ffffn);
    expect(n.volWarmupLeft).toBe(0);
  });
});

describe("preTradeQuote cap paths", () => {
  const BIG = SKEW_REF_MAX_INVENTORY_Q;
  it("kind 2 without a v2 block falls back to legacy; maxTotal/band/headroom are reported", () => {
    const q = preTradeQuote(ctx({ v2: null }), ORACLE, 5n, true, { bandBps: 500 })!;
    expect(q.kind).toBe("legacy");
    expect(q.fillQ).toBe(5n);
    expect(q.maxTotalBps).toBe(100); // band above max_total does not raise it
    expect(q.totalBps).toBeNull();
  });
  it("sell side prices below the oracle (rounded toward the LP)", () => {
    const q = preTradeQuote(ctx(), ORACLE, 100_000_000n, false)!;
    expect(q.fillQ).toBe(100_000_000n);
    expect(q.totalBps).toBe(31n);
    expect(q.quotePriceE6).toBe(996_900n);
  });
  it("max_fill 0 is a zero fill; headroom above max_fill changes nothing", () => {
    const z = preTradeQuote(ctx({ maxFillAbs: 0n }), ORACLE, 100n, true)!;
    expect(z.fillQ).toBe(0n);
    expect(z.quotePriceE6).toBeNull();
    const h = preTradeQuote(ctx({ maxFillAbs: 50_000_000n }), ORACLE, 100_000_000n, true, { headroomQ: 10n ** 12n })!;
    expect(h.fillQ).toBe(50_000_000n);
    const h2 = preTradeQuote(ctx({ maxFillAbs: 50_000_000n }), ORACLE, 100_000_000n, true, { headroomQ: 20_000_000n })!;
    expect(h2.fillQ).toBe(20_000_000n);
  });
  it("the ctx max_inventory clips the fill", () => {
    const q = preTradeQuote(ctx({ maxInventoryAbs: 30_000_000n }), ORACLE, 100_000_000n, true)!;
    expect(q.fillQ).toBe(30_000_000n);
  });
  it("CLOSED ext cap (0): flat LP cannot grow; only a fill reducing the LP is allowed, up to flat", () => {
    const ext = { inventoryCapQ: 0n, liquidityNotionalE6: 0n };
    const flat = preTradeQuote(ctx(), ORACLE, 100_000_000n, true, { ext })!;
    expect(flat.fillQ).toBe(0n);
    expect(flat.quotePriceE6).toBeNull();
    // LP long 40 units: a taker BUY reduces it -> room 40
    const long = preTradeQuote(ctx({ inventoryBase: 40_000_000n }), ORACLE, 100_000_000n, true, { ext })!;
    expect(long.fillQ).toBe(40_000_000n);
    // LP short 40: a taker SELL reduces it
    const short = preTradeQuote(ctx({ inventoryBase: -40_000_000n }), ORACLE, 100_000_000n, false, { ext })!;
    expect(short.fillQ).toBe(40_000_000n);
    // LP long 40 but the taker SELLs (grows the LP): no room
    const grow = preTradeQuote(ctx({ inventoryBase: 40_000_000n }), ORACLE, 100_000_000n, false, { ext })!;
    expect(grow.fillQ).toBe(0n);
  });
  it("CLOSED ext cap with the close exemption fills the whole reduction", () => {
    const q = preTradeQuote(ctx(), ORACLE, 100_000_000n, true, { ext: { inventoryCapQ: 0n, liquidityNotionalE6: 0n }, takerReducing: true })!;
    expect(q.fillQ).toBe(100_000_000n);
  });
  it("real ext cap lowers the inventory cap and the skew reference", () => {
    const ext = { inventoryCapQ: 50_000_000n, liquidityNotionalE6: 0n };
    const q = preTradeQuote(ctx(), ORACLE, 100_000_000n, true, { ext })!;
    expect(q.fillQ).toBe(50_000_000n);
    // skew ref = 50e6: 0 -> 50e6, knee = 100*50e6/300 = 16_666_666; mid-way above the knee
    expect(q.skewBps).toBe(skewNetBps(0n, 50_000_000n, true, 300, 100, 100, 50, 50_000_000n));
    // a ctx cap tighter than the ext cap wins; ext tighter than ctx wins
    expect(preTradeQuote(ctx({ maxInventoryAbs: 30_000_000n }), ORACLE, 100_000_000n, true, { ext })!.fillQ).toBe(30_000_000n);
    expect(preTradeQuote(ctx({ maxInventoryAbs: 80_000_000n }), ORACLE, 100_000_000n, true, { ext })!.fillQ).toBe(50_000_000n);
  });
  it("close exemption keeps the ctx inventory cap off the leg but still caps the skew reference", () => {
    const ext = { inventoryCapQ: 50_000_000n, liquidityNotionalE6: 0n };
    const q = preTradeQuote(ctx(), ORACLE, 100_000_000n, true, { ext, takerReducing: true })!;
    expect(q.fillQ).toBe(100_000_000n);
    // the exemption overrides fill/price/total only; the skew shown is the clipped-fill breakdown (ref 50e6, not 1e9)
    expect(q.skewBps).toBe(84n);
    expect(q.totalBps).toBe(100n);
    expect(q.clippedByTotal).toBe(true);
  });
  it("an ext cap at the neutral value is not a cap", () => {
    const q = preTradeQuote(ctx(), ORACLE, 100_000_000n, true, { ext: { inventoryCapQ: BIG, liquidityNotionalE6: 0n } })!;
    expect(q.fillQ).toBe(100_000_000n);
    expect(q.skewBps).toBe(15n);
  });
  it("ext depth: smaller wins, bigger or zero keeps the ctx depth", () => {
    const wide = ctx({ maxTotalBps: 9_000 });
    const thin = preTradeQuote(wide, ORACLE, 100_000_000n, true, { ext: { inventoryCapQ: BIG, liquidityNotionalE6: 1_000_000_000n } })!;
    // notional 1e8 vs depth 1e9: ceil(5000*1e8/9e8) = 556; total 5+10+556+15
    expect(thin.impactBps).toBe(556n);
    expect(thin.totalBps).toBe(586n);
    const big = preTradeQuote(wide, ORACLE, 100_000_000n, true, { ext: { inventoryCapQ: BIG, liquidityNotionalE6: 10n ** 15n } })!;
    expect(big.impactBps).toBe(1n);
    const zero = preTradeQuote(wide, ORACLE, 100_000_000n, true, { ext: { inventoryCapQ: BIG, liquidityNotionalE6: 0n } })!;
    expect(zero.impactBps).toBe(1n);
  });
  it("skew reference cap above u64 saturates (no lowering)", () => {
    // cap above u64::MAX but below the ctx reference? reference is 1e9 so it stays 1e9
    const q = preTradeQuote(ctx({ v2: { ...v2, skewRefInventory: 1n << 70n } }), ORACLE, 100_000_000n, true, {
      ext: { inventoryCapQ: (1n << 66n) , liquidityNotionalE6: 0n },
    })!;
    expect(q.fillQ).toBe(100_000_000n);
  });
  it("close-exempt reduction clipped by max_total is filled in full at the clamp price", () => {
    const ext = { inventoryCapQ: BIG, liquidityNotionalE6: 0n };
    const q = preTradeQuote(ctx(), ORACLE, 50_000_000_000n, true, { ext, takerReducing: true, bandBps: 40 })!;
    expect(q.fillQ).toBe(50_000_000_000n);
    expect(q.totalBps).toBe(40n);
    expect(q.quotePriceE6).toBe(1_004_000n);
    expect(q.clippedByTotal).toBe(true);
    expect(q.maxTotalBps).toBe(40);
  });
  it("an unpriceable quote makes the whole pre-trade quote null", () => {
    expect(preTradeQuote(ctx({ baseSpreadBps: 1, v2: { ...v2, feeLoBps: 0, feeHiBps: 0, feeColdBps: 0 }, impactKBps: 0, skewSpreadMultBps: 0 }), 1n, 1_000_000n, false)).toBeNull();
  });
  it("nowSlot folds the current price into the volatility estimate before the fee", () => {
    const warm = { ...v2, volLastPriceE6: 1_000_000n, volLastSlot: 100n, volWarmupLeft: 2, feeColdBps: 40 };
    const stored = preTradeQuote(ctx({ v2: warm }), ORACLE, 1_000_000n, true)!;
    expect(stored.feeCold).toBe(true);
    expect(stored.adaptiveFeeBps).toBe(40n);
    const after = preTradeQuote(ctx({ v2: warm }), 1_010_000n, 1_000_000n, true, { nowSlot: 125n })!;
    expect(after.feeCold).toBe(true); // 2 -> 1 still warming
    const done = preTradeQuote(ctx({ v2: { ...warm, volWarmupLeft: 1 } }), 1_010_000n, 1_000_000n, true, { nowSlot: 125n })!;
    // warm-up finished, var = 1e7 -> sigma 3162 -> lin 31, quad 1e7/(100*1e4)=10 -> 10+31+10 = 51
    expect(done.feeCold).toBe(false);
    expect(done.adaptiveFeeBps).toBe(51n);
  });
});

describe("skewIndicatorBps", () => {
  it("caps at -100% too and truncates", () => {
    expect(skewIndicatorBps(-5_000n, 1_000n)).toBe(-10_000);
    expect(skewIndicatorBps(1n, 3n)).toBe(3_333);
  });
});
