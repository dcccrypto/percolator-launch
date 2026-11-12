import { describe, expect, it } from "vitest";
import { busyFeeShareAtoms, confirmDriftRefusal, confirmedFeeCapBps, marketMayChargeBusyFee, type ConfirmedTerms } from "@/lib/v22/busy-fee";
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
describe("confirmedFeeCapBps (review MED-1)", () => {
  it("reviewed total + margin, clamped to the market maximum", () => {
    expect(confirmedFeeCapBps(53n, 2)).toBe(55n);
    expect(confirmedFeeCapBps(53n + 46n, 2)).toBe(101n);
    expect(confirmedFeeCapBps(699n, 2, 700n)).toBe(700n);
    expect(confirmedFeeCapBps(53n, 0)).toBe(53n);
  });
});
describe("confirmDriftRefusal (Council r9 Attacker A / B)", () => {
  const snap: ConfirmedTerms = { direction: "long", leverage: 5, signedFeeBps: 101n, busyFeeBps: 46n };
  const live = (o: Partial<ConfirmedTerms> = {}): ConfirmedTerms => ({ ...snap, signedFeeBps: 99n, ...o });
  it("unchanged / lower / inside the margin: no refusal", () => {
    expect(confirmDriftRefusal(snap, live())).toBeNull();
    expect(confirmDriftRefusal(snap, live({ busyFeeBps: 10n, signedFeeBps: 60n }))).toBeNull();
    expect(confirmDriftRefusal(snap, live({ signedFeeBps: 101n }))).toBeNull(); // exactly the cap still fits
  });
  it("a higher busy-side fee: the busy-side line", () => {
    expect(confirmDriftRefusal(snap, live({ busyFeeBps: 47n }))).toMatch(/^The busy-side fee changed while you were reviewing.*Review it again\. Nothing was sent\.$/);
  });
  it("only the matcher quote moved (no busy-side rise) past the cap: blames the market maker's fee, not the busy-side fee", () => {
    const m = confirmDriftRefusal(snap, live({ signedFeeBps: 102n }));
    expect(m).toMatch(/^The market maker's fee changed while you were reviewing/);
    expect(m).not.toContain("busy-side");
  });
  it("a flipped side or a changed leverage: refused", () => {
    expect(confirmDriftRefusal(snap, live({ direction: "short" }))).toMatch(/side changed/);
    expect(confirmDriftRefusal(snap, live({ leverage: 4 }))).toMatch(/leverage changed/);
  });
});
describe("sendWithConfirmedFeeCap (Council r9 Attacker A)", () => {
  const err98 = Object.assign(new Error("custom program error: 0x62"), { code: 98 });
  it("confirmed: a 98 is a refusal to review again, never a second (raised) send", async () => {
    const calls: boolean[] = [];
    await expect(sendWithConfirmedFeeCap(async (raised) => { calls.push(raised); throw err98; }, true)).rejects.toBeInstanceOf(FeeChangedAfterReviewError);
    expect(calls).toEqual([false]);
  });
  it("confirmed: a 98 says the busy-side fee moved, a 9 says the market maker's fee moved; both end 'Nothing was charged.'", async () => {
    const e9 = Object.assign(new Error('Transaction simulation failed: {"InstructionError":[2,{"Custom":9}]}'), { code: 9 });
    const a = await sendWithConfirmedFeeCap(async () => { throw err98; }, true).catch((e) => e as Error);
    const b = await sendWithConfirmedFeeCap(async () => { throw e9; }, true).catch((e) => e as Error);
    expect(a.message).toBe("The busy-side fee changed while you were reviewing: it is now higher than the one you saw. Review it again. Nothing was charged.");
    expect(b.message).toBe("The market maker's fee changed while you were reviewing: it is now higher than the one you saw. Review it again. Nothing was charged.");
  });
  it("no confirm screen: a 9 is not touched (it surfaces as before)", async () => {
    const e9 = Object.assign(new Error("Custom 9"), { code: 9 });
    await expect(sendWithConfirmedFeeCap(async () => { throw e9; }, false)).rejects.toBe(e9);
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
  it("FeeChangedAfterReviewError: 'Review it again. Nothing was charged.'", () => {
    const m = resolveUserMessage(new FeeChangedAfterReviewError(new Error("98")), { surface: "trade" });
    expect(m.kind).toBe("fee-changed-after-review");
    expect(m.body).toContain("Review it again. Nothing was charged.");
  });
});
