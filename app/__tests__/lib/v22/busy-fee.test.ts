import { describe, expect, it } from "vitest";
import { busyFeeShareAtoms, confirmDriftRefusal, marketMayChargeBusyFee, type ConfirmedTerms } from "@/lib/v22/busy-fee";
import { FeeChangedAfterReviewError, sendWithConfirmedFeeCap } from "@/lib/limits/trade-fee-resolve";

describe("marketMayChargeBusyFee", () => {
  it("growth market (view built, or record present but not readable yet): yes; none / unknown limits / legacy: no", () => {
    expect(marketMayChargeBusyFee({ growth: {} })).toBe(true);
    expect(marketMayChargeBusyFee({ growthRoom: "known" })).toBe(true);
    expect(marketMayChargeBusyFee({ growthRoom: "loading" })).toBe(true);
    expect(marketMayChargeBusyFee({ growthRoom: "error" })).toBe(true);
    expect(marketMayChargeBusyFee({ growthRoom: "none" })).toBe(false);
    expect(marketMayChargeBusyFee({})).toBe(false);
    expect(marketMayChargeBusyFee(null)).toBe(false);
  });
});
describe("busyFeeShareAtoms", () => {
  it("whole close = all; partial = proportional, rounded; nothing for 0", () => {
    expect(busyFeeShareAtoms(2_989_999n, 100n, 100n)).toBe(2_989_999n);
    expect(busyFeeShareAtoms(1_000n, 25n, 100n)).toBe(250n);
    expect(busyFeeShareAtoms(0n, 25n, 100n)).toBe(0n);
  });
});
describe("confirmDriftRefusal (Council r9 Attacker A / B)", () => {
  const snap: ConfirmedTerms = { direction: "long", leverage: 5, signedFeeBps: 135n, busyFeeBps: 46n };
  it("unchanged / lower fee: no refusal", () => {
    expect(confirmDriftRefusal(snap, snap)).toBeNull();
    expect(confirmDriftRefusal(snap, { ...snap, busyFeeBps: 10n, signedFeeBps: 100n })).toBeNull();
  });
  it("a higher busy-side fee or cap after the review: refused, with the line", () => {
    for (const live of [{ ...snap, busyFeeBps: 47n }, { ...snap, signedFeeBps: 136n }, { ...snap, signedFeeBps: 200n, busyFeeBps: 200n }]) {
      expect(confirmDriftRefusal(snap, live)).toMatch(/^The busy-side fee changed while you were reviewing.*Review it again\. Nothing was sent\.$/);
    }
    expect(confirmDriftRefusal({ ...snap, signedFeeBps: null }, { ...snap, signedFeeBps: 135n })).not.toBeNull(); // a cap appeared that was never shown
    expect(confirmDriftRefusal({ ...snap, signedFeeBps: null }, { ...snap, signedFeeBps: null })).toBeNull();
  });
  it("a flipped side or a changed leverage: refused", () => {
    expect(confirmDriftRefusal(snap, { ...snap, direction: "short" })).toMatch(/side changed/);
    expect(confirmDriftRefusal(snap, { ...snap, leverage: 4 })).toMatch(/leverage changed/);
  });
});
describe("sendWithConfirmedFeeCap (Council r9 Attacker A)", () => {
  const err98 = Object.assign(new Error("custom program error: 0x62"), { code: 98 });
  it("confirmed: a 98 is a refusal to review again, never a second (raised) send", async () => {
    const calls: boolean[] = [];
    await expect(sendWithConfirmedFeeCap(async (raised) => { calls.push(raised); throw err98; }, true)).rejects.toBeInstanceOf(FeeChangedAfterReviewError);
    expect(calls).toEqual([false]);
  });
  it("confirmed: other errors pass through; success sends once", async () => {
    await expect(sendWithConfirmedFeeCap(async () => { throw new Error("boom"); }, true)).rejects.toThrow("boom");
    expect(await sendWithConfirmedFeeCap(async (r) => (r ? "raised" : "ok"), true)).toBe("ok");
  });
  it("no confirm screen (closes, other callers): the silent raise-and-retry stands", async () => {
    const calls: boolean[] = [];
    const r = await sendWithConfirmedFeeCap(async (raised) => { calls.push(raised); if (!raised) throw err98; return "sent"; }, false);
    expect(r).toBe("sent");
    expect(calls).toEqual([false, true]);
  });
});

import { resolveUserMessage } from "@/lib/limits/user-message";
describe("the refusal reaches the trader as a line, not a generic error", () => {
  it("FeeChangedAfterReviewError: 'Review it again. Nothing was sent.'", () => {
    const m = resolveUserMessage(new FeeChangedAfterReviewError(new Error("98")), { surface: "trade" });
    expect(m.kind).toBe("fee-changed-after-review");
    expect(m.body).toContain("Review it again. Nothing was sent.");
  });
});
