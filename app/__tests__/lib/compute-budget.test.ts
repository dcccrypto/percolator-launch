// @vitest-environment node
/**
 * Every trade / close / batch sets an explicit, simulation-sized ComputeBudget limit (P1 final:
 * CPI trades ~13k CU heavier; single-leg BatchTradeCpi on asset 1 = 216,269 CU > 200k default).
 */
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ComputeBudgetInstruction, ComputeBudgetProgram, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ network: "devnet", rpcUrl: "https://api.devnet.solana.com" }),
  getNetwork: () => "devnet",
}));

import { sizeComputeUnitLimit, tradeCuCap, MAX_TX_COMPUTE_UNITS, CU_PER_LEG_CAP } from "@/lib/compute-budget";
import { sendTx } from "@/lib/tx";

describe("sizeComputeUnitLimit", () => {
  it("the P1-reported single-leg batch (216,269 CU) gets 216,269 * 1.30 + 50,000, under the 400k cap and over the 200k default", () => {
    const l = sizeComputeUnitLimit(216_269, { cap: tradeCuCap(1) });
    expect(l).toBe(Math.ceil(216_269 * 1.3) + 50_000);
    expect(l).toBeGreaterThan(200_000);
    expect(l).toBeLessThanOrEqual(CU_PER_LEG_CAP);
  });
  it("no simulation result => the cap (never the 200k default)", () => {
    expect(sizeComputeUnitLimit(null, { cap: 400_000 })).toBe(400_000);
    expect(sizeComputeUnitLimit(0, { cap: 400_000 })).toBe(400_000);
  });
  it("small txs keep a floor; a need above the cap follows the need, never past 1.4M", () => {
    expect(sizeComputeUnitLimit(1_000, { cap: 400_000 })).toBe(Math.ceil(1_000 * 1.3) + 50_000);
    expect(sizeComputeUnitLimit(500_000, { cap: 400_000 })).toBe(Math.ceil(500_000 * 1.3) + 50_000);
    expect(sizeComputeUnitLimit(1_300_000, { cap: 400_000 })).toBe(MAX_TX_COMPUTE_UNITS);
  });
  it("live regression: a ~248k simulated add that landed needing >290,368 CU gets enough headroom", () => {
    // 2026-10-01 PERC add: limit 290,392 (= 248k * 1.15 + 5k) was exhausted at 290,368 consumed.
    expect(sizeComputeUnitLimit(248_150, { cap: tradeCuCap(1) })).toBeGreaterThan(290_392 + 50_000);
  });
  it("cap scales per leg and stops at the tx maximum", () => {
    expect([1, 2, 3, 4].map(tradeCuCap)).toEqual([400_000, 800_000, 1_200_000, 1_400_000]);
  });
});

const PROGRAM = new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ");
const MARKET = new PublicKey("BPLPf1XT7HE9qKwAbf4cSqcDrV6VHJDS3FPeQ3GL7JPY");
const SIG = bs58.encode(new Uint8Array(64).fill(3));


function limitOf(tx: Transaction): number | null {
  for (const ix of tx.instructions) {
    if (!ix.programId.equals(ComputeBudgetProgram.programId)) continue;
    if (ComputeBudgetInstruction.decodeInstructionType(ix) === "SetComputeUnitLimit") return ComputeBudgetInstruction.decodeSetComputeUnitLimit(ix).units;
  }
  return null;
}

describe("sendTx computeUnitsFromSim", () => {
  // These pin the sizing rule itself (flag off). The v2.2 floor on the signed limit: lib/v22/cu-floor-a3.test.ts.
  beforeEach(() => __setDevnetV22ForTest(false));
  afterEach(() => __setDevnetV22ForTest(null));
  function run(unitsConsumed: number | undefined, err: unknown = null) {
    const kp = Keypair.generate();
    const signed: Transaction[] = [];
    const conn = {
      rpcEndpoint: "https://percolator-playground.vercel.app/api/rpc",
      getRecentPrioritizationFees: vi.fn().mockResolvedValue([]),
      getBalance: vi.fn().mockResolvedValue(1_000_000_000),
      getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 10_000_000 }),
      getBlockHeight: vi.fn().mockResolvedValue(1),
      simulateTransaction: vi.fn().mockResolvedValue({ value: { err, logs: [], unitsConsumed } }),
      sendRawTransaction: vi.fn().mockResolvedValue(SIG),
      getSignatureStatuses: vi.fn().mockResolvedValue({ value: [{ confirmationStatus: "confirmed", err: null }] }),
    };
    const wallet = { publicKey: kp.publicKey, signTransaction: vi.fn(async (tx: Transaction) => { tx.partialSign(kp); signed.push(tx); return tx; }) };
    const seen: { limit: number; consumed: number | null }[] = [];
    const ix = new TransactionInstruction({ programId: PROGRAM, keys: [{ pubkey: MARKET, isSigner: false, isWritable: true }], data: Buffer.from([10]) });
    return { conn, wallet, signed, seen, ix };
  }
  it("the SIGNED tx carries the simulation-sized limit (216,269 -> 331,150)", async () => {
    const r = run(216_269);
    await sendTx({ connection: r.conn as never, wallet: r.wallet as never, instructions: [r.ix], computeUnitsFromSim: { cap: tradeCuCap(1) }, onComputeUnits: (x) => r.seen.push(x) });
    expect(r.seen).toEqual([{ limit: 331_150, consumed: 216_269 }]);
    expect(limitOf(r.signed[0])).toBe(331_150);
  });
  it("simulation unavailable => the explicit cap, not the 200k default", async () => {
    const r = run(undefined);
    await sendTx({ connection: r.conn as never, wallet: r.wallet as never, instructions: [r.ix], computeUnitsFromSim: { cap: 400_000 } });
    expect(limitOf(r.signed[0])).toBe(400_000);
  });
});

describe("every trade / close / batch sender uses it", () => {
  const src = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
  it("useTrade (opens AND closes: useClosePosition calls trade()), the tag-44 close", () => {
    expect(src("hooks/useTrade.ts")).toContain("computeUnitsFromSim: { cap: tradeCuCap(legs.length) },");
    expect(src("lib/limits/rebalance-close.ts")).toContain("computeUnitsFromSim: { cap: tradeCuCap(1) },");
    expect(src("hooks/useClosePosition.ts")).toMatch(/return trade\(\{|async \(\) => trade\(\{/);
  });
});
