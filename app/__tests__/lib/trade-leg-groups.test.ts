// @vitest-environment node
/**
 * M-2: "Close 100%" over ~3× the per-fill cap put every leg in ONE transaction (4 legs ≈ 1.47M
 * CU > the 1.4M ceiling). Legs are now packed by the CU budget into several transactions, every
 * one simulated before signing, all signed with ONE approval, broadcast in order.
 */
import { describe, it, expect, vi } from "vitest";
import { TransactionInstruction, PublicKey, Transaction } from "@solana/web3.js";
import {
  CU_PER_TRADE_LEG_ESTIMATE,
  CU_TX_RESERVE,
  SINGLE_TX_MAX_LEGS,
  groupLegs,
  isComputeExhausted,
  legsPerTxForBudget,
  planLegGroups,
  sendLegGroups,
  PartialLegSendError,
  type LegGroupSimulation,
} from "@/lib/trade-leg-groups";
import { chunkCloseSize } from "@/lib/closeChunks";
import { MAX_TX_COMPUTE_UNITS } from "@/lib/compute-budget";

const P = new PublicKey("ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB");
const legIx = (q: bigint) => new TransactionInstruction({ programId: P, keys: [], data: Buffer.from(q.toString()) });
const crank = new TransactionInstruction({ programId: P, keys: [], data: Buffer.from([5]) });
const buildGroupIxs = (g: bigint[], i: number) => [...(i === 0 ? [crank] : []), ...g.map(legIx)];
const tradeLegs = (ixs: TransactionInstruction[]) => ixs.filter((x) => x.data[0] !== 5).length;

/** A chain that costs `perLeg` CU per trade leg (+30k for a crank) and has a 1.4M ceiling. */
const chain = (perLeg: number) => async (ixs: TransactionInstruction[]): Promise<LegGroupSimulation> => {
  const cu = tradeLegs(ixs) * perLeg + (ixs.includes(crank) ? 30_000 : 0) + 10_000;
  return cu > MAX_TX_COMPUTE_UNITS
    ? { consumed: null, err: { InstructionError: [ixs.length - 1, "ComputationalBudgetExceeded"] }, logs: ["Program x consumed 1400000 of 1400000 compute units", "Program x failed: exceeded CUs meter at BPF instruction"], rpcFailed: false, simulated: ixs }
    : { consumed: cu, err: null, logs: [], rpcFailed: false, simulated: ixs };
};
const refusal = (sim: LegGroupSimulation) => Object.assign(new Error("refused"), { sim });

describe("budget planning", () => {
  it("the static bound is 3 legs per tx and the single-tx path stops at 2", () => {
    expect(legsPerTxForBudget()).toBe(3);
    expect(Math.floor((MAX_TX_COMPUTE_UNITS - CU_TX_RESERVE) / CU_PER_TRADE_LEG_ESTIMATE)).toBe(3);
    expect(SINGLE_TX_MAX_LEGS).toBe(2);
  });
  it("groupLegs keeps order and every leg exactly once", () => {
    expect(groupLegs([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(groupLegs([1, 2], 3)).toEqual([[1, 2]]);
  });
  it("compute exhaustion is recognised from the error and from the logs", () => {
    expect(isComputeExhausted({ err: { InstructionError: [1, "ComputationalBudgetExceeded"] }, logs: [], consumed: null })).toBe(true);
    expect(isComputeExhausted({ err: { InstructionError: [1, { Custom: 1 }] }, logs: ["Program x failed: exceeded CUs meter at BPF instruction"], consumed: null })).toBe(true);
    expect(isComputeExhausted({ err: { InstructionError: [1, { Custom: 21 }] }, logs: [], consumed: null })).toBe(false);
  });
});

describe("planLegGroups — every group simulated, re-planned on exhaustion", () => {
  const close = chunkCloseSize(-4_000_000n, 1_000_000n); // 4 legs: a 4× position closed 100%

  it("negative control: the old shape (all 4 legs in one tx) exhausts compute at ~367k/leg", async () => {
    const sim = await chain(367_000)(buildGroupIxs(close, 0));
    expect(isComputeExhausted(sim)).toBe(true);
  });

  it("4 legs at ~290k/leg (devnet #2731: ≤1.16M) fit ONE transaction — no needless split", async () => {
    const plan = await planLegGroups({ legs: close, buildGroupIxs }, { simulate: chain(290_000), refusal });
    expect(plan.groups.map((g) => g.length)).toEqual([4]);
  });

  it("4 legs at ~367k/leg → re-planned from 4 to 3 per tx: 2 transactions (3 + 1), each under 1.4M", async () => {
    const plan = await planLegGroups({ legs: close, buildGroupIxs }, { simulate: chain(367_000), refusal });
    expect(plan.groups.map((g) => g.length)).toEqual([3, 1]);
    expect(plan.groups.flat().reduce((a, b) => a + b, 0n)).toBe(-4_000_000n);
    for (const u of plan.units) expect(u).toBeLessThanOrEqual(MAX_TX_COMPUTE_UNITS);
    expect(plan.ixs[0][0]).toBe(crank);
    expect(plan.ixs[1].includes(crank)).toBe(false);
  });

  it("heavier legs (~460k) don't fit 3 → re-planned to 2 + 2", async () => {
    const simulate = vi.fn(chain(460_000));
    const plan = await planLegGroups({ legs: close, buildGroupIxs }, { simulate, refusal });
    expect(plan.perTx).toBe(2);
    expect(plan.groups.map((g) => g.length)).toEqual([2, 2]);
  });

  it("a real refusal (not compute) throws before anything is signed", async () => {
    const simulate = async (ixs: TransactionInstruction[]): Promise<LegGroupSimulation> => ({
      consumed: null, err: { InstructionError: [1, { Custom: 21 }] }, logs: [], rpcFailed: false, simulated: ixs,
    });
    await expect(planLegGroups({ legs: close, buildGroupIxs }, { simulate, refusal })).rejects.toThrow("refused");
  });
});

describe("sendLegGroups — one approval, ordered broadcast, partial reporting", () => {
  const close = chunkCloseSize(-4_000_000n, 1_000_000n);
  const deps = () => ({
    simulate: chain(367_000),
    refusal,
    buildTx: vi.fn((_ixs: TransactionInstruction[], _cu: number) => new Transaction()),
    signAll: vi.fn(async (txs: Transaction[]) => txs),
    broadcast: vi.fn(async () => "sig"),
  });

  it("signs ALL transactions in one signAll call, then broadcasts each in order", async () => {
    const d = deps();
    let n = 0;
    d.broadcast.mockImplementation(async () => `sig${++n}`);
    const r = await sendLegGroups({ legs: close, buildGroupIxs }, d);
    expect(d.signAll).toHaveBeenCalledTimes(1);
    expect(d.signAll.mock.calls[0][0]).toHaveLength(2);
    expect(r.signatures).toEqual(["sig1", "sig2"]);
    expect(d.buildTx.mock.calls.map((c) => c[1] as number).every((u) => u <= MAX_TX_COMPUTE_UNITS)).toBe(true);
  });

  it("a refusal in ANY group means the wallet never opens", async () => {
    const d = deps();
    d.simulate = async (ixs) =>
      ixs.includes(crank) ? chain(367_000)(ixs) : { consumed: null, err: { InstructionError: [0, { Custom: 9 }] }, logs: [], rpcFailed: false, simulated: ixs };
    await expect(sendLegGroups({ legs: close, buildGroupIxs }, d)).rejects.toThrow("refused");
    expect(d.signAll).not.toHaveBeenCalled();
  });

  it("first tx fails → the plain error; a later tx fails → PartialLegSendError with what landed", async () => {
    const d1 = deps();
    d1.broadcast.mockRejectedValueOnce(new Error("boom"));
    await expect(sendLegGroups({ legs: close, buildGroupIxs }, d1)).rejects.toThrow("boom");

    const d2 = deps();
    d2.broadcast.mockResolvedValueOnce("sigA").mockRejectedValueOnce(new Error("blockhash expired"));
    const err = await sendLegGroups({ legs: close, buildGroupIxs }, d2).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PartialLegSendError);
    expect((err as PartialLegSendError).landedSignatures).toEqual(["sigA"]);
    expect((err as PartialLegSendError).landedLegs).toBe(3);
    expect((err as PartialLegSendError).totalLegs).toBe(4);
  });
});
