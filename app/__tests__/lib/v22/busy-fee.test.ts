import { describe, expect, it, vi } from "vitest";
import { busyFeeShareAtoms, confirmDriftRefusal, marketMayChargeBusyFee, type ConfirmedTerms } from "@/lib/v22/busy-fee";
import { FeeChangedAfterReviewError, sendWithConfirmedFeeCap } from "@/lib/limits/trade-fee-resolve";
import { BusyFeeRoseError, BusyFeeUnreadableError, BUSY_FEE_UNREADABLE_MESSAGE, assertBusyFeeNotRisen, readFreshBusyFeeBps } from "@/lib/v22/fresh-busy-fee";

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
describe("confirmDriftRefusal (Council r9 Attacker B)", () => {
  const snap: ConfirmedTerms = { direction: "long", leverage: 5, busyFeeBps: 46n };
  it("unchanged / lower busy-side fee: no refusal", () => {
    expect(confirmDriftRefusal(snap, snap)).toBeNull();
    expect(confirmDriftRefusal(snap, { ...snap, busyFeeBps: 10n })).toBeNull();
  });
  it("a higher busy-side fee: the busy-side line", () => {
    expect(confirmDriftRefusal(snap, { ...snap, busyFeeBps: 47n })).toMatch(/^The busy-side fee changed while you were reviewing.*Review it again\. Nothing was sent\.$/);
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
  it("confirmed 98, no fresh evidence of a busy-side rise: the GENERIC line (the adaptive matcher fee can also cause a 98)", async () => {
    const e = await sendWithConfirmedFeeCap(async () => { throw err98; }, true, async () => null).catch((x) => x as Error);
    expect(e.message).toBe("The fee changed while you were reviewing. Review it again. Nothing was charged.");
    expect(e.message).not.toContain("busy-side");
  });
  it("confirmed 98 and a fresh read shows the busy rate rose: the busy-side line", async () => {
    const e = await sendWithConfirmedFeeCap(async () => { throw err98; }, true, async () => new BusyFeeRoseError(106n)).catch((x) => x as Error);
    expect(e).toBeInstanceOf(BusyFeeRoseError);
    expect(e.message).toBe("The busy-side fee rose to 1.06% while you were reviewing. Review it again. Nothing was sent.");
  });
  it("confirmed: a Custom 9 is NOT remapped (the existing trade-refusal-9 diagnosis runs on it), other errors pass through; success sends once", async () => {
    const e9 = Object.assign(new Error('Transaction simulation failed: {"InstructionError":[2,{"Custom":9}]}'), { code: 9 });
    await expect(sendWithConfirmedFeeCap(async () => { throw e9; }, true)).rejects.toBe(e9);
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

describe("assertBusyFeeNotRisen (delta review MED-A)", () => {
  const g = { confirmedBusyFeeBps: 99n, direction: "long" as const, takerEffQ: 0n, sizeQ: 1_000n };
  it("higher than confirmed: BusyFeeRoseError (so nothing is signed)", async () => {
    await expect(assertBusyFeeNotRisen(g, async () => 100n)).rejects.toBeInstanceOf(BusyFeeRoseError);
    await expect(assertBusyFeeNotRisen(g, async () => 100n)).rejects.toThrow(/rose to 1\.00%.*Nothing was sent\./);
  });
  it("equal or lower: proceeds", async () => {
    await assertBusyFeeNotRisen(g, async () => 99n);
    await assertBusyFeeNotRisen(g, async () => 0n);
  });
  it("unreadable (null / throws / timeout): FAILS CLOSED with the plain message, after exactly one retry", async () => {
    for (const bad of [async () => null, async () => { throw new Error("rpc"); }]) {
      const read = vi.fn(bad);
      const e = await assertBusyFeeNotRisen(g, read).catch((x) => x as Error);
      expect(e).toBeInstanceOf(BusyFeeUnreadableError);
      expect((e as Error).message).toBe(BUSY_FEE_UNREADABLE_MESSAGE);
      expect((e as Error).message).toContain("Nothing was signed");
      expect(read).toHaveBeenCalledTimes(2);
    }
    vi.useFakeTimers();
    try {
      const hang = vi.fn(() => new Promise<bigint | null>(() => {}));
      const p = assertBusyFeeNotRisen(g, hang).catch((x) => x as Error);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await p).toBeInstanceOf(BusyFeeUnreadableError);
      expect(hang).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it("one transient failure then a good read: proceeds (a single retry is enough)", async () => {
    const read = vi.fn<() => Promise<bigint | null>>().mockRejectedValueOnce(new Error("429")).mockResolvedValueOnce(99n);
    await assertBusyFeeNotRisen(g, read);
    expect(read).toHaveBeenCalledTimes(2);
    const read2 = vi.fn<() => Promise<bigint | null>>().mockResolvedValueOnce(null).mockResolvedValueOnce(100n);
    await expect(assertBusyFeeNotRisen(g, read2)).rejects.toBeInstanceOf(BusyFeeRoseError);
  });
  it("no guard (no confirm screen): nothing is read", async () => {
    const read = vi.fn(async () => 5n);
    await assertBusyFeeNotRisen(undefined, read);
    expect(read).not.toHaveBeenCalled();
  });
});

import { PublicKey } from "@solana/web3.js";
import { growthRecordPresence } from "@/lib/v21/growth-market";
import { modeFixtures } from "../../helpers/v22-fixtures";
import { resolveUserMessage } from "@/lib/limits/user-message";
describe("the refusal reaches the trader as a line, not a generic error", () => {
  it("FeeChangedAfterReviewError and BusyFeeRoseError resolve to lines", () => {
    const m = resolveUserMessage(new FeeChangedAfterReviewError(new Error("98")), { surface: "trade" });
    expect(m.kind).toBe("fee-changed-after-review");
    expect(m.body).toContain("Nothing was");
  });
  it("BusyFeeUnreadableError resolves to a plain line with a retry action", () => {
    const m = resolveUserMessage(new BusyFeeUnreadableError(new Error("rpc")), { surface: "trade" });
    expect(m.kind).toBe("busy-fee-unreadable");
    expect(m.body).toBe(BUSY_FEE_UNREADABLE_MESSAGE);
  });
  it("BusyFeeRoseError", () => {
    const m = resolveUserMessage(new BusyFeeRoseError(106n), { surface: "trade" });
    expect(m.kind).toBe("busy-fee-rose");
    expect(m.body).toBe("The busy-side fee rose to 1.06% while you were reviewing. Review it again. Nothing was sent.");
  });
});

describe("readFreshBusyFeeBps never guesses", () => {
  const prog = new PublicKey(new Uint8Array(32).fill(5));
  const mkt = new PublicKey(new Uint8Array(32).fill(6));
  const g = { direction: "long" as const, takerEffQ: 0n, sizeQ: 1_000n };
  it("an unreadable chain is null (the guard then REFUSES the order)", async () => {
    const c = { getAccountInfo: vi.fn(async () => { throw new Error("rpc"); }), getMultipleAccountsInfo: vi.fn(), getSlot: vi.fn() };
    expect(await readFreshBusyFeeBps(c as never, prog, mkt, g)).toBeNull();
    expect(await readFreshBusyFeeBps({ ...c, getAccountInfo: vi.fn(async () => null) } as never, prog, mkt, g)).toBeNull();
  });
  it("a market with no growth record has no busy-side fee: 0n", async () => {
    const c = { getAccountInfo: vi.fn(async () => ({ data: Buffer.from(modeFixtures().market) })), getMultipleAccountsInfo: vi.fn(), getSlot: vi.fn() };
    const v = await readFreshBusyFeeBps(c as never, prog, mkt, g);
    expect(v).toBe(0n);
  });
  it("r10 follow-up: a growth record that is present but cannot be read is UNKNOWN (null, refused), never a known 0n", async () => {
    const truncated = modeFixtures().market.slice(0, 2_000);
    expect(growthRecordPresence(truncated)).toBe("undecodable"); // guards the fixture itself
    const c = { getAccountInfo: vi.fn(async () => ({ data: Buffer.from(truncated) })), getMultipleAccountsInfo: vi.fn(), getSlot: vi.fn() };
    expect(await readFreshBusyFeeBps(c as never, prog, mkt, g)).toBeNull();
    await expect(assertBusyFeeNotRisen({ confirmedBusyFeeBps: 0n, ...g }, () => readFreshBusyFeeBps(c as never, prog, mkt, g))).rejects.toBeInstanceOf(BusyFeeUnreadableError);
  });
});
