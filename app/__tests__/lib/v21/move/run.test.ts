import { describe, expect, it, vi } from "vitest";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { assertNoV21OnlyTags, guardAction, runMove, type Executors } from "@/lib/v21/move/run";
import { assertV1Program, assertV21Program, isV1CloseOnly, resolveV21ProgramIds, V1_PROGRAM_IDS, V1_CLOSE_ONLY_LABEL } from "@/lib/v21/move/ids";
import { __setMoveFlowForTest, isMoveFlowEnabled } from "@/lib/v21/move/flag";
import { __setDevnetV21ForTest } from "@/lib/v21/flag";
import { isRiskIncreasing, v1BlocksOrder } from "@/lib/v21/move/close-only";
import { input, market, pk, SOL_SLAB } from "./fixtures";
import type { MoveInput } from "@/lib/v21/move/plan";

const V21 = { wrapper: pk(), matcher: pk(), nft: pk(), stake: pk() };
const flat = { capital: 5n, releasedPnl: 0n, openLegs: 0, closeOnly: false };
const open = { capital: 5n, releasedPnl: 0n, openLegs: 1, closeOnly: false };

describe("flag", () => {
  it("off by default; needs BOTH flags; nothing renders when off", () => {
    __setDevnetV21ForTest(null);
    __setMoveFlowForTest(null);
    expect(isMoveFlowEnabled()).toBe(false);
    __setMoveFlowForTest(true); // Move on, v2.1 off
    expect(isMoveFlowEnabled()).toBe(false);
    __setDevnetV21ForTest(true);
    expect(isMoveFlowEnabled()).toBe(true);
    __setMoveFlowForTest(null);
    __setDevnetV21ForTest(null);
  });
  it("env path: NEXT_PUBLIC_V21_MOVE alone (v2.1 flag off) enables nothing", () => {
    const prev = process.env.NEXT_PUBLIC_V21_MOVE;
    process.env.NEXT_PUBLIC_V21_MOVE = "1";
    __setMoveFlowForTest(null);
    __setDevnetV21ForTest(false);
    expect(isMoveFlowEnabled()).toBe(false);
    __setDevnetV21ForTest(true);
    expect(isMoveFlowEnabled()).toBe(true);
    __setDevnetV21ForTest(null);
    if (prev === undefined) delete process.env.NEXT_PUBLIC_V21_MOVE; else process.env.NEXT_PUBLIC_V21_MOVE = prev;
  });
  it("flag off => no v1 label, no ticket restriction", () => {
    expect(isV1CloseOnly(V1_PROGRAM_IDS.wrapper, false)).toBe(false);
    expect(v1BlocksOrder({ v1CloseOnly: isV1CloseOnly(V1_PROGRAM_IDS.wrapper, false), existing: 0n, direction: "long", size: 5n })).toBe(false);
  });
  it("flag on: label only on the v1 wrapper", () => {
    expect(V1_CLOSE_ONLY_LABEL).toBe("v1 · close-only");
    expect(isV1CloseOnly(V1_PROGRAM_IDS.wrapper, true)).toBe(true);
    expect(isV1CloseOnly(V21.wrapper, true)).toBe(false);
    expect(isV1CloseOnly(null, true)).toBe(false);
  });
});

describe("close-only ticket policy", () => {
  it("opening and adding are blocked; reducing and closing are not; flipping is", () => {
    expect(isRiskIncreasing(0n, "long", 1n)).toBe(true);
    expect(isRiskIncreasing(10n, "long", 1n)).toBe(true);
    expect(isRiskIncreasing(10n, "short", 4n)).toBe(false);
    expect(isRiskIncreasing(10n, "short", 10n)).toBe(false);
    expect(isRiskIncreasing(10n, "short", 11n)).toBe(true);
    expect(isRiskIncreasing(-10n, "long", 10n)).toBe(false);
    expect(isRiskIncreasing(-10n, "short", 1n)).toBe(true);
  });
  it("close-only blocks risk, never a reduce", () => {
    expect(v1BlocksOrder({ v1CloseOnly: true, existing: 0n, direction: "long", size: 1n })).toBe(true);
    expect(v1BlocksOrder({ v1CloseOnly: true, existing: 5n, direction: "short", size: 5n })).toBe(false);
  });
});

describe("program id guards", () => {
  it("wrong program id mapping is rejected both ways", () => {
    expect(() => assertV1Program(V1_PROGRAM_IDS.wrapper)).not.toThrow();
    expect(() => assertV1Program(V21.wrapper)).toThrow(/not the v1 wrapper/);
    expect(() => assertV21Program(V21.wrapper, V21)).not.toThrow();
    expect(() => assertV21Program(V1_PROGRAM_IDS.wrapper, V21)).toThrow();
    expect(() => assertV21Program(V21.wrapper, null)).toThrow();
  });
  it("v2.1 ids that equal any v1 id are refused", () => {
    expect(resolveV21ProgramIds({ ...V21 })).toEqual(V21);
    expect(resolveV21ProgramIds({ ...V21, nft: V1_PROGRAM_IDS.nft })).toBeNull();
    expect(resolveV21ProgramIds({ ...V21, stake: "not-a-key" })).toBeNull();
    expect(resolveV21ProgramIds({})).toBeNull();
  });
  it("tags 103/104 are never sent to the v1 wrapper", () => {
    const v1 = new PublicKey(V1_PROGRAM_IDS.wrapper);
    const ix = (tag: number, pid = v1) => new TransactionInstruction({ programId: pid, keys: [], data: Buffer.from([tag, 0]) });
    expect(() => assertNoV21OnlyTags(V1_PROGRAM_IDS.wrapper, [ix(44), ix(90)])).not.toThrow();
    expect(() => assertNoV21OnlyTags(V1_PROGRAM_IDS.wrapper, [ix(103)])).toThrow(/v2\.1-only/);
    expect(() => assertNoV21OnlyTags(V1_PROGRAM_IDS.wrapper, [ix(104)])).toThrow(/v2\.1-only/);
    // the same tag against the v2.1 program is not this guard's business
    expect(() => assertNoV21OnlyTags(V1_PROGRAM_IDS.wrapper, [ix(104, new PublicKey(V21.wrapper))])).not.toThrow();
  });
  it("guardAction: deposits need v2.1, v1 steps need v1, never mixed", () => {
    const dep = { slab: SOL_SLAB, kinds: ["deposit-market" as const], simulate: true };
    const cls = { slab: SOL_SLAB, kinds: ["close" as const], simulate: true };
    expect(() => guardAction(dep, V1_PROGRAM_IDS.wrapper, V21)).not.toThrow();
    expect(() => guardAction(dep, V1_PROGRAM_IDS.wrapper, null)).toThrow();
    expect(() => guardAction(cls, V1_PROGRAM_IDS.wrapper, V21)).not.toThrow();
    expect(() => guardAction(cls, V21.wrapper, V21)).toThrow();
    expect(() => guardAction({ ...dep, kinds: ["close", "deposit-market"] }, V1_PROGRAM_IDS.wrapper, V21)).toThrow(/never in one/);
  });
});

/** A tiny chain: executing a step mutates the state the next scan returns. */
function chain(initial: MoveInput, apply: (kind: string, i: MoveInput) => MoveInput) {
  let state = initial;
  const sent: string[] = [];
  const executors: Executors = {};
  const exec = (kind: Parameters<typeof apply>[0]) => async () => {
    sent.push(kind);
    state = apply(kind, state);
    return `sig-${sent.length}`;
  };
  for (const k of ["close", "withdraw", "earn-request", "earn-execute", "claim-creator-fee", "deposit-market", "deposit-earn"] as const) executors[k] = exec(k);
  return { scan: async () => state, executors, sent };
}

describe("runMove (auto-resume loop)", () => {
  it("close -> withdraw -> deposit, each re-planned from chain state", async () => {
    const c = chain(input([market({ portfolio: open })]), (kind, s) => {
      const m = s.markets[0];
      if (kind === "close") return { ...s, markets: [{ ...m, portfolio: { ...flat } }] };
      if (kind === "withdraw") return { ...s, markets: [{ ...m, portfolio: { ...flat, capital: 0n } }] }; // funds now in wallet
      if (kind === "deposit-market") return { ...s, markets: [{ ...m, v21: { marketCapital: 5n, earnShares: 0n } }] };
      return s;
    });
    const r = await runMove({ scan: c.scan, executors: c.executors, v1Wrapper: V1_PROGRAM_IDS.wrapper, v21: V21 });
    expect(c.sent).toEqual(["close", "withdraw", "deposit-market"]);
    expect(r.stop.reason).toBe("complete");
  });

  it("never sends a withdraw while a position is open (close first, in order)", async () => {
    const c = chain(input([market({ portfolio: open })]), (kind, s) => (kind === "close" ? { ...s, markets: [{ ...s.markets[0], portfolio: { ...flat, capital: 0n } }] } : s));
    await runMove({ scan: c.scan, executors: c.executors, v1Wrapper: V1_PROGRAM_IDS.wrapper, v21: V21 });
    expect(c.sent[0]).toBe("close");
    expect(c.sent.indexOf("withdraw")).toBe(-1);
  });

  it("Earn cooldown: stops as waiting without sending execute", async () => {
    const c = chain(input([market({ portfolio: null, earn: { shares: 2n, pending: null, requestsPaused: false } })]), (kind, s) =>
      kind === "earn-request" ? { ...s, markets: [{ ...s.markets[0], earn: { shares: 0n, pending: { shares: 2n, unlockSlot: 9_999n }, requestsPaused: false } }] } : s);
    const r = await runMove({ scan: c.scan, executors: c.executors, v1Wrapper: V1_PROGRAM_IDS.wrapper, v21: V21 });
    expect(c.sent).toEqual(["earn-request"]);
    expect(r.stop.reason).toBe("waiting");
  });

  it("no successor: stops after bringing funds home, never calls a deposit executor", async () => {
    const dep = vi.fn(async () => "x");
    const c = chain(input([market({ symbol: "PENGU", portfolio: open })]), (kind, s) =>
      kind === "close" ? { ...s, markets: [{ ...s.markets[0], portfolio: { ...flat } }] } : kind === "withdraw" ? { ...s, markets: [{ ...s.markets[0], portfolio: { ...flat, capital: 0n }, v21: { marketCapital: 0n, earnShares: 0n } }] } : s);
    c.executors["deposit-market"] = dep;
    const r = await runMove({ scan: c.scan, executors: c.executors, v1Wrapper: V1_PROGRAM_IDS.wrapper, v21: V21 });
    expect(dep).not.toHaveBeenCalled();
    expect(r.stop.reason).toBe("complete");
  });

  it("a step with no executor is a handoff, not a send", async () => {
    const r = await runMove({ scan: async () => input([market({ portfolio: open })]), executors: {}, v1Wrapper: V1_PROGRAM_IDS.wrapper, v21: V21 });
    expect(r.stop).toMatchObject({ reason: "handoff", action: { kinds: ["close"] } });
    expect(r.sent).toEqual([]);
  });

  it("a step that never clears is reported as no-progress, not retried forever", async () => {
    const exec = vi.fn(async () => "sig");
    const r = await runMove({ scan: async () => input([market({ portfolio: open })]), executors: { close: exec }, v1Wrapper: V1_PROGRAM_IDS.wrapper, v21: V21 });
    expect(r.stop.reason).toBe("no-progress");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("an executor error stops the run and surfaces the step", async () => {
    const r = await runMove({ scan: async () => input([market({ portfolio: open })]), executors: { close: async () => { throw new Error("boom"); } }, v1Wrapper: V1_PROGRAM_IDS.wrapper, v21: V21 });
    expect(r.stop.reason).toBe("error");
  });

  it("a wrong v1 wrapper is rejected before anything is sent", async () => {
    const exec = vi.fn(async () => "sig");
    await expect(runMove({ scan: async () => input([market({ portfolio: open })]), executors: { close: exec }, v1Wrapper: V21.wrapper, v21: V21 })).rejects.toThrow();
    expect(exec).not.toHaveBeenCalled();
  });

  it("nothing to move", async () => {
    const r = await runMove({ scan: async () => input([market({ portfolio: null })]), executors: {}, v1Wrapper: V1_PROGRAM_IDS.wrapper, v21: V21 });
    expect(r.stop.reason).toBe("nothing-to-move");
  });
});
