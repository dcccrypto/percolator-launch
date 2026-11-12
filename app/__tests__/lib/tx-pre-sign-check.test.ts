// @vitest-environment node
/**
 * Delta review MED-A: `preSignCheck` runs on every attempt right before the wallet is asked to sign (after planning, simulation and any wait);
 * throwing refuses with nothing signed or broadcast. (Harness from tx-abort-before-sign.test.ts.)
 * Original header: GH#2623 in sendTx: the abort signal was checked only at entry and before a blockhash-expiry
 * retry. A signal that fired DURING an attempt (Stop, or leaving the market, while its planning
 * or simulation was in flight) still opened the wallet once the simulation came back green. It
 * is now re-checked after the attempt's last await, before either wallet call. A signature that
 * already exists is never dropped: aborting after signing still broadcasts and confirms.
 */
import { describe, expect, it, vi } from "vitest";
import { Keypair, Transaction, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

const net = vi.hoisted(() => ({ value: "devnet" as "devnet" | "mainnet" }));
vi.mock("@/lib/config", () => ({
  getConfig: () => ({ network: net.value, rpcUrl: "https://api.devnet.solana.com" }),
  getNetwork: () => net.value,
}));

import { sendTx, sendTxWaiting } from "@/lib/tx";
import { resolveDevnetProgramIds } from "@/lib/program-ids";
import { WRAPPER_ERR } from "@/lib/wrapper-errors";

const WRAPPER = resolveDevnetProgramIds().wrapper;
const SIG = bs58.encode(new Uint8Array(64).fill(7));
const stale = { InstructionError: [0, { Custom: WRAPPER_ERR.EngineStale }] };

/** `onSim(n)` runs inside the n-th simulation (0-based), before it resolves; `staleRounds` refuse first. */
function conn(events: string[], onSim: (n: number) => void = () => {}, staleRounds = 0) {
  let sims = 0;
  return {
    rpcEndpoint: "https://percolator-playground.vercel.app/api/rpc",
    getRecentPrioritizationFees: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue(1_000_000_000),
    getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 10_000_000 }),
    getBlockHeight: vi.fn().mockResolvedValue(1),
    simulateTransaction: vi.fn(async () => {
      const n = sims++;
      onSim(n);
      const err = n < staleRounds ? stale : null;
      events.push(err ? "simulate:stale" : "simulate:green");
      return { value: { err, logs: err ? [`Program ${WRAPPER} failed: custom program error: 0x13`] : [], unitsConsumed: 50_000 } };
    }),
    sendRawTransaction: vi.fn(async () => { events.push("broadcast"); return SIG; }),
    getSignatureStatuses: vi.fn(async () => ({ value: [{ confirmationStatus: "confirmed", err: null }] })),
  } as never;
}
function wallet(events: string[], onSign: () => void = () => {}) {
  const kp = Keypair.generate();
  return {
    publicKey: kp.publicKey,
    signTransaction: vi.fn(async (tx: Transaction) => { events.push("wallet-sign"); onSign(); tx.partialSign(kp); return tx; }),
  };
}
const ix = () => new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.from([1]) });
const settle = (p: Promise<string>) => p.then((sig) => ({ sig, err: undefined as unknown }), (err: unknown) => ({ sig: undefined, err }));


describe("sendTx: preSignCheck is the last gate before the wallet", () => {
  it("throws -> no wallet, no broadcast, the error surfaces", async () => {
    net.value = "devnet";
    const events: string[] = [];
    const w = wallet(events);
    const out = await settle(sendTx({ connection: conn(events), wallet: w, instructions: [ix()], preSignCheck: async () => { events.push("pre-sign"); throw new Error("busy fee rose"); } }));
    expect((out.err as Error).message).toBe("busy fee rose");
    expect(w.signTransaction).not.toHaveBeenCalled();
    expect(events).not.toContain("broadcast");
    expect(events).toContain("simulate:green"); // it ran after the simulation, not before
    expect(events.indexOf("pre-sign")).toBeGreaterThan(events.indexOf("simulate:green"));
  });
  it("passes -> the wallet signs and the order is broadcast, after the check", async () => {
    net.value = "devnet";
    const events: string[] = [];
    const w = wallet(events);
    const out = await settle(sendTx({ connection: conn(events), wallet: w, instructions: [ix()], preSignCheck: async () => { events.push("pre-sign"); } }));
    expect(out.err).toBeUndefined();
    expect(events.indexOf("pre-sign")).toBeLessThan(events.indexOf("wallet-sign"));
  });
  it("no check given: unchanged", async () => {
    net.value = "devnet";
    const events: string[] = [];
    const w = wallet(events);
    const out = await settle(sendTx({ connection: conn(events), wallet: w, instructions: [ix()] }));
    expect(out.err).toBeUndefined();
    expect(w.signTransaction).toHaveBeenCalledTimes(1);
  });
  it("after a market wait (one stale round, then green): the check runs AFTER the wait, once, right before the wallet", async () => {
    net.value = "devnet";
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const events: string[] = [];
      const w = wallet(events);
      const p = settle(sendTxWaiting({ connection: conn(events, () => {}, 1), wallet: w, instructions: [ix()], waitDelaysMs: [10], preSignCheck: async () => { events.push("pre-sign"); } }));
      await vi.advanceTimersByTimeAsync(1_000);
      const out = await p;
      expect(out.err).toBeUndefined();
      expect(events.filter((e) => e === "pre-sign")).toHaveLength(1);
      expect(events.indexOf("pre-sign")).toBeGreaterThan(events.indexOf("simulate:stale"));
      expect(events.indexOf("pre-sign")).toBeLessThan(events.indexOf("wallet-sign"));
    } finally {
      vi.useRealTimers();
    }
  });
});
