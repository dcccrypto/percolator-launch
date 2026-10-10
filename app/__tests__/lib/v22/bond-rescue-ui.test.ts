// @vitest-environment node
import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import type { BondPositionV20, BondTrancheV20 } from "@/lib/v22/sdk";
import { bondCardState, bondDepositQuote, bondWithdrawQuote, slotsToWait, type BondReadings } from "@/lib/v22/bond-ui";
import { rescueQuote, rescueView } from "@/lib/v22/rescue-ui";

const tranche = (o: Partial<BondTrancheV20> = {}): BondTrancheV20 => ({
  marketGroup: PublicKey.default, cBAtoms: 1_000_000_000n, bSharesTotal: 1_000_000_000n, principalInLpAtoms: 0n, bondDrawnOutstandingAtoms: 0n,
  lastCouponSlot: 0n, couponBpsPerYear: 800, couponUtilBonusBps: 0, bondCooldownSlots: 9_000, bondCapBpsOfC: 5000, version: 1, bump: 255,
  lastUtilBps: 0, couponPaidTotalAtoms: 0n, ...o,
});
const pos = (o: Partial<BondPositionV20> = {}): BondPositionV20 => ({ owner: PublicKey.default, shares: 100_000_000n, pendingWithdrawShares: 0n, requestSlot: 0n, version: 1, bump: 255, ...o });
// vault 5_000, senior claim 2_000 -> bond (1_000) is whole, junior 2_000
const flat: BondReadings = { vaultValue: 5_000_000_000n, seniorClaimEff: 2_000_000_000n, oiLongQ: 0n, oiShortQ: 0n, lpEffAbsQ: 0n };
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
