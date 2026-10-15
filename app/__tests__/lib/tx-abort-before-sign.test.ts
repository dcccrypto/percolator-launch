// @vitest-environment node
/**
 * GH#2623 in sendTx: the abort signal was checked only at entry and before a blockhash-expiry
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

import { sendTx, sendTxWaiting, isTxCancelledError } from "@/lib/tx";
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

describe("sendTx: an abort during the attempt never opens the wallet", () => {
  it("abort while the pre-sign simulation is in flight (green): no wallet, TxCancelledError", async () => {
    net.value = "devnet";
    const events: string[] = [];
    const ac = new AbortController();
    const w = wallet(events);
    const out = await settle(sendTx({ connection: conn(events, () => ac.abort()), wallet: w, instructions: [ix()], abortSignal: ac.signal }));
    expect(isTxCancelledError(out.err)).toBe(true);
    expect(w.signTransaction).not.toHaveBeenCalled();
    expect(events).not.toContain("broadcast");
  });

  it("abort while the CU-gate simulation is in flight (green): no wallet", async () => {
    net.value = "devnet";
    const events: string[] = [];
    const ac = new AbortController();
    const w = wallet(events);
    const out = await settle(
      sendTx({ connection: conn(events, () => ac.abort()), wallet: w, instructions: [ix()], computeUnitsFromSim: { cap: 400_000 }, abortSignal: ac.signal }),
    );
    expect(isTxCancelledError(out.err)).toBe(true);
    expect(w.signTransaction).not.toHaveBeenCalled();
  });

  it("the atomic mainnet path (signAndSendTransaction) is covered too", async () => {
    net.value = "mainnet";
    const events: string[] = [];
    const ac = new AbortController();
    const kp = Keypair.generate();
    const signAndSend = vi.fn(async (_tx: Transaction | VersionedTransaction) => ({ signature: SIG }));
    const w = { publicKey: kp.publicKey, signTransaction: vi.fn(), signAndSendTransaction: signAndSend };
    const out = await settle(sendTx({ connection: conn(events, () => ac.abort()), wallet: w as never, instructions: [ix()], abortSignal: ac.signal }));
    net.value = "devnet";
    expect(isTxCancelledError(out.err)).toBe(true);
    expect(signAndSend).not.toHaveBeenCalled();
  });

  it("CONTROL: an abort after the wallet signed still broadcasts and confirms", async () => {
    net.value = "devnet";
    const events: string[] = [];
    const ac = new AbortController();
    const w = wallet(events, () => ac.abort());
    const out = await settle(sendTx({ connection: conn(events), wallet: w, instructions: [ix()], abortSignal: ac.signal }));
    expect(out.err).toBeUndefined();
    expect(out.sig).toBe(SIG);
    expect(events).toContain("broadcast");
  });

  it("CONTROL: without an abort signal nothing changes", async () => {
    net.value = "devnet";
    const events: string[] = [];
    const w = wallet(events);
    const out = await settle(sendTx({ connection: conn(events), wallet: w, instructions: [ix()] }));
    expect(out.sig).toBe(SIG);
    expect(w.signTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("sendTxWaiting: Stop during the round that turns green ends quietly", () => {
  it("abort inside the green re-simulation: WaitStoppedError (the ticket's quiet stop), no wallet", async () => {
    net.value = "devnet";
    const events: string[] = [];
    const ac = new AbortController();
    const w = wallet(events);
    // Two stale rounds, then the third simulation is green, and the user presses Stop during it.
    const out = await settle(
      sendTxWaiting({
        connection: conn(events, (n) => { if (n === 2) ac.abort(); }, 2), wallet: w, instructions: [ix()],
        waitDelaysMs: [1, 1], keepWaiting: true, abortSignal: ac.signal,
      }),
    );
    expect((out.err as Error | undefined)?.name).toBe("WaitStoppedError");
    expect(w.signTransaction).not.toHaveBeenCalled();
  });
});
