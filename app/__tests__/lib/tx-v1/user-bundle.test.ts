// @vitest-environment node
/**
 * sendUserBundle / planUserBundle: v1 only when the wallet + cluster support it AND it cuts the
 * transaction count; fallback exactly once and only before anything was submitted. Every rule has
 * a negative control.
 */
import { describe, it, expect, vi } from "vitest";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  BundleDoesNotFitError,
  PartialBundleError,
  USER_BUNDLE_HEAP_BYTES,
  assembleSignedV1,
  planUserBundle,
  sendUserBundle,
  splitV1Wire,
  txV1ModeFromEnv,
  WalletAlteredMessageError,
  type UserBundleDeps,
  type PackGroup,
  type TxV1Mode,
} from "@/lib/tx-v1/user-bundle";
import type { RawTxSigner } from "@/lib/tx-v1/wallet-raw-signer";
import { SimulationRefusal, buildBatchTx } from "@/lib/tx";
import { TX_LEGACY_MAX_BYTES, TX_V1_MAX_BYTES, compileV1Message } from "@/lib/v21/sdk";

const walletKp = Keypair.fromSeed(new Uint8Array(32).fill(3));
const payer = walletKp.publicKey;
const PROG = new PublicKey(new Uint8Array(32).fill(9));
const BH = "GHtXQBpHnMXhoLGsryeDY7i6bGqTC2LGqS11Kf3rKmFS";
const FEE = 50_000;
const conn = new Connection("http://127.0.0.1:1"); // never used: every dep is injected

function key(seed: number, i: number): PublicKey {
  return new PublicKey(Uint8Array.from({ length: 32 }, (_, j) => (j === 0 ? seed : j === 1 ? i + 1 : 7)));
}
/** One wrapper-like instruction: payer + `n` fresh accounts + `dataLen` bytes. */
function ix(seed: number, n: number, dataLen: number, extraSigner?: PublicKey): TransactionInstruction {
  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    ...Array.from({ length: n }, (_, i) => ({ pubkey: key(seed, i), isSigner: false, isWritable: i % 2 === 0 })),
  ];
  if (extraSigner) keys.push({ pubkey: extraSigner, isSigner: true, isWritable: true });
  return new TransactionInstruction({ programId: PROG, keys, data: Buffer.alloc(dataLen, seed) });
}
/** 6 groups of ~300 B each: 3+ legacy transactions, 1 v1 transaction (bytes bind). */
const BYTE_BOUND: PackGroup<number>[] = Array.from({ length: 6 }, (_, k) => ({ instructions: [ix(10 + k, 8, 24)], computeUnits: 20_000, tag: k }));
/** 9 small groups at 300k CU: CU binds (4 per tx) in every format. */
const CU_BOUND: PackGroup<number>[] = Array.from({ length: 9 }, (_, k) => ({ instructions: [ix(40 + k, 2, 8)], computeUnits: 300_000, tag: k }));

/** A v1-capable fake wallet: signs the payer slot of each wire with walletKp. */
function v1Signer(over: Partial<RawTxSigner> = {}): RawTxSigner & { calls: Uint8Array[][] } {
  const calls: Uint8Array[][] = [];
  return {
    source: "wallet-adapter",
    name: "FakeV1",
    versions: new Set<unknown>(["legacy", 0, 1]),
    supportsV1: true,
    calls,
    async signRaw(wires) {
      calls.push([...wires]);
      return wires.map((w) => {
        const { message } = splitV1Wire(w);
        const out = new Uint8Array(w);
        out.set(ed25519.sign(message, walletKp.secretKey.slice(0, 32)), message.length); // slot 0 = payer
        return out;
      });
    },
    ...over,
  };
}

interface Recorder {
  deps: UserBundleDeps;
  sentV1: Uint8Array[];
  sentLegacy: Uint8Array[];
  signLegacy: ReturnType<typeof vi.fn>;
  simulateV1: ReturnType<typeof vi.fn>;
}
function recorder(rawSigner: RawTxSigner | null, over: Partial<UserBundleDeps> = {}): Recorder {
  const sentV1: Uint8Array[] = [];
  const sentLegacy: Uint8Array[] = [];
  const signLegacy = vi.fn(async (txs: Transaction[]) => txs.map((t) => (t.partialSign(walletKp), t)));
  const simulateV1 = vi.fn(async () => ({ err: null, logs: [] as string[] }));
  const deps: UserBundleDeps = {
    clusterSupportsV1: async () => true,
    getBlockhash: async () => BH,
    getPriorityFee: async () => FEE,
    simulateLegacy: async () => {},
    simulateV1,
    signLegacy,
    sendLegacy: async (tx) => {
      const w = tx.serialize();
      sentLegacy.push(new Uint8Array(w));
      return bs58.encode(tx.signature!);
    },
    sendV1: async (w) => {
      sentV1.push(w);
      return bs58.encode(splitV1Wire(w).signatures[0]!);
    },
    confirm: async () => {},
    rawSigner,
    ...over,
  };
  return { deps, sentV1, sentLegacy, signLegacy, simulateV1 };
}
const wallet = { publicKey: payer };

describe("planUserBundle (pure gate)", () => {
  const base = { groups: BYTE_BOUND, payer, priorityMicroLamportsPerCu: FEE };
  it("byte-bound bundle: v1 when wallet + cluster + flag allow, and it cuts the tx count", () => {
    const p = planUserBundle({ ...base, mode: "auto", walletV1: true, clusterV1: true });
    expect(p.format).toBe("v1");
    expect(p.reason).toBe("fewer-transactions");
    expect(p.txs).toHaveLength(1);
    expect(p.fallback!.txs.length).toBeGreaterThanOrEqual(2);
    expect(p.txs[0]!.bytes).toBeLessThanOrEqual(TX_V1_MAX_BYTES);
    for (const t of p.fallback!.txs) expect(t.bytes).toBeLessThanOrEqual(TX_LEGACY_MAX_BYTES);
  });
  it.each<[TxV1Mode, boolean, boolean, string]>([
    ["off", true, true, "flag-off"],
    ["auto", false, true, "wallet-no-v1"],
    ["on", false, true, "wallet-no-v1"],
    ["auto", true, false, "cluster-no-v1"],
    ["on", true, false, "cluster-no-v1"],
  ])("negative control: mode=%s wallet=%s cluster=%s -> legacy (%s)", (mode, walletV1, clusterV1, reason) => {
    const p = planUserBundle({ ...base, mode, walletV1, clusterV1 });
    expect(p.format).toBe("legacy");
    expect(p.reason).toBe(reason);
    expect(p.v1).toBeNull();
  });
  it("CU-bound bundle stays legacy in auto even with a v1 wallet (same tx count: no benefit)", () => {
    const p = planUserBundle({ groups: CU_BOUND, payer, mode: "auto", walletV1: true, clusterV1: true, priorityMicroLamportsPerCu: FEE });
    expect(p.format).toBe("legacy");
    expect(p.reason).toBe("no-benefit");
    expect(p.v1!.txs.length).toBe(p.fallback!.txs.length);
  });
  it("mode=on forces v1 for a capable wallet even without benefit", () => {
    const p = planUserBundle({ groups: CU_BOUND, payer, mode: "on", walletV1: true, clusterV1: true });
    expect(p.format).toBe("v1");
    expect(p.reason).toBe("forced-on");
  });
  it("a group too big for legacy: v1 if allowed, typed error otherwise", () => {
    const big: PackGroup[] = [{ instructions: [ix(90, 40, 200)], computeUnits: 100_000 }];
    expect(planUserBundle({ groups: big, payer, mode: "auto", walletV1: true, clusterV1: true }).reason).toBe("fallback-cannot-fit");
    expect(() => planUserBundle({ groups: big, payer, mode: "auto", walletV1: false, clusterV1: true })).toThrow(BundleDoesNotFitError);
  });
  it("env flag parsing defaults to auto", () => {
    expect(txV1ModeFromEnv(undefined)).toBe("auto");
    expect(txV1ModeFromEnv("garbage")).toBe("auto");
    expect(txV1ModeFromEnv("off")).toBe("off");
    expect(txV1ModeFromEnv("ON")).toBe("on");
  });
});

describe("sendUserBundle", () => {
  it("wallet WITHOUT v1: never builds v1 (no 0x81 byte reaches the wallet or the RPC)", async () => {
    const signer = v1Signer({ supportsV1: false, versions: new Set<unknown>(["legacy", 0]) });
    const r = recorder(signer);
    const out = await sendUserBundle({ connection: conn, wallet, groups: BYTE_BOUND, mode: "auto", deps: r.deps });
    expect(out.format).toBe("legacy");
    expect(signer.calls).toHaveLength(0);
    expect(r.sentV1).toHaveLength(0);
    expect(r.simulateV1).not.toHaveBeenCalled();
    expect(r.sentLegacy.length).toBeGreaterThanOrEqual(2);
    for (const w of r.sentLegacy) {
      expect(w[0]).toBe(1); // legacy: shortvec signature count, never the v1 version byte
      expect(w.includes(0x81) && w[0] === 0x81).toBe(false);
    }
    expect(r.signLegacy).toHaveBeenCalledTimes(1); // one approval for the whole batch
  });

  it("no Standard signer at all (legacy-only adapter): legacy, cluster not even queried", async () => {
    const cluster = vi.fn(async () => true);
    const r = recorder(null, { clusterSupportsV1: cluster });
    const out = await sendUserBundle({ connection: conn, wallet, groups: BYTE_BOUND, mode: "on", deps: r.deps });
    expect(out.format).toBe("legacy");
    expect(cluster).not.toHaveBeenCalled();
  });

  it("wallet advertising v1: one v1 tx within 4096 B, one wallet call, all signatures verify", async () => {
    const signer = v1Signer();
    const r = recorder(signer);
    const out = await sendUserBundle({ connection: conn, wallet, groups: BYTE_BOUND, mode: "auto", deps: r.deps });
    expect(out.format).toBe("v1");
    expect(out.fellBack).toBeNull();
    expect(signer.calls).toHaveLength(1);
    expect(r.sentV1).toHaveLength(1);
    expect(r.sentLegacy).toHaveLength(0);
    const w = r.sentV1[0]!;
    expect(w[0]).toBe(0x81);
    expect(w.length).toBeLessThanOrEqual(TX_V1_MAX_BYTES);
    expect(w.length).toBeGreaterThan(TX_LEGACY_MAX_BYTES);
    const { message, signatures } = splitV1Wire(w);
    expect(ed25519.verify(signatures[0]!, message, payer.toBytes())).toBe(true);
    expect(out.signatures).toEqual([bs58.encode(signatures[0]!)]);
  });

  it("v1 with a keypair co-signer: its slot is ours, the payer slot is the wallet's, both verify", async () => {
    const co = Keypair.fromSeed(new Uint8Array(32).fill(5));
    const groups: PackGroup[] = [...BYTE_BOUND.slice(0, 5), { instructions: [ix(77, 3, 8, co.publicKey)], computeUnits: 10_000 }];
    const r = recorder(v1Signer());
    const out = await sendUserBundle({ connection: conn, wallet, groups, signers: [co], mode: "auto", deps: r.deps });
    expect(out.format).toBe("v1");
    const { message, signatures } = splitV1Wire(r.sentV1[0]!);
    expect(signatures).toHaveLength(2);
    expect(ed25519.verify(signatures[0]!, message, payer.toBytes())).toBe(true);
    expect(ed25519.verify(signatures[1]!, message, co.publicKey.toBytes())).toBe(true);
  });

  it.each([
    "Reached end of buffer unexpectedly",
    "WalletSignTransactionError: Unexpected error",
    "-32603",
  ])("wallet v1-signing failure (%s): falls back to legacy EXACTLY once, nothing v1 sent", async (message) => {
    const signRaw = vi.fn(async () => {
      throw Object.assign(new Error(message), { code: message === "-32603" ? -32603 : undefined });
    });
    const r = recorder(v1Signer({ signRaw }));
    const onFallback = vi.fn();
    const out = await sendUserBundle({ connection: conn, wallet, groups: BYTE_BOUND, mode: "auto", deps: r.deps, onFallback });
    expect(out.format).toBe("legacy");
    expect(out.fellBack?.reason).toBe("wallet-cannot-sign-v1");
    expect(signRaw).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(r.signLegacy).toHaveBeenCalledTimes(1);
    expect(r.sentV1).toHaveLength(0);
    expect(r.sentLegacy).toHaveLength(out.plan.txs.length);
    expect(out.signatures).toHaveLength(out.plan.txs.length);
  });

  it("negative control: user rejection of the v1 prompt never falls back", async () => {
    const signRaw = vi.fn(async () => {
      throw Object.assign(new Error("User rejected the request."), { code: 4001 });
    });
    const r = recorder(v1Signer({ signRaw }));
    await expect(sendUserBundle({ connection: conn, wallet, groups: BYTE_BOUND, mode: "auto", deps: r.deps })).rejects.toThrow(/User rejected/);
    expect(r.signLegacy).not.toHaveBeenCalled();
    expect(r.sentLegacy).toHaveLength(0);
  });

  it("negative control: an unrelated wallet error (disconnected) is not a fallback", async () => {
    const signRaw = vi.fn(async () => {
      throw new Error("WalletNotConnectedError");
    });
    const r = recorder(v1Signer({ signRaw }));
    await expect(sendUserBundle({ connection: conn, wallet, groups: BYTE_BOUND, mode: "auto", deps: r.deps })).rejects.toThrow(/NotConnected/);
    expect(r.signLegacy).not.toHaveBeenCalled();
  });

  it("on-chain (program) error at send: no fallback, no second send", async () => {
    const sendV1 = vi.fn(async () => {
      throw new Error("RPC sendTransaction failed: -32002 Transaction simulation failed: Error processing Instruction 1: custom program error: 0x15");
    });
    const r = recorder(v1Signer(), { sendV1 });
    await expect(sendUserBundle({ connection: conn, wallet, groups: BYTE_BOUND, mode: "auto", deps: r.deps })).rejects.toThrow(/custom program error/);
    expect(sendV1).toHaveBeenCalledTimes(1);
    expect(r.signLegacy).not.toHaveBeenCalled();
    expect(r.sentLegacy).toHaveLength(0);
  });

  it("pre-sign v1 simulation program error: SimulationRefusal, wallet never opened, no fallback", async () => {
    const signer = v1Signer();
    const r = recorder(signer, { simulateV1: vi.fn(async () => ({ err: { InstructionError: [0, { Custom: 21 }] }, logs: ["x"] })) });
    await expect(sendUserBundle({ connection: conn, wallet, groups: BYTE_BOUND, mode: "auto", deps: r.deps })).rejects.toBeInstanceOf(SimulationRefusal);
    expect(signer.calls).toHaveLength(0);
    expect(r.signLegacy).not.toHaveBeenCalled();
  });

  it("v1 simulation RPC failure (node cannot decode v1): falls back before signing", async () => {
    const signer = v1Signer();
    const r = recorder(signer, {
      simulateV1: vi.fn(async () => {
        throw new Error("RPC simulateTransaction failed: -32602 failed to deserialize transaction");
      }),
    });
    const out = await sendUserBundle({ connection: conn, wallet, groups: BYTE_BOUND, mode: "auto", deps: r.deps });
    expect(out.fellBack?.reason).toBe("v1-simulation-rpc-failed");
    expect(signer.calls).toHaveLength(0);
    expect(out.format).toBe("legacy");
  });

  it("format rejection on the FIRST send: falls back once (nothing landed)", async () => {
    const sendV1 = vi.fn(async () => {
      throw new Error("RPC sendTransaction failed: -32602 invalid transaction: Transaction version (1) is not supported");
    });
    const r = recorder(v1Signer(), { sendV1 });
    const out = await sendUserBundle({ connection: conn, wallet, groups: BYTE_BOUND, mode: "auto", deps: r.deps });
    expect(out.fellBack?.reason).toBe("rpc-rejected-v1-format");
    expect(sendV1).toHaveBeenCalledTimes(1);
    expect(r.signLegacy).toHaveBeenCalledTimes(1);
  });

  it("negative control: format rejection AFTER a v1 tx landed never falls back (PartialBundleError)", async () => {
    // 12 groups -> 2 v1 txs (vs 5+ legacy): the second send is rejected.
    const groups = Array.from({ length: 12 }, (_, k) => ({ instructions: [ix(100 + k, 8, 24)], computeUnits: 20_000 }));
    let n = 0;
    const sendV1 = vi.fn(async (w: Uint8Array) => {
      if (n++ === 0) return bs58.encode(splitV1Wire(w).signatures[0]!);
      throw new Error("RPC sendTransaction failed: -32602 failed to deserialize");
    });
    const r = recorder(v1Signer(), { sendV1 });
    const err = await sendUserBundle({ connection: conn, wallet, groups, mode: "auto", deps: r.deps }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PartialBundleError);
    expect((err as PartialBundleError).signatures).toHaveLength(1);
    expect(r.signLegacy).not.toHaveBeenCalled();
    expect(r.sentLegacy).toHaveLength(0);
  });

  it("wallet that alters the v1 message: refused before sending, falls back", async () => {
    const signer = v1Signer({
      async signRaw(wires) {
        return wires.map((w) => {
          const c = new Uint8Array(w);
          c[c.length - 65] ^= 1; // flip a message byte
          return c;
        });
      },
    });
    const r = recorder(signer);
    const out = await sendUserBundle({ connection: conn, wallet, groups: BYTE_BOUND, mode: "auto", deps: r.deps });
    expect(out.fellBack?.reason).toBe("wallet-altered-message");
    expect(r.sentV1).toHaveLength(0);
  });

  it("flag OFF with a v1-capable wallet: legacy bytes identical to the existing batch builder", async () => {
    const r = recorder(v1Signer());
    const out = await sendUserBundle({ connection: conn, wallet, groups: BYTE_BOUND, mode: "off", deps: r.deps });
    expect(out.format).toBe("legacy");
    expect(r.simulateV1).not.toHaveBeenCalled();
    const expected = out.plan.txs.map((t) => {
      const tx = buildBatchTx({ instructions: t.instructions, computeUnits: Math.ceil(t.computeUnits * 1.2), priorityFeeMicroLamports: FEE, blockhash: BH, feePayer: payer });
      tx.partialSign(walletKp);
      return new Uint8Array(tx.serialize());
    });
    expect(r.sentLegacy).toEqual(expected);
    // And the groups are packed in order, each exactly once.
    expect(out.plan.txs.flatMap((t) => t.groups.map((g) => g.tag))).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("CU-bound bundle with a v1 wallet in auto: legacy (v1 adds wallet risk, no fewer txs)", async () => {
    const signer = v1Signer();
    const r = recorder(signer);
    const out = await sendUserBundle({ connection: conn, wallet, groups: CU_BOUND, mode: "auto", deps: r.deps });
    expect(out.format).toBe("legacy");
    expect(out.plan.reason).toBe("no-benefit");
    expect(signer.calls).toHaveLength(0);
  });

  it("v1 budget: heap frame, CU limit and total priority fee land in the config, no ComputeBudget ix", async () => {
    const r = recorder(v1Signer());
    await sendUserBundle({ connection: conn, wallet, groups: BYTE_BOUND, mode: "auto", deps: r.deps });
    const { message } = splitV1Wire(r.sentV1[0]!);
    const mask = message[4]! | (message[5]! << 8);
    expect(mask & 0b11111).toBe(0b11111); // fee + CU + loaded + heap
    const recompiled = compileV1Message({
      payer,
      instructions: BYTE_BOUND.flatMap((g) => g.instructions),
      recentBlockhash: BH,
      config: { computeUnitLimit: Math.ceil(6 * 20_000 * 1.2), heapSizeBytes: USER_BUNDLE_HEAP_BYTES, priorityFeeLamports: BigInt(Math.ceil((FEE * 144_000) / 1e6)) },
    });
    expect(message).toEqual(recompiled.message);
  });
});

describe("assembleSignedV1", () => {
  it("negative control: an unsigned payer slot does not verify", () => {
    const c = compileV1Message({ payer, instructions: [ix(1, 2, 2)], recentBlockhash: BH, config: { computeUnitLimit: 1000 } });
    const unsigned = new Uint8Array(c.txBytes);
    unsigned.set(c.message, 0);
    expect(() => assembleSignedV1(c, unsigned, unsigned)).toThrow(WalletAlteredMessageError);
  });
});
