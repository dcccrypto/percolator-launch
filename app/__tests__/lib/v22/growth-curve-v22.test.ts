import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { growthMarketView, type GrowthMarketInput } from "@/lib/v21/growth-market";
import { growthUnlockView } from "@/lib/v22/growth-unlock";
import { LAYOUT_V22, WRAPPER_ACCOUNT_MAGIC } from "@/lib/v22/sdk";
import { assetGrowthAccountOffsetV19 } from "@/lib/v22/records";
import { ASSET_GROWTH_FIELD_OFF, DEPTH_EVER, DEPTH_PREV_REAL, DEPTH_SOURCE, curveDepthForLeverageX100, tierThresholdsE6 } from "@/lib/v22/sdk/records/growth-v19";

// App bug 2026-10-29: these pin the PRE-rc23 wrapper deployed on devnet (aca02ba6: no κ / λ caps, round-2 math for legacy records), i.e.
// the ticket with NEXT_PUBLIC_RC23_OPEN_LIMITS=0. The rc23 numbers are pinned in ticket-rc23-open-limits.test.ts.
import { __setRc23OpenLimitsForTest } from "@/lib/v21/growth-market";
beforeEach(() => __setRc23OpenLimitsForTest(false));
afterEach(() => __setRc23OpenLimitsForTest(null));

/**
 * Continuous leverage (percolator-prog feat/v22-continuous-leverage @ e699d7da + the continuous stress cap @ 3198539a): on a market whose growth record the controller wrapper
 * wrote (GROWTH_FLAG_R3_LAYOUT, set from birth), the ticket quotes the log2-interpolated depth curve the program gates on -- 7.5x at
 * $50k on the default 5x / 10x / 20x table, where the step table said 5x. A LEGACY record (flags 0, the round-2 wrapper deployed on
 * devnet today) keeps the round-2 step math that wrapper gates on. Curve values are pinned bit-exactly against the wrapper's own
 * functions in percolator-sdk test/growth-curve-parity.test.ts; here: the app wires the right math to the right record.
 */
const PRICE = 1_000_000n; // $1.00
const USD = 1_000_000n;
const NOW = 5_000_000n;
const BAND = 130;
const GAP = 397; // G(1.3%)

function market(depthUsd: bigint, o: { r3?: boolean; ceil?: number } = {}): Uint8Array {
  const off = assetGrowthAccountOffsetV19(0, LAYOUT_V22);
  const raw = new Uint8Array(off + 400);
  const v = new DataView(raw.buffer);
  v.setBigUint64(0, WRAPPER_ACCOUNT_MAGIC, true);
  v.setUint16(8, LAYOUT_V22.version, true);
  raw[10] = 1;
  const F = ASSET_GROWTH_FIELD_OFF;
  if (o.r3 !== false) raw[off + 39] = 0x03; // controller record: R3 layout + volatility data (variance 0 -> L_vol = L_tier)
  else v.setBigUint64(off, 1_000n * USD, true); // legacy: c_launch at 0..8
  v.setUint32(off + F.lambdaBps, 10_000, true);
  v.setUint16(off + F.lLaunchX100, 500, true);
  v.setUint16(off + F.lTierX100, 2_000, true);
  v.setUint16(off + F.ceilX100, o.ceil ?? 2_000, true);
  v.setUint16(off + F.kinkBps, 5_000, true);
  v.setUint16(off + F.rGapBps, GAP, true);
  raw[off + F.version] = 1;
  raw[off + 44] = DEPTH_SOURCE.OnChainPool | DEPTH_PREV_REAL | DEPTH_EVER;
  for (const [o2, x] of [[56, depthUsd * USD], [64, NOW - 10n], [72, depthUsd * USD], [80, depthUsd * USD], [88, NOW - 10n]] as const) v.setBigUint64(off + o2, x, true);
  raw[off + 46] = 7; // 6-decimal collateral
  return raw;
}

const input = (raw: Uint8Array, capital = 2_000_000n * USD): GrowthMarketInput => ({
  raw,
  engine: { initialMarginBps: 500n, effectivePriceE6: PRICE, oiEffLongQ: 0n, oiEffShortQ: 0n, tradeFeeBaseBps: 30n, maxTradingFeeBps: 630n },
  lp: { capital, pnl: 0n, feeCredits: 0n },
  lpEffectiveQ: 0n,
  bound: true,
  v22: { bandBps: BAND, nowSlot: NOW, drawOutstanding: false, modeLong: 0, modeShort: 0, vol: { liquidationFeeBps: 0n, bandMaxEpochSlots: 600n } },
});

beforeEach(() => __setDevnetV22ForTest(true));
afterEach(() => __setDevnetV22ForTest(null));

describe("continuous leverage on controller (R3) records", () => {
  // stored ceiling 20x: in force = min(stored, target) = the curve target; IMR = ceil(1e6 / ceiling) bps, so the quote is the floor below it
  const cases: [bigint, number, number][] = [
    [40_000n, 669, 668],
    [50_000n, 750, 749],
    [75_000n, 896, 895],
    [200_000n, 1_430, 1_428], // IMR ceil(1e6 / 1430) = 700 bps -> floor(1e6 / 700) = 14.28x
    [300_000n, 1_682, 1_680], // IMR 595 bps -> 16.80x
  ];
  for (const [usd, ceil, maxLev] of cases) {
    it(`$${usd / 1_000n}k pool depth: ceiling ${ceil / 100}x on the curve, quote ${maxLev / 100}x`, () => {
      const v = growthMarketView(input(market(usd)))!;
      expect(v.r2Record).toBeNull();
      expect(v.long.ceilingX100).toBe(ceil);
      expect(v.long.maxLeverageX100).toBe(maxLev);
      expect(v.short.maxLeverageX100).toBe(maxLev);
    });
  }

  it("N_cap follows the LAGGING kappa curve (21b8ccfd M-1): kappa 0.75 at $50k ($37.5k of room), 1.0 at $200k ($200k); never above the step", () => {
    // C_m $2M at lambda 1x never binds here, so N_cap = kappa * depth. 3198539a's leading curve read kappa 1.0 / 1.4306 ($50k / $286.12k).
    const at50 = growthMarketView(input(market(50_000n)))!;
    expect(at50.long.nCapQ).toBe(37_500n * USD);
    const at200 = growthMarketView(input(market(200_000n)))!;
    expect(at200.long.nCapQ).toBe(200_000n * USD);
  });

  it("the unlock line climbs toward the curve: stored 5x at $50k -> next step 6x (ratchet), not 'needs $100k'", () => {
    const view = growthMarketView(input(market(50_000n, { ceil: 500 })))!;
    expect(view.long.ceilingX100).toBe(500);
    const u = growthUnlockView({ view, bandBps: BAND, nowSlot: NOW });
    expect(u.unlock).toMatchObject({ kind: "ratchet", leverageX100: 600 });
  });

  it("a draw outstanding caps on the STEPPED stress cap (21b8ccfd M-2): $200k / $300k read 5x (3198539a's continuous cap read 7.15x / 8.41x)", () => {
    const at = (usd: bigint) => {
      const i = input(market(usd));
      return growthMarketView({ ...i, v22: { ...i.v22!, drawOutstanding: true } })!;
    };
    expect(at(200_000n).long.ceilingX100).toBe(500);
    expect(at(200_000n).long.maxLeverageX100).toBe(500);
    expect(at(300_000n).long.ceilingX100).toBe(500);
    // unstressed the same markets read the curve (14.30x / 16.82x): the cut is the stress cap, not the depth
    expect(growthMarketView(input(market(200_000n)))!.long.ceilingX100).toBe(1_430);
    // real ADL: two tiers down ($300k: launch)
    const i = input(market(300_000n));
    expect(growthMarketView({ ...i, v22: { ...i.v22!, modeShort: 1 } })!.long.ceilingX100).toBe(500);
  });

  it("a record with volatility data and no engine vol config fails closed to launch (never over-quotes)", () => {
    const i = input(market(50_000n));
    const { vol: _vol, ...noVol } = i.v22!;
    const v = growthMarketView({ ...i, v22: noVol })!;
    expect(v.long.ceilingX100).toBe(500);
  });

  it("display helper: the curve first reaches 7.5x a hair under $50k and 10x a hair under $100k (Q.16 log2 truncation)", () => {
    const th = tierThresholdsE6([0, 0, 0], 6);
    expect(curveDepthForLeverageX100(750, th, [500, 500, 1_000, 2_000])).toBe(49_999_642_592n);
    expect(curveDepthForLeverageX100(1_000, th, [500, 500, 1_000, 2_000])).toBe(99_999_285_184n);
  });
});

describe("legacy (flags 0) records keep the round-2 step math of the wrapper that wrote them", () => {
  it("$50k on the round-2 wrapper: tier 1, step 5x (that wrapper refuses 7.5x)", () => {
    const v = growthMarketView(input(market(50_000n, { r3: false })))!;
    expect(v.r2Record).not.toBeNull();
    expect(v.long.ceilingX100).toBe(500);
    expect(v.long.tier).toBe(1);
  });
  it("$200k on the round-2 wrapper: tier 2, step 10x", () => {
    const v = growthMarketView(input(market(200_000n, { r3: false })))!;
    expect(v.long.ceilingX100).toBe(1_000);
  });
});
