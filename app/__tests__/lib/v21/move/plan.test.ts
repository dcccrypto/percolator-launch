import { describe, expect, it } from "vitest";
import { buildMovePlan, nextActions, summarizePlan, type StepKind } from "@/lib/v21/move/plan";
import { input, market, SOL_SLAB } from "./fixtures";

const step = (p: ReturnType<typeof buildMovePlan>, kind: StepKind, slab = SOL_SLAB) =>
  p.markets.find((m) => m.slab === slab)?.steps.find((s) => s.kind === kind);

describe("move plan", () => {
  it("open position: close is ready, withdraw is blocked (guard: withdraw needs a flat account)", () => {
    const p = buildMovePlan(input([market({ portfolio: { capital: 5n, releasedPnl: 0n, openLegs: 1, closeOnly: false } })]));
    expect(step(p, "close")?.status).toBe("ready");
    expect(step(p, "withdraw")?.status).toBe("blocked");
    expect(step(p, "withdraw")?.line).toMatch(/Close your position first/);
  });

  it("closes are never blocked on a live close-only market", () => {
    const p = buildMovePlan(input([market({ resolved: false, portfolio: { capital: 0n, releasedPnl: 0n, openLegs: 2, closeOnly: true } })]));
    expect(step(p, "close")?.status).toBe("ready");
  });

  it("L-7: a RESOLVED market with open legs offers settle (hand-off), never a trade close", () => {
    const p = buildMovePlan(input([market({ resolved: true, portfolio: { capital: 5n, releasedPnl: 0n, openLegs: 2, closeOnly: true } })]));
    expect(step(p, "close")).toBeUndefined();
    expect(step(p, "settle-resolved")?.status).toBe("ready");
    expect(step(p, "settle-resolved")?.line).toMatch(/settled/);
    expect(step(p, "withdraw")?.status).toBe("blocked");
    expect(step(p, "withdraw")?.line).toMatch(/settles first/);
    expect(nextActions(p).every((a) => !a.kinds.includes("close"))).toBe(true);
  });

  it("flat with capital and released profit: withdraw ready, copy mentions settled profit", () => {
    const p = buildMovePlan(input([market({ portfolio: { capital: 1n, releasedPnl: 9n, openLegs: 0, closeOnly: false } })]));
    expect(step(p, "withdraw")?.status).toBe("ready");
    expect(step(p, "withdraw")?.line).toMatch(/settled profit/);
  });

  it("pending Earn cooldown: execute is waiting with a slot count, never ready", () => {
    const p = buildMovePlan(input([market({ portfolio: null, earn: { shares: 0n, pending: { shares: 7n, unlockSlot: 5_000n }, requestsPaused: false } })]));
    const ex = step(p, "earn-execute");
    expect(ex?.status).toBe("waiting");
    expect(ex?.waitSlots).toBe(4_000n);
    expect(step(p, "earn-request")?.status).toBe("done");
    expect(nextActions(p).some((a) => a.kinds[0] === "earn-execute")).toBe(false);
    expect(summarizePlan(p)).toBe("waiting");
  });

  it("cooldown elapsed: execute is ready", () => {
    const p = buildMovePlan(input([market({ portfolio: null, earn: { shares: 0n, pending: { shares: 7n, unlockSlot: 900n }, requestsPaused: false } })]));
    expect(step(p, "earn-execute")?.status).toBe("ready");
  });

  it("Earn shares with no request: request ready, execute waiting; paused vault: request blocked", () => {
    const e = { shares: 3n, pending: null, requestsPaused: false };
    let p = buildMovePlan(input([market({ portfolio: null, earn: e })]));
    expect(step(p, "earn-request")?.status).toBe("ready");
    expect(step(p, "earn-execute")?.status).toBe("waiting");
    p = buildMovePlan(input([market({ portfolio: null, earn: { ...e, requestsPaused: true } })]));
    expect(step(p, "earn-request")?.status).toBe("blocked");
  });

  it("no successor: deposit is unavailable and the plan stops at the wallet", () => {
    const m = market({ symbol: "PENGU" });
    const p = buildMovePlan(input([m]));
    expect(step(p, "deposit-market", m.slab)?.status).toBe("unavailable");
    expect(nextActions(p).some((a) => a.kinds[0].startsWith("deposit"))).toBe(false);
    expect(p.markets[0].successor).toBe("none");
  });

  it("v2.1 not live: deposit unavailable even with a mapped successor", () => {
    const p = buildMovePlan(input([market()], { v21Live: false }));
    expect(step(p, "deposit-market")?.status).toBe("unavailable");
    expect(p.markets[0].successor).toBe("v21-not-live");
  });

  it("deposit waits for every v1 step, then becomes ready", () => {
    let p = buildMovePlan(input([market({ portfolio: { capital: 5n, releasedPnl: 0n, openLegs: 1, closeOnly: false } })]));
    expect(step(p, "deposit-market")?.status).toBe("waiting");
    // funds home (flat, nothing left on v1): the deposit step stays offered, so resume never loses it
    p = buildMovePlan(input([market({ portfolio: { capital: 0n, releasedPnl: 0n, openLegs: 0, closeOnly: false } })]));
    expect(step(p, "deposit-market")?.status).toBe("ready");
  });

  it("resume after partial completion skips done steps and picks the next one", () => {
    const before = buildMovePlan(input([market({ portfolio: { capital: 5n, releasedPnl: 0n, openLegs: 1, closeOnly: false } })]));
    expect(nextActions(before)[0].kinds).toEqual(["close"]);
    const after = buildMovePlan(input([market({ portfolio: { capital: 5n, releasedPnl: 0n, openLegs: 0, closeOnly: false } })]));
    expect(step(after, "close")?.status).toBe("done");
    expect(nextActions(after).map((a) => a.kinds[0])).toEqual(["withdraw"]);
  });

  it("idempotent: planning twice from the same chain state yields the same plan", () => {
    const i = input([market({ creatorFeeAtoms: 4n, earn: { shares: 1n, pending: null, requestsPaused: false } })]);
    expect(buildMovePlan(i)).toEqual(buildMovePlan(i));
  });

  it("already on v2.1: deposit is done and the plan completes", () => {
    const p = buildMovePlan(input([market({ portfolio: { capital: 0n, releasedPnl: 0n, openLegs: 0, closeOnly: false }, v21: { marketCapital: 9n, earnShares: 0n } })]));
    expect(step(p, "deposit-market")?.status).toBe("done");
    expect(summarizePlan(p)).toBe("complete");
  });

  it("creator fees claim is independent of the position", () => {
    const p = buildMovePlan(input([market({ creatorFeeAtoms: 10n, portfolio: { capital: 0n, releasedPnl: 0n, openLegs: 3, closeOnly: true } })]));
    expect(step(p, "claim-creator-fee")?.status).toBe("ready");
  });

  it("no step kind can build tag 103 or 104 (v2.1-only wind-down / bound prefix)", () => {
    const p = buildMovePlan(input([market({ creatorFeeAtoms: 1n, earn: { shares: 1n, pending: null, requestsPaused: false }, portfolio: { capital: 1n, releasedPnl: 0n, openLegs: 1, closeOnly: true } })]));
    for (const s of p.markets.flatMap((m) => m.steps)) expect(s.kind).not.toMatch(/wind|adl|bound/i);
  });

  it("copy has no jargon or emoji", () => {
    const p = buildMovePlan(input([market({ earn: { shares: 1n, pending: { shares: 1n, unlockSlot: 2_000n }, requestsPaused: true }, creatorFeeAtoms: 1n })]));
    for (const s of p.markets.flatMap((m) => m.steps)) {
      expect(s.line).not.toMatch(/h-lock|ADL|tag \d|PDA|slab|\p{Extended_Pictographic}/u);
    }
  });
});
