// @vitest-environment node
import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import type { BondPositionV20, BondTrancheV20 } from "@/lib/v22/sdk";
import { bondCardState, bondDepositQuote, bondWithdrawQuote, slotsToWait, type BondReadings } from "@/lib/v22/bond-ui";
import { rescueQuote, rescueView } from "@/lib/v22/rescue-ui";
import { RESCUE_NAV_FLOOR_BPS_V22, rescueAdmittedV22 } from "@/lib/v22/sdk";

const tranche = (o: Partial<BondTrancheV20> = {}): BondTrancheV20 => ({
  marketGroup: PublicKey.default, cBAtoms: 1_000_000_000n, bSharesTotal: 1_000_000_000n, principalInLpAtoms: 0n, bondDrawnOutstandingAtoms: 0n,
  lastCouponSlot: 0n, couponBpsPerYear: 800, couponUtilBonusBps: 0, bondCooldownSlots: 9_000, bondCapBpsOfC: 5000, version: 2, bump: 255,
  lastUtilBps: 0, couponPaidTotalAtoms: 0n, couponArrearsAtoms: 0n, couponUnfundedAtoms: 0n, couponAccrualRem: 0n, couponGateSeen: 0n, ...o,
});
const pos = (o: Partial<BondPositionV20> = {}): BondPositionV20 => ({ owner: PublicKey.default, shares: 100_000_000n, pendingWithdrawShares: 0n, requestSlot: 0n, version: 1, bump: 255, ...o });
// vault 5_000, senior claim 2_000 -> bond (1_000) is whole, junior 2_000
const flat: BondReadings = { vaultValue: 5_000_000_000n, seniorClaimEff: 2_000_000_000n, nowSlot: 0n, seniorDrawnAtoms: 0n, seniorDrawOutstandingAtoms: 0n, oiLongQ: 0n, oiShortQ: 0n, lpEffAbsQ: 0n };
const busy: BondReadings = { ...flat, oiLongQ: 50n };

describe("bondCardState", () => {
  it("healthy bond: deposits open, no pending withdrawal", () => {
    const s = bondCardState({ tranche: tranche(), position: pos(), nowSlot: 100n, readings: flat });
    expect(s.impaired).toBe(false);
    expect(s.canDeposit).toBe(true);
    expect(s.cooldown).toBe("none");
    expect(s.canRequestWithdraw).toBe(true);
    expect(s.flat).toBe(true);
    expect(s.couponCapPctYear).toBe(8);
  });
  it("below par: deposits paused (107)", () => {
    // vault 2_500 vs senior 2_000 + bond 1_000: the bond is short of par
    const s = bondCardState({ tranche: tranche(), position: pos(), nowSlot: 0n, readings: { ...flat, vaultValue: 2_500_000_000n } });
    expect(s.impaired).toBe(true);
    expect(s.canDeposit).toBe(false);
  });
  it("without readings falls back to the tranche's own drawn-outstanding mirror", () => {
    expect(bondCardState({ tranche: tranche({ bondDrawnOutstandingAtoms: 5n }), position: null, nowSlot: 0n, readings: null }).impaired).toBe(true);
    expect(bondCardState({ tranche: tranche(), position: null, nowSlot: 0n, readings: null }).impaired).toBe(false);
  });
  it("cooldown pending then ready at request + cooldown exactly", () => {
    const p = pos({ pendingWithdrawShares: 10n, requestSlot: 1_000n });
    const pending = bondCardState({ tranche: tranche(), position: p, nowSlot: 9_999n, readings: flat });
    expect(pending.cooldown).toBe("pending");
    expect(pending.slotsLeft).toBe(1n);
    expect(pending.canExecuteWithdraw).toBe(false);
    const ready = bondCardState({ tranche: tranche(), position: p, nowSlot: 10_000n, readings: flat });
    expect(ready.cooldown).toBe("ready");
    expect(ready.canExecuteWithdraw).toBe(true);
  });
  it("flat only when nothing is open", () => {
    expect(bondCardState({ tranche: tranche(), position: pos(), nowSlot: 0n, readings: busy }).flat).toBe(false);
    expect(bondCardState({ tranche: tranche(), position: pos(), nowSlot: 0n, readings: { ...flat, lpEffAbsQ: 1n } }).flat).toBe(false);
  });
  it("renders waits calmly", () => {
    expect(slotsToWait(50n)).toBe("in under a minute");
    expect(slotsToWait(9_000n)).toBe("in about 60 minutes");
  });
});

describe("bond quotes", () => {
  it("deposit: shares + a slippage floor below them", () => {
    const q = bondDepositQuote(tranche(), 100_000_000n, flat, 50)!;
    expect(q.refusal).toBeNull();
    expect(q.shares).toBe(100_000_000n);
    expect(q.minShares).toBe(99_500_000n);
  });
  it("deposit above the cap is refused 123", () => {
    expect(bondDepositQuote(tranche(), 1_500_000_000n, flat)!.refusal?.code).toBe(123);
  });
  it("deposit into an impaired bond is refused 107", () => {
    expect(bondDepositQuote(tranche(), 1n, { ...flat, vaultValue: 2_500_000_000n })!.refusal?.code).toBe(107);
  });
  it("live withdraw: allowed only when flat, 108 once anything is open", () => {
    const p = pos({ pendingWithdrawShares: 10_000_000n, requestSlot: 0n });
    expect(bondWithdrawQuote(tranche(), p, flat)!.refusal).toBeNull();
    expect(bondWithdrawQuote(tranche(), p, busy)!.refusal?.code).toBe(108);
  });
  it("no quote without a pending request or without a vault reading", () => {
    expect(bondWithdrawQuote(tranche(), pos(), flat)).toBeNull();
    expect(bondDepositQuote(tranche(), 1n, { ...flat, vaultValue: null })).toBeNull();
    // GH#571: the program settles the coupon to the current slot first, so no slot / drawn counter = no quote
    expect(bondDepositQuote(tranche(), 1n, { ...flat, nowSlot: null })).toBeNull();
    expect(bondDepositQuote(tranche(), 1n, { ...flat, seniorDrawnAtoms: null })).toBeNull();
    expect(bondWithdrawQuote(tranche(), pos({ pendingWithdrawShares: 1n }), { ...flat, nowSlot: null })).toBeNull();
  });
});

describe("bond quotes: cumulative coupon (prog #649, GH#571)", () => {
  const YEAR = 78_840_000n;
  it("a newcomer pays for the settled coupon: one year at 8% makes K 1,080 and 108 buys 100 shares", () => {
    const q = bondDepositQuote(tranche(), 108_000_000n, { ...flat, nowSlot: YEAR }, 0)!;
    expect([q.refusal, q.settledCoupon, q.claimAtPrice, q.shares]).toEqual([null, 80_000_000n, 1_080_000_000n, 100_000_000n]);
    // the receivable and the cap meter carry the settled coupon; the new shares are labelled at the pool's ratio (ceil)
    expect([q.trancheAfter!.couponArrearsAtoms, q.trancheAfter!.couponUnfundedAtoms, q.trancheAfter!.cBAtoms]).toEqual([80_000_000n, 88_000_000n, 1_188_000_000n]);
  });
  it("an exit is paid its slice of the claim incl. the settled coupon, and leaves the receivable", () => {
    const p = pos({ pendingWithdrawShares: 100_000_000n });
    const q = bondWithdrawQuote(tranche(), p, { ...flat, nowSlot: YEAR }, 0)!;
    expect([q.refusal, q.settledCoupon, q.atoms, q.claimAfter, q.trancheAfter!.couponArrearsAtoms]).toEqual([null, 80_000_000n, 108_000_000n, 972_000_000n, 80_000_000n]);
  });
  it("an interval with a senior draw booked since the last settlement accrues nothing (att649 F2)", () => {
    const q = bondDepositQuote(tranche(), 100_000_000n, { ...flat, nowSlot: YEAR, seniorDrawnAtoms: 1n }, 0)!;
    expect([q.settledCoupon, q.shares]).toEqual([0n, 100_000_000n]);
  });
  it("a senior draw outstanding pauses deposits and exits (89)", () => {
    expect(bondDepositQuote(tranche(), 1n, { ...flat, seniorDrawOutstandingAtoms: 1n })!.refusal?.code).toBe(89);
    expect(bondWithdrawQuote(tranche(), pos({ pendingWithdrawShares: 1n }), { ...flat, seniorDrawOutstandingAtoms: 1n })!.refusal?.code).toBe(89);
  });
});

describe("rescue", () => {
  const r = { v: 800_000_000n, par: 1_000_000_000n, shares: 1_000_000_000n };
  it("visible only when impaired, with the discount price per share", () => {
    const v = rescueView(r);
    expect(v.visible).toBe(true);
    expect(v.pricePerShare).toBeCloseTo(0.8, 6);
  });
  it("hidden at or above par, with no readings, or with no shares", () => {
    expect(rescueView({ ...r, v: 1_000_000_000n }).visible).toBe(false);
    expect(rescueView({ ...r, v: 1_200_000_000n }).visible).toBe(false);
    expect(rescueView(null).visible).toBe(false);
    expect(rescueView({ ...r, shares: 0n }).visible).toBe(false);
    expect(rescueView({ ...r, v: null }).visible).toBe(false);
  });
  it("past the NAV floor: wind-down line, no action", () => {
    const v = rescueView({ v: 10_000_000n, par: 1_000_000_000n, shares: 1_000_000_000n });
    expect(v.wound).toBe(true);
    expect(v.visible).toBe(false);
  });
  // D23 / prog #595 (#624, cb5bfcf2): RESCUE_NAV_FLOOR_BPS is 5,000 (50% of par); it was 500. sdk#437 merge d13e1a48.
  // Under the old 500 the app offered "Add capital at a discount" at 5%..50% of par and the program refused with 115.
  it("NAV floor is 50% of par (prog #624): the vendored constant", () => {
    expect(RESCUE_NAV_FLOOR_BPS_V22).toBe(5_000);
  });
  it("40% of par: wind-down line, no action, and a quote is refused 115 RescueNavFloor", () => {
    const at40 = { v: 400_000_000n, par: 1_000_000_000n, shares: 1_000_000_000n };
    const v = rescueView(at40);
    expect(v.wound).toBe(true);
    expect(v.visible).toBe(false);
    expect(rescueAdmittedV22(100_000_000n, at40.v, at40.par, at40.shares)).toBe("NavFloor");
    expect(rescueQuote(at40, 100_000_000n)!.refusal).toMatchObject({ code: 115, name: "RescueNavFloor", reason: "NavFloor" });
  });
  it("just under 50% of par is past the floor; exactly 50% is admitted", () => {
    expect(rescueView({ v: 499_999_999n, par: 1_000_000_000n, shares: 1_000_000_000n }).wound).toBe(true);
    const at50 = { v: 500_000_000n, par: 1_000_000_000n, shares: 1_000_000_000n };
    expect(rescueView(at50).visible).toBe(true);
    expect(rescueAdmittedV22(100_000_000n, at50.v, at50.par, at50.shares)).toBeNull();
    expect(rescueQuote(at50, 100_000_000n)!.admitted).toBe(true);
  });
  it("quote: shares at the impaired value (never par) and a floor below them", () => {
    const q = rescueQuote(r, 200_000_000n, 50)!;
    expect(q.admitted).toBe(true);
    expect(q.shares).toBe(250_000_000n); // 200 * 1000 / 800
    expect(q.minShares).toBe(248_750_000n);
  });
  it("below the minimum amount is refused", () => {
    expect(rescueQuote(r, 1n)!.refusal?.reason).toBe("Amount");
  });
});
