// @vitest-environment node
import { describe, it, expect } from "vitest";
import { Keypair, TransactionInstruction } from "@solana/web3.js";
import { planTakerCrank, type TakerCrankSim } from "@/lib/taker-crank";

/**
 * A chain model of what devnet measured on 2026-10-01 (wrapper bd4fe5f8):
 *  - crank + trade in ONE transaction: the trade fails Custom(21) EngineLockActive;
 *  - trade alone: clean, unless the taker portfolio needs maintenance (`needsCrank`),
 *    in which case it is refused until a crank has LANDED in an earlier transaction.
 */
const PROGRAM = Keypair.generate().publicKey;
const ix = (tag: number) => new TransactionInstruction({ programId: PROGRAM, keys: [], data: Buffer.from([tag]) });
const CRANK = ix(5);
const TRADE = ix(10);

function chain(needsCrank: boolean) {
  let cranked = false;
  const simulate = async (list: TransactionInstruction[]): Promise<TakerCrankSim> => {
    const ci = list.indexOf(CRANK);
    const ti = list.indexOf(TRADE);
    if (ci >= 0 && ti > ci) return { err: { InstructionError: [ti, { Custom: 21 }] }, rpcFailed: false };
    if (ti >= 0 && needsCrank && !cranked) return { err: { InstructionError: [ti, { Custom: 19 }] }, rpcFailed: false };
    return { err: null, rpcFailed: false };
  };
  const land = (list: TransactionInstruction[]) => { if (list.includes(CRANK)) cranked = true; };
  return { simulate, land };
}

/** What useTrade sends for a plan: an optional separate crank tx, then the trade tx. */
function txsFor(plan: "none" | "separate-tx"): TransactionInstruction[][] {
  return plan === "separate-tx" ? [[CRANK], [TRADE]] : [[TRADE]];
}

async function run(needsCrank: boolean, txs?: TransactionInstruction[][]) {
  const c = chain(needsCrank);
  const plan = await planTakerCrank(c.simulate, [TRADE], CRANK);
  const sent = txs ?? txsFor(plan);
  let last: TakerCrankSim = { err: null, rpcFailed: false };
  for (const t of sent) { last = await c.simulate(t); if (!last.err) c.land(t); else break; }
  return { plan, sent, last };
}

describe("planTakerCrank: the taker crank never shares the trade's transaction", () => {
  it("healthy taker: no crank at all, the trade lands", async () => {
    const r = await run(false);
    expect(r.plan).toBe("none");
    expect(r.sent).toEqual([[TRADE]]);
    expect(r.last.err).toBeNull();
  });

  it("taker needing maintenance: crank as a SEPARATE prior tx, then the trade lands", async () => {
    const r = await run(true);
    expect(r.plan).toBe("separate-tx");
    expect(r.sent).toEqual([[CRANK], [TRADE]]);
    expect(r.last.err).toBeNull();
  });

  it("NEGATIVE CONTROL: the old same-tx prefix [crank, trade] is refused with 21 in both cases", async () => {
    for (const needs of [false, true]) {
      const r = await run(needs, [[CRANK, TRADE]]);
      expect(r.last.err).toEqual({ InstructionError: [1, { Custom: 21 }] });
    }
  });

  it("a 21 from the trade alone (keeper-side lag) is NOT cured by our crank: no crank sent", async () => {
    const lag = async (l: TransactionInstruction[]): Promise<TakerCrankSim> =>
      ({ err: l.includes(TRADE) ? { InstructionError: [l.indexOf(TRADE), { Custom: 21 }] } : null, rpcFailed: false });
    expect(await planTakerCrank(lag, [TRADE], CRANK)).toBe("none");
  });

  it("honours the simulator's compute-budget prefix when attributing the refusal", async () => {
    const PREFIX = [ix(200), ix(201)];
    const sim = async (l: TransactionInstruction[]): Promise<TakerCrankSim> => {
      const full = [...PREFIX, ...l];
      const ti = full.indexOf(TRADE);
      return { err: ti >= 0 ? { InstructionError: [ti, { Custom: 19 }] } : null, rpcFailed: false };
    };
    expect(await planTakerCrank(sim, [TRADE], CRANK, 2)).toBe("separate-tx");
    // A refusal by an instruction of ANOTHER program (here: index 0 = the prefix) is not ours to cure.
    const other = async (): Promise<TakerCrankSim> => ({ err: { InstructionError: [0, { Custom: 19 }] }, rpcFailed: false });
    expect(await planTakerCrank(other, [TRADE], CRANK, 2)).toBe("none");
  });

  it("no verdict (RPC failure) or a crank that itself fails: no crank is sent", async () => {
    const rpc = async (): Promise<TakerCrankSim> => ({ err: null, rpcFailed: true });
    expect(await planTakerCrank(rpc, [TRADE], CRANK)).toBe("none");
    const crankFails = async (l: TransactionInstruction[]): Promise<TakerCrankSim> =>
      ({ err: { InstructionError: [0, { Custom: l.includes(CRANK) ? 22 : 19 }] }, rpcFailed: false });
    expect(await planTakerCrank(crankFails, [TRADE], CRANK)).toBe("none");
  });
});

describe("council GO1106: a close carries the crank in its own tx when that simulates clean", () => {
  it("reducing + bundle clean: 'bundle' (one approval), and the trade-alone sim is not even needed", async () => {
    const seen: TransactionInstruction[][] = [];
    const sim = async (l: TransactionInstruction[]): Promise<TakerCrankSim> => { seen.push(l); return { err: null, rpcFailed: false }; };
    expect(await planTakerCrank(sim, [TRADE], CRANK, 2, true)).toBe("bundle");
    expect(seen).toEqual([[CRANK, TRADE]]);
  });

  it("reducing but the bundle is refused (the 21 lag gate): falls back to the old plan, unchanged", async () => {
    // The 2026-10-01 chain model: [crank, trade] -> 21; trade alone -> 19 while the portfolio needs maintenance.
    expect(await planTakerCrank(chain(true).simulate, [TRADE], CRANK, 0, true)).toBe("separate-tx");
    expect(await planTakerCrank(chain(false).simulate, [TRADE], CRANK, 0, true)).toBe("none");
  });

  it("NEGATIVE CONTROL: an opening (non-reducing) order never tries the bundle", async () => {
    const seen: TransactionInstruction[][] = [];
    const sim = async (l: TransactionInstruction[]): Promise<TakerCrankSim> => { seen.push(l); return { err: null, rpcFailed: false }; };
    expect(await planTakerCrank(sim, [TRADE], CRANK, 2, false)).toBe("none");
    expect(seen.some((l) => l.includes(CRANK))).toBe(false);
  });

  it("an RPC failure on the bundle sim falls back too", async () => {
    let n = 0;
    const sim = async (): Promise<TakerCrankSim> => (n++ === 0 ? { err: null, rpcFailed: true } : { err: null, rpcFailed: false });
    expect(await planTakerCrank(sim, [TRADE], CRANK, 0, true)).toBe("none");
  });
});
