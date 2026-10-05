// @vitest-environment node
//
// sendTx({ selfHeal }) end to end against a mocked RPC that behaves like the
// engine on the live 2026-09-29 PAID market (domain-1 bucket lapsed): the
// user's trade reverts Custom(19) unless ExpireBackingBucket(d1) runs first.
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import type { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ network: "devnet", rpcUrl: "https://api.devnet.solana.com" }),
  getNetwork: () => "devnet",
}));

import { sendTx } from "@/lib/tx";
import type { SelfHealResult } from "@/lib/self-heal";

const PROGRAM = new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ");
const MARKET = new PublicKey("BPLPf1XT7HE9qKwAbf4cSqcDrV6VHJDS3FPeQ3GL7JPY");
const SIG = bs58.encode(new Uint8Array(64).fill(3));
const fixture = (name: string): Buffer =>
  Buffer.from(readFileSync(join(__dirname, "..", "fixtures", "v18-liveness", `${name}.b64`), "utf8").trim(), "base64");

function makeConn(marketFixture: string) {
  const simulateTransaction = vi.fn(async (vtx: VersionedTransaction) => {
    const ixs = vtx.message.compiledInstructions;
    const repaired = ixs.some((ix) => ix.data[0] === 89);
    return { value: { err: repaired ? null : { InstructionError: [ixs.length - 1, { Custom: 19 }] }, logs: [] } };
  });
  const conn = {
    rpcEndpoint: "https://percolator-playground.vercel.app/api/rpc",
    getRecentPrioritizationFees: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue(1_000_000_000),
    getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 10_000_000 }),
    getBlockHeight: vi.fn().mockResolvedValue(1),
    getAccountInfoAndContext: vi.fn().mockResolvedValue({
      context: { slot: 505580400 },
      value: { data: fixture(marketFixture), owner: PROGRAM, lamports: 1, executable: false },
    }),
    simulateTransaction,
    sendRawTransaction: vi.fn().mockResolvedValue(SIG),
    // Only the signature sendRawTransaction returns (SIG) is confirmed. A blanket "confirmed"
    // would make the R2-S7 landed check treat a send that THREW as landed (sendTx now knows the
    // signature before broadcasting), hiding the retry these tests exercise.
    getSignatureStatuses: vi.fn(async (sigs: string[]) => ({
      value: sigs.map((s) => (s === SIG ? { confirmationStatus: "confirmed", err: null } : null)),
    })),
  };
  return conn;
}

function makeWallet() {
  const kp = Keypair.generate();
  const signed: Transaction[] = [];
  return {
    signed,
    publicKey: kp.publicKey,
    signTransaction: vi.fn(async (tx: Transaction) => {
      tx.partialSign(kp);
      signed.push(tx);
      return tx;
    }),
  };
}

const tradeIx = () =>
  new TransactionInstruction({
    programId: PROGRAM,
    keys: [{ pubkey: MARKET, isSigner: false, isWritable: true }],
    data: Buffer.from([10, 0, 0, 0]),
  });

describe("sendTx selfHeal", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("PAID: the signed tx carries ExpireBackingBucket(d1) BEFORE the trade, and lands", async () => {
    const conn = makeConn("paid-market-v18-lapsed");
    const wallet = makeWallet();
    let heal: SelfHealResult | undefined;
    const sig = await sendTx({
      connection: conn as never,
      wallet,
      instructions: [tradeIx()],
      computeUnits: 600_000,
      selfHeal: { programId: PROGRAM, market: MARKET },
      onSelfHeal: (r) => { heal = r; },
    });
    expect(sig).toBe(SIG);
    expect(heal?.outcome).toBe("repaired");
    const ixs = wallet.signed[0].instructions;
    // [heapFrame, cuLimit, cuPrice, repair, trade]
    expect(ixs).toHaveLength(5);
    expect(Array.from(ixs[3].data)).toEqual([89, 1, 0]);
    expect(ixs[3].programId.equals(PROGRAM)).toBe(true);
    expect(ixs[4].data[0]).toBe(10);
    expect(conn.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("NEGATIVE CONTROL without selfHeal the same tx is never repaired and fails simulation", async () => {
    const conn = makeConn("paid-market-v18-lapsed");
    const wallet = makeWallet();
    await expect(
      sendTx({ connection: conn as never, wallet, instructions: [tradeIx()], computeUnits: 600_000 }),
    ).rejects.toThrow(/Custom|simulation/);
    expect(conn.getAccountInfoAndContext).not.toHaveBeenCalled();
    expect(conn.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("NEGATIVE CONTROL kill switch NEXT_PUBLIC_SELF_HEAL=0 disables it", async () => {
    vi.stubEnv("NEXT_PUBLIC_SELF_HEAL", "0");
    const conn = makeConn("paid-market-v18-lapsed");
    const wallet = makeWallet();
    await expect(
      sendTx({ connection: conn as never, wallet, instructions: [tradeIx()], selfHeal: { programId: PROGRAM, market: MARKET } }),
    ).rejects.toThrow();
    expect(conn.getAccountInfoAndContext).not.toHaveBeenCalled();
  });

  it("security LOW fix: a retry RE-PLANS — a repair landed by someone else meanwhile is not resent", async () => {
    // Attempt 0: PAID lapsed → repair prepended; the send hits a blockhash miss.
    // Meanwhile the keeper expired the bucket, so attempt 1 reads a healthy market
    // and must NOT carry the (now engine-rejected) ExpireBackingBucket again.
    const conn = makeConn("paid-market-v18-lapsed");
    let healthy = false;
    conn.getAccountInfoAndContext.mockImplementation(async () => {
      const r = {
        context: { slot: 505580400 },
        value: { data: fixture(healthy ? "pengu-market-v18-healthy" : "paid-market-v18-lapsed"), owner: PROGRAM, lamports: 1, executable: false },
      };
      return r;
    });
    conn.simulateTransaction.mockImplementation(async (vtx: VersionedTransaction) => {
      const ixs = vtx.message.compiledInstructions;
      const repaired = ixs.some((ix) => ix.data[0] === 89);
      if (healthy) return { value: { err: repaired ? { InstructionError: [3, { Custom: 19 }] } : null, logs: [] } };
      return { value: { err: repaired ? null : { InstructionError: [ixs.length - 1, { Custom: 19 }] }, logs: [] } };
    });
    conn.sendRawTransaction
      .mockImplementationOnce(async () => { healthy = true; throw new Error("Blockhash not found"); })
      .mockResolvedValue(SIG);
    const wallet = makeWallet();
    const outcomes: string[] = [];
    const sig = await sendTx({
      connection: conn as never,
      wallet,
      instructions: [tradeIx()],
      selfHeal: { programId: PROGRAM, market: MARKET },
      onSelfHeal: (r) => { outcomes.push(r.outcome); },
    });
    expect(sig).toBe(SIG);
    expect(outcomes).toEqual(["repaired", "no-repair-needed"]);
    expect(wallet.signed).toHaveLength(2);
    expect(wallet.signed[0].instructions.some((ix) => ix.data[0] === 89)).toBe(true);
    expect(wallet.signed[1].instructions.some((ix) => ix.data[0] === 89)).toBe(false);
  });

  it("NEGATIVE CONTROL healthy market: one account read, no extra simulation, instructions untouched", async () => {
    const conn = makeConn("pengu-market-v18-healthy");
    conn.simulateTransaction.mockResolvedValue({ value: { err: null, logs: [] } });
    const wallet = makeWallet();
    let heal: SelfHealResult | undefined;
    await sendTx({
      connection: conn as never,
      wallet,
      instructions: [tradeIx()],
      selfHeal: { programId: PROGRAM, market: MARKET },
      onSelfHeal: (r) => { heal = r; },
    });
    expect(heal?.outcome).toBe("no-repair-needed");
    expect(conn.getAccountInfoAndContext).toHaveBeenCalledTimes(1);
    // only sendTx's own pre-broadcast simulation
    expect(conn.simulateTransaction).toHaveBeenCalledTimes(1);
    expect(wallet.signed[0].instructions).toHaveLength(4);
  });
});
