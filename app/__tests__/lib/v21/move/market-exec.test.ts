import { describe, expect, it, vi } from "vitest";
import { makeMarketExecutors, type MarketBridge } from "@/lib/v21/move/market-exec";
import { V1_PROGRAM_IDS } from "@/lib/v21/move/ids";
import { runMove } from "@/lib/v21/move/run";
import { safeUserMessage, MOVE_ERR } from "@/lib/v21/move/errors";
import { input, market, pk, SOL_SLAB } from "./fixtures";
import type { MoveAction } from "@/lib/v21/move/plan";

const act = (kind: MoveAction["kinds"][number], slab = SOL_SLAB): MoveAction => ({ slab, kinds: [kind], simulate: true });

function bridge(over: Partial<MarketBridge> = {}): MarketBridge {
  return {
    slab: SOL_SLAB,
    programId: V1_PROGRAM_IDS.wrapper,
    ready: true,
    readPortfolio: vi.fn(async () => ({ capital: 5n, releasedPnl: 0n, openLegs: 0, userIdx: 3 })),
    readEarn: vi.fn(async () => ({ shares: 10n, pendingShares: 0n, cooldownElapsed: true })),
    closeAll: vi.fn(async () => "sig-close"),
    withdraw: vi.fn(async () => "sig-wd"),
    earn: vi.fn(async () => ({ step: "requested" as const, signature: "sig-earn" })),
    ...over,
  };
}
const ex = (b: MarketBridge) => makeMarketExecutors(async () => b);

describe("market executors: guards", () => {
  it("close sends one full close when a leg is open, with the sweep off (withdraw step owns it)", async () => {
    const b = bridge({ readPortfolio: vi.fn(async () => ({ capital: 5n, releasedPnl: 0n, openLegs: 2, userIdx: 1 })) });
    expect(await ex(b).close!(act("close"))).toBe("sig-close");
    expect(b.closeAll).toHaveBeenCalledTimes(1);
  });
  it("close sends nothing when already flat (idempotent resume)", async () => {
    const b = bridge();
    expect(await ex(b).close!(act("close"))).toBeNull();
    expect(b.closeAll).not.toHaveBeenCalled();
  });
  it("refuses a bridge for a non-v1 program (never builds against v2.1 or unknown)", async () => {
    const b = bridge({ programId: pk() });
    await expect(ex(b).close!(act("close"))).rejects.toThrow(/not the v1 wrapper/);
    expect(b.closeAll).not.toHaveBeenCalled();
  });
  it("refuses a bridge mounted for another market", async () => {
    const b = bridge({ slab: pk() });
    await expect(ex(b).withdraw!(act("withdraw"))).rejects.toThrow(/different market/);
  });
  it("refuses while the market is not loaded", async () => {
    await expect(ex(bridge({ ready: false })).withdraw!(act("withdraw"))).rejects.toThrow(/not loaded/);
    await expect(ex(bridge({ programId: null })).withdraw!(act("withdraw"))).rejects.toThrow(/not loaded/);
  });
  it("withdraw never runs with an open leg", async () => {
    const b = bridge({ readPortfolio: vi.fn(async () => ({ capital: 5n, releasedPnl: 0n, openLegs: 1, userIdx: 1 })) });
    await expect(ex(b).withdraw!(act("withdraw"))).rejects.toThrow(/close the position/);
    expect(b.withdraw).not.toHaveBeenCalled();
  });
  it("withdraw takes capital plus released profit, from a fresh read", async () => {
    const b = bridge({ readPortfolio: vi.fn(async () => ({ capital: 5n, releasedPnl: 2n, openLegs: 0, userIdx: 9 })) });
    await ex(b).withdraw!(act("withdraw"));
    expect(b.withdraw).toHaveBeenCalledWith({ userIdx: 9, amount: 7n });
  });
  it("withdraw falls back to capital alone if the profit leg loses a race; plain failure still throws", async () => {
    const w = vi.fn().mockRejectedValueOnce(new Error("lock")).mockResolvedValueOnce("sig2");
    const b = bridge({ readPortfolio: vi.fn(async () => ({ capital: 5n, releasedPnl: 2n, openLegs: 0, userIdx: 1 })), withdraw: w });
    expect(await ex(b).withdraw!(act("withdraw"))).toBe("sig2");
    expect(w).toHaveBeenLastCalledWith({ userIdx: 1, amount: 5n });
    const w2 = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(ex(bridge({ withdraw: w2 })).withdraw!(act("withdraw"))).rejects.toThrow("boom");
    expect(w2).toHaveBeenCalledTimes(1);
  });
  it("withdraw with nothing there sends nothing", async () => {
    const b = bridge({ readPortfolio: vi.fn(async () => ({ capital: 0n, releasedPnl: 0n, openLegs: 0, userIdx: 1 })) });
    expect(await ex(b).withdraw!(act("withdraw"))).toBeNull();
    expect(b.withdraw).not.toHaveBeenCalled();
  });
  it("earn-request asks for the fresh share count; nothing to request or already pending sends nothing", async () => {
    const b = bridge();
    expect(await ex(b)["earn-request"]!(act("earn-request"))).toBe("sig-earn");
    expect(b.earn).toHaveBeenCalledWith(10n);
    const none = bridge({ readEarn: vi.fn(async () => ({ shares: 0n, pendingShares: 0n, cooldownElapsed: true })) });
    expect(await ex(none)["earn-request"]!(act("earn-request"))).toBeNull();
    const pend = bridge({ readEarn: vi.fn(async () => ({ shares: 10n, pendingShares: 4n, cooldownElapsed: false })) });
    expect(await ex(pend)["earn-request"]!(act("earn-request"))).toBeNull();
    expect(none.earn).not.toHaveBeenCalled();
    expect(pend.earn).not.toHaveBeenCalled();
  });
  it("earn-execute refuses inside the cooldown and collects the pending shares after it", async () => {
    const waiting = bridge({ readEarn: vi.fn(async () => ({ shares: 0n, pendingShares: 4n, cooldownElapsed: false })) });
    await expect(ex(waiting)["earn-execute"]!(act("earn-execute"))).rejects.toThrow(/waiting period/);
    expect(waiting.earn).not.toHaveBeenCalled();
    const ok = bridge({ readEarn: vi.fn(async () => ({ shares: 0n, pendingShares: 4n, cooldownElapsed: true })), earn: vi.fn(async () => ({ step: "executed" as const, signature: "sig-pay" })) });
    expect(await ex(ok)["earn-execute"]!(act("earn-execute"))).toBe("sig-pay");
    expect(ok.earn).toHaveBeenCalledWith(4n);
    const noPending = bridge({ readEarn: vi.fn(async () => ({ shares: 5n, pendingShares: 0n, cooldownElapsed: true })) });
    expect(await ex(noPending)["earn-execute"]!(act("earn-execute"))).toBeNull();
    expect(noPending.earn).not.toHaveBeenCalled();
    const none = bridge({ readEarn: vi.fn(async () => null) });
    expect(await ex(none)["earn-execute"]!(act("earn-execute"))).toBeNull();
  });
});

describe("one-click run: resumable, in order, per-step", () => {
  it("closes, then withdraws, re-scanning between, and stops at the Earn cooldown", async () => {
    let legs = 1, cap = 5n, shares = 10n, pending = 0n;
    const scan = async () => input([market({ portfolio: { capital: cap, releasedPnl: 0n, openLegs: legs, closeOnly: true }, earn: { shares, pending: pending ? { shares: pending, unlockSlot: 1_000_000_000n } : null, requestsPaused: false } })]);
    const b = bridge({
      readPortfolio: async () => ({ capital: cap, releasedPnl: 0n, openLegs: legs, userIdx: 1 }),
      readEarn: async () => ({ shares, pendingShares: pending, cooldownElapsed: false }),
      closeAll: async () => ((legs = 0), "c"),
      withdraw: async () => ((cap = 0n), "w"),
      earn: async () => ((pending = shares), (shares = 0n), { step: "requested" as const, signature: "e" }),
    });
    const r = await runMove({ scan, executors: makeMarketExecutors(async () => b), v1Wrapper: V1_PROGRAM_IDS.wrapper, v21: null });
    expect(r.sent).toEqual(["c", "w", "e"]);
    expect(r.stop.reason).toBe("waiting");
  });
  it("a no-op executor (already done) does not count as sent and does not loop", async () => {
    const scan = async () => input([market({ portfolio: { capital: 5n, releasedPnl: 0n, openLegs: 1, closeOnly: false } })]);
    const b = bridge({ readPortfolio: async () => ({ capital: 5n, releasedPnl: 0n, openLegs: 0, userIdx: 1 }) });
    const r = await runMove({ scan, executors: makeMarketExecutors(async () => b), v1Wrapper: V1_PROGRAM_IDS.wrapper, v21: null });
    expect(r.sent).toEqual([]);
    expect(r.stop.reason).toBe("no-progress");
  });
  it("only: a per-step button runs just that step", async () => {
    const scan = async () => input([market({ portfolio: { capital: 5n, releasedPnl: 0n, openLegs: 1, closeOnly: false } })]);
    const b = bridge({ readPortfolio: async () => ({ capital: 5n, releasedPnl: 0n, openLegs: 1, userIdx: 1 }) });
    const r = await runMove({ scan, executors: makeMarketExecutors(async () => b), v1Wrapper: V1_PROGRAM_IDS.wrapper, v21: null, only: (a) => a.kinds[0] === "earn-request" });
    expect(b.closeAll).not.toHaveBeenCalled();
    expect(r.sent).toEqual([]);
  });
});

describe("honest error copy", () => {
  it("maps the h-lock and unpayable vaults to calm lines, and a wallet decline to nothing-sent", () => {
    expect(safeUserMessage(new Error("custom program error: Custom(21)"))).toBe(MOVE_ERR.hlock);
    expect(safeUserMessage(new Error("Custom(91)"))).toBe(MOVE_ERR.vaultNotPaying);
    expect(safeUserMessage(new Error("User rejected the request"))).toBe(MOVE_ERR.declined);
    expect(safeUserMessage(new Error("Move: market not loaded"))).toBe(MOVE_ERR.notLoaded);
  });
});
