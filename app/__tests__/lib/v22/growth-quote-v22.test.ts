import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { growthMarketView, type GrowthMarketInput } from "@/lib/v21/growth-market";
import { ASSET_GROWTH_FIELD_OFF, nCapQ } from "@/lib/v21/sdk";
import { LAYOUT_V22, WRAPPER_ACCOUNT_MAGIC } from "@/lib/v22/sdk";
import { assetGrowthAccountOffsetV19 } from "@/lib/v22/records";
import { DEPTH_EVER, DEPTH_PREV_REAL } from "@/lib/v22/sdk/records/growth-v19";

/**
 * R2.1 quote semantics on a BAND market (the depth rules only apply where the epoch clamp is enforced): fresh depth caps capacity at
 * kappa x depth; once a reading has been seen the cap never switches off (sticky, halving each hour); a real zero reading caps at 0;
 * the tier is min(pool-depth tier, market-backing tier). Upgrade simulation 2026-10-14 finding 4 is the $400 case.
 */
const PRICE = 11_489_000n; // $11.489
const USD = 1_000_000n;
const NOW = 5_000_000n;
const BAND = 130;
const GAP = 397; // G(1.3%)

interface Depth { source: number; usd: bigint; prevUsd: bigint; slot: bigint; ever?: boolean; lastGoodUsd?: bigint; lastGoodSlot?: bigint }

function market(depth: Depth | null, o: { ceil?: number; launch?: number } = {}): Uint8Array {
  const off = assetGrowthAccountOffsetV19(0, LAYOUT_V22);
  const raw = new Uint8Array(off + 400);
  const v = new DataView(raw.buffer);
  v.setBigUint64(0, WRAPPER_ACCOUNT_MAGIC, true);
  v.setUint16(8, LAYOUT_V22.version, true);
  raw[10] = 1;
  const F = ASSET_GROWTH_FIELD_OFF;
  const launch = o.launch ?? 500;
  v.setBigUint64(off + F.cLaunchAtoms, 1_000n * USD, true);
  v.setUint32(off + F.lambdaBps, 10_000, true);
  v.setUint16(off + F.lLaunchX100, launch, true);
  v.setUint16(off + F.lTierX100, 1_000, true);
  v.setUint16(off + F.ceilX100, o.ceil ?? launch, true);
  v.setUint16(off + F.kinkBps, 5_000, true);
  v.setUint16(off + F.rGapBps, GAP, true);
  raw[off + F.version] = 1;
  if (depth) {
    raw[off + 44] = depth.source | DEPTH_PREV_REAL | (depth.ever === false ? 0 : DEPTH_EVER);
    v.setBigUint64(off + 56, depth.usd * USD, true);
    v.setBigUint64(off + 64, depth.slot, true);
    v.setBigUint64(off + 72, depth.prevUsd * USD, true);
    v.setBigUint64(off + 80, (depth.lastGoodUsd ?? depth.usd) * USD, true);
    v.setBigUint64(off + 88, depth.lastGoodSlot ?? depth.slot, true);
  }
  return raw;
}

const base = (raw: Uint8Array, oiLong: bigint, capital = 1_013n * USD): GrowthMarketInput => ({
  raw,
  engine: { initialMarginBps: 1_000n, effectivePriceE6: PRICE, oiEffLongQ: oiLong, oiEffShortQ: 0n, tradeFeeBaseBps: 30n, maxTradingFeeBps: 630n },
  lp: { capital, pnl: 0n, feeCredits: 0n },
  lpEffectiveQ: 0n,
  bound: true,
});
const dollars = (q: bigint | null): number => (Number(q ?? 0n) * Number(PRICE)) / 1e12;
const growth1 = nCapQ(1_013n * USD, 10_000, PRICE, 1_000_000n);
const fresh = (usd: bigint): Depth => ({ source: 1, usd, prevUsd: usd, slot: NOW - 10n });

beforeEach(() => __setDevnetV22ForTest(true));
afterEach(() => __setDevnetV22ForTest(null));

describe("ticket quote follows the program's depth rules (band market)", () => {
  const OI = 9_860_000n; // 56.6% of the kappa-capped capacity below, 11% of the growth-1 capacity
  const view = (depth: Depth | null, nowSlot: bigint | null = NOW, band = BAND, oi = OI) =>
    growthMarketView({ ...base(market(depth), oi), v22: { bandBps: band, nowSlot } })!;

  it("$400 of fresh pool depth: capacity is 0.5 x depth ($200), the crowd side steps down to about 3.27x", () => {
    const v = view(fresh(400n));
    expect(v.long.tier).toBe(0);
    expect(dollars(v.long.nCapQ)).toBeCloseTo(200, 0);
    expect(v.long.maxLeverageX100).toBeGreaterThanOrEqual(325);
    expect(v.long.maxLeverageX100).toBeLessThanOrEqual(330);
  });

  it("the old quote (no v22 input) on the same market says 5x and $1,013", () => {
    const old = growthMarketView(base(market(fresh(400n)), OI))!;
    expect(old.long.maxLeverageX100).toBe(500);
    expect(old.long.nCapQ).toBe(growth1);
  });

  it("an OFF-band market keeps the growth-1 quote whatever the depth says", () => {
    const v = view(fresh(400n), NOW, 0);
    expect(v.long.nCapQ).toBe(growth1);
    expect(v.long.tier).toBe(0);
  });

  it("depth that stops arriving is STICKY: the cap does not switch off, it halves each hour", () => {
    const stoppedFor = (slots: bigint) => view({ source: 1, usd: 400n, prevUsd: 400n, slot: NOW - 1_000n, lastGoodUsd: 400n, lastGoodSlot: NOW - 1_000n - slots }, NOW);
    // reading is 1,000 slots old = stale; last good sample was 0 / 9,000 / 18,000 slots before it
    expect(dollars(stoppedFor(0n).long.nCapQ)).toBeCloseTo(200, 0);
    expect(dollars(stoppedFor(8_000n).long.nCapQ)).toBeCloseTo(100, 0); // 9,000 slots after the last good sample: halved
    expect(dollars(stoppedFor(17_000n).long.nCapQ)).toBeCloseTo(50, 0);
  });

  it("a pool that just got deeper does not count in full at once: usable depth is the slower of the reading and the rate-limited one", () => {
    // reads $400, but the last good (usable) level was $100: capacity is 0.5 x $100 = $50 until it has doubled up
    const v = view({ source: 1, usd: 400n, prevUsd: 400n, slot: NOW - 10n, lastGoodUsd: 100n, lastGoodSlot: NOW - 100n });
    expect(dollars(v.long.nCapQ)).toBeCloseTo(50, 0);
  });

  it("a real zero reading caps capacity at 0 at once: the side reads full (capacity-zero)", () => {
    const v = view({ source: 1, usd: 0n, prevUsd: 400n, slot: NOW - 10n, lastGoodUsd: 400n, lastGoodSlot: NOW - 100n });
    expect(v.long.closed).toBe(true);
    expect(v.long.closedReason).toBe("capacity-zero");
  });

  it("no depth ever seen: no depth cap (growth-1 capacity), tier 0", () => {
    const v = view(null);
    expect(v.long.nCapQ).toBe(growth1);
    expect(v.long.tier).toBe(0);
  });

  it("tier is the LOWER of pool depth and market backing: $30k of depth alone earns nothing while backing is $1k", () => {
    const v = view(fresh(30_000n));
    expect(v.long.venueTier).toBe(1);
    expect(v.long.bookTier).toBe(0);
    expect(v.long.tier).toBe(0);
    // launch is already 5x, so tier 1 adds nothing: the next thing worth naming is tier 2 (10x), which needs both.
    expect(v.long.nextUnlock).toMatchObject({ kind: "both", leverageX100: 1_000, depthUsd: 100_000, backingUsd: 100_000 });
    const rich = growthMarketView({ ...base(market(fresh(30_000n)), OI, 30_000n * USD), v22: { bandBps: BAND, nowSlot: NOW } })!;
    expect(rich.long.tier).toBe(1);
  });

  describe("clock unknown = nothing is claimed (R-app-3560 L1)", () => {
    it("no growth view at all: the stored depth decays with age, so no reading without the slot can be called conservative", () => {
      for (const d of [fresh(400n), fresh(30_000n), { ...fresh(30_000n), source: 2 }, null]) {
        expect(growthMarketView({ ...base(market(d), OI, 30_000n * USD), v22: { bandBps: BAND, nowSlot: null } })).toBeNull();
      }
    });

    it("a slot-known reading still works (the null is only for the unknown clock)", () => {
      expect(growthMarketView({ ...base(market(fresh(400n)), OI, 30_000n * USD), v22: { bandBps: BAND, nowSlot: NOW } })).not.toBeNull();
    });

    it("and the old failure mode is gone: a long-stale depth read at its own slot would have quoted far more than the slot-known cap", () => {
      const stale = { ...fresh(400n), slot: NOW - 200_000n, lastGoodSlot: NOW - 200_000n };
      const known = growthMarketView({ ...base(market(stale), OI, 30_000n * USD), v22: { bandBps: BAND, nowSlot: NOW } })!;
      expect(known.long.nCapQ ?? 0n).toBeLessThan(growth1 ?? 0n);
      expect(growthMarketView({ ...base(market(stale), OI, 30_000n * USD), v22: { bandBps: BAND, nowSlot: null } })).toBeNull();
    });
  });
});
