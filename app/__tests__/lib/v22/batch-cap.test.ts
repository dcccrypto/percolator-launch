/**
 * v2.2 leg cap (percolator-prog#546, FINAL): a transaction carries at most 4 trade legs (BatchTradeCpi accepts 1..=4; the portfolio holds 4).
 * The app packs a multi-leg order (e.g. Close 100% over the matcher's per-fill cap) with lib/trade-leg-groups.ts; with the v2.2 flag on the
 * plan can never put more than 4 legs in one transaction, whatever the simulation or the caller's `initialPerTx` says. Flag off: unchanged.
 */
import { afterEach, describe, expect, it } from "vitest";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { BATCH_MAX_LEGS_V22, WRAPPER_MAX_PORTFOLIO_ASSETS_V22 } from "@/lib/v22/sdk";
import { SINGLE_TX_MAX_LEGS, maxLegsPerTx, planLegGroups, type LegGroupSimulation } from "@/lib/trade-leg-groups";
import { MAX_TX_COMPUTE_UNITS } from "@/lib/compute-budget";

afterEach(() => __setDevnetV22ForTest(null));

const P = new PublicKey("ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB");
const legIx = (q: bigint) => new TransactionInstruction({ programId: P, keys: [], data: Buffer.from(q.toString()) });
const buildGroupIxs = (g: bigint[]) => g.map(legIx);
const cheap = async (ixs: TransactionInstruction[]): Promise<LegGroupSimulation> => ({ consumed: 50_000 * ixs.length, err: null, logs: [], rpcFailed: false, simulated: ixs });
const costly = (perLeg: number) => async (ixs: TransactionInstruction[]): Promise<LegGroupSimulation> => {
  const cu = ixs.length * perLeg + 10_000;
  return cu > MAX_TX_COMPUTE_UNITS
    ? { consumed: null, err: { InstructionError: [0, "ComputationalBudgetExceeded"] }, logs: ["Program x failed: exceeded CUs meter at BPF instruction"], rpcFailed: false, simulated: ixs }
    : { consumed: cu, err: null, logs: [], rpcFailed: false, simulated: ixs };
};
const refusal = () => new Error("refused");
const legs = (n: number) => Array.from({ length: n }, (_, i) => BigInt(i + 1));

describe("the cap constants", () => {
  it("are 4, the portfolio cap bounds the batch cap, and the single-tx path already stays under it", () => {
    expect(WRAPPER_MAX_PORTFOLIO_ASSETS_V22).toBe(4);
    expect(BATCH_MAX_LEGS_V22).toBe(4);
    expect(SINGLE_TX_MAX_LEGS).toBeLessThanOrEqual(BATCH_MAX_LEGS_V22);
  });
  it("maxLegsPerTx: 4 with the flag on, unbounded with it off", () => {
    __setDevnetV22ForTest(true);
    expect(maxLegsPerTx()).toBe(4);
    __setDevnetV22ForTest(false);
    expect(maxLegsPerTx()).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("planLegGroups on v2.2", () => {
  it("10 cheap legs: groups of at most 4, order kept, every leg exactly once", async () => {
    __setDevnetV22ForTest(true);
    const plan = await planLegGroups({ legs: legs(10), buildGroupIxs }, { simulate: cheap, refusal });
    expect(plan.groups.map((g) => g.length)).toEqual([4, 4, 2]);
    expect(plan.groups.flat()).toEqual(legs(10));
    expect(plan.perTx).toBe(4);
  });
  it("a caller asking for more per tx (initialPerTx 9) is clamped to 4", async () => {
    __setDevnetV22ForTest(true);
    const plan = await planLegGroups({ legs: legs(9), buildGroupIxs, initialPerTx: 9 }, { simulate: cheap, refusal });
    expect(Math.max(...plan.groups.map((g) => g.length))).toBe(4);
  });
  it("compute exhaustion still re-plans DOWN from the cap (4 legs at 367k each do not fit one tx: 3, then fewer)", async () => {
    __setDevnetV22ForTest(true);
    const plan = await planLegGroups({ legs: legs(8), buildGroupIxs }, { simulate: costly(367_000), refusal });
    expect(plan.perTx).toBe(3);
    expect(plan.groups.flat()).toEqual(legs(8));
  });
  it("fewer than 5 legs behave exactly as before", async () => {
    __setDevnetV22ForTest(true);
    const plan = await planLegGroups({ legs: legs(3), buildGroupIxs }, { simulate: cheap, refusal });
    expect(plan.groups).toHaveLength(1);
  });
});

describe("planLegGroups on v2.1 (flag off): unchanged", () => {
  it("10 cheap legs go in ONE group, exactly as on playground", async () => {
    __setDevnetV22ForTest(false);
    const plan = await planLegGroups({ legs: legs(10), buildGroupIxs }, { simulate: cheap, refusal });
    expect(plan.groups.map((g) => g.length)).toEqual([10]);
    expect(plan.perTx).toBe(10);
  });
});
