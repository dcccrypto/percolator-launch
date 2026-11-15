// @vitest-environment node
//
// Coverage for the small pure helpers and fallbacks of lib/tx.ts that the sendTx-focused
// suites never reach: fee clamping, the priority-fee estimate, error-message extraction,
// the not-broadcast marker, batch building / signing, and the wait-loop decisions.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ComputeBudgetProgram, Keypair, SendTransactionError, SystemProgram, Transaction } from "@solana/web3.js";

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ network: "devnet", rpcUrl: "https://api.devnet.solana.com" }),
  getNetwork: () => "devnet",
}));

import {
  LIGHTHOUSE_PROGRAM_ID,
  PRIORITY_FEE_MAX_MICRO_LAMPORTS,
  SimulationRefusal,
  WAIT_DELAYS_MS,
  WaitExhaustedError,
  WaitStoppedError,
  atomicSendMayHaveBroadcast,
  buildBatchTx,
  clampPriorityFee,
  confirmSignatureByPolling,
  extractTxErrorMessage,
  getClockDriftWarning,
  getPriorityFee,
  isNotBroadcast,
  isWaitableRefusal,
  markNotBroadcast,
  priorityFeeFallback,
  signAllCompat,
  waitBudgetSpent,
  waitOnRefusal,
} from "@/lib/tx";
import { WRAPPER_ERR } from "@/lib/wrapper-errors";
import { resolveDevnetProgramIds } from "@/lib/program-ids";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("clampPriorityFee / priorityFeeFallback", () => {
  it("floors a valid price and clamps to the ceiling", () => {
    expect(clampPriorityFee(1234.9)).toBe(1234);
    expect(clampPriorityFee(0)).toBe(0);
    expect(clampPriorityFee(PRIORITY_FEE_MAX_MICRO_LAMPORTS * 5)).toBe(PRIORITY_FEE_MAX_MICRO_LAMPORTS);
  });
  it("non-finite or negative input uses the fallback (default 100k, or the one given)", () => {
    expect(clampPriorityFee(NaN)).toBe(100_000);
    expect(clampPriorityFee(-1)).toBe(100_000);
    expect(clampPriorityFee(Infinity, 42)).toBe(42);
    expect(clampPriorityFee(-5, 10_000_000)).toBe(PRIORITY_FEE_MAX_MICRO_LAMPORTS);
  });
  it("priorityFeeFallback is within [0, ceiling]", () => {
    const f = priorityFeeFallback();
    expect(f).toBeGreaterThanOrEqual(0);
    expect(f).toBeLessThanOrEqual(PRIORITY_FEE_MAX_MICRO_LAMPORTS);
  });
});

describe("getPriorityFee", () => {
  // The result is cached module-wide for a while, so each case gets a fresh module.
  async function fresh() {
    vi.resetModules();
    return import("@/lib/tx");
  }
  const conn = (impl: () => Promise<unknown>) => ({ getRecentPrioritizationFees: vi.fn(impl) }) as any;

  it("uses the 75th percentile, capped at 10x the fallback", async () => {
    const tx = await fresh();
    const fb = tx.priorityFeeFallback();
    const fees = [1, 2, 3, 4].map((n) => ({ slot: n, prioritizationFee: n * 10 }));
    const c = conn(async () => fees);
    expect(await tx.getPriorityFee(c)).toBe(Math.min(40, fb * 10));
    // cached: no second RPC
    await tx.getPriorityFee(c);
    expect(c.getRecentPrioritizationFees).toHaveBeenCalledTimes(1);
  });
  it("caps a huge spike at 10x the fallback (below the hard ceiling)", async () => {
    vi.stubEnv("NEXT_PUBLIC_PRIORITY_FEE", "1000");
    const tx = await fresh();
    expect(tx.priorityFeeFallback()).toBe(1000);
    const c = conn(async () => [{ slot: 1, prioritizationFee: 9e12 }]);
    const fee = await tx.getPriorityFee(c);
    expect(fee).toBe(10_000);
  });
  it("falls back on an empty list, an all-zero list and an RPC error", async () => {
    for (const impl of [async () => [], async () => [{ slot: 1, prioritizationFee: 0 }], async () => { throw new Error("rpc down"); }]) {
      const tx = await fresh();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(await tx.getPriorityFee(conn(impl))).toBe(tx.priorityFeeFallback());
    }
  });
});

describe("getClockDriftWarning", () => {
  it("is null when no drift has been measured", () => {
    expect(getClockDriftWarning()).toBeNull();
  });
});

describe("extractTxErrorMessage", () => {
  it("returns a placeholder when nothing is extractable", () => {
    expect(extractTxErrorMessage(null)).toBe("Unexpected error");
    expect(extractTxErrorMessage(undefined)).toBe("Unexpected error");
  });
  it("handles a bare string and a non-object primitive", () => {
    expect(extractTxErrorMessage("boom")).toContain("boom");
    expect(extractTxErrorMessage(42)).toContain("42");
  });
  it("walks cause/error/err and dedupes repeated messages", () => {
    const inner = new Error("inner failure");
    const outer = Object.assign(new Error("outer failure"), { cause: inner, error: { message: "inner failure" }, err: { message: "err branch" } });
    const msg = extractTxErrorMessage(outer);
    expect(msg).toContain("outer failure");
    expect(msg).toContain("err branch");
    expect(msg.split("inner failure").length - 1).toBe(1);
  });
  it("survives a cyclic cause chain", () => {
    const a: any = new Error("loop a");
    const b: any = new Error("loop b");
    a.cause = b;
    b.cause = a;
    expect(extractTxErrorMessage(a)).toContain("loop a");
  });
  it("stops descending past depth 4", () => {
    let e: any = new Error("level 6");
    for (let i = 5; i >= 0; i--) e = Object.assign(new Error(`level ${i}`), { cause: e });
    const msg = extractTxErrorMessage(e);
    expect(msg).toContain("level 0");
    expect(msg).toContain("level 4");
    expect(msg).not.toContain("level 5");
  });
  it("reads log arrays carried on the error", () => {
    const e = Object.assign(new Error("Simulation failed"), { logs: ["Program X failed: custom program error: 0x1"] });
    expect(extractTxErrorMessage(e)).toContain("custom program error: 0x1");
  });
  it("accepts a SendTransactionError", () => {
    const e = new SendTransactionError({ action: "send", signature: "sig", transactionMessage: "bad send", logs: ["Program log: Error: nope"] });
    expect(extractTxErrorMessage(e)).toContain("bad send");
  });
});

describe("markNotBroadcast / isNotBroadcast", () => {
  it("marks and keeps the same Error object", () => {
    const e = new Error("declined");
    expect(isNotBroadcast(e)).toBe(false);
    expect(markNotBroadcast(e)).toBe(e);
    expect(isNotBroadcast(e)).toBe(true);
    expect(e.message).toBe("declined");
  });
  it("wraps a string and a non-Error object", () => {
    expect(markNotBroadcast("plain").message).toBe("plain");
    expect(markNotBroadcast({ message: "obj msg" }).message).toContain("obj msg");
    const w = markNotBroadcast({ message: "obj msg" });
    expect(w).toBeInstanceOf(Error);
    expect(isNotBroadcast(w)).toBe(true);
  });
  it("finds the marker on a cause, but not beyond depth 4 or on non-Errors", () => {
    const marked = markNotBroadcast(new Error("root"));
    expect(isNotBroadcast(new Error("wrap", { cause: marked }))).toBe(true);
    let e: Error = marked;
    for (let i = 0; i < 4; i++) e = new Error(`w${i}`, { cause: e });
    expect(isNotBroadcast(e)).toBe(false);
    expect(isNotBroadcast("string")).toBe(false);
    expect(isNotBroadcast(null)).toBe(false);
  });
});

describe("atomicSendMayHaveBroadcast", () => {
  it("treats an already-processed / upstream-failed message as maybe sent, even inside a simulation failure", () => {
    expect(atomicSendMayHaveBroadcast(new Error("This transaction has already been processed"))).toBe(true);
    expect(atomicSendMayHaveBroadcast(new Error("Simulation failed. Message: upstream RPC request failed"))).toBe(true);
  });
  it("treats definite refusals as not sent", () => {
    expect(atomicSendMayHaveBroadcast(new Error("Transaction simulation failed: x"))).toBe(false);
    expect(atomicSendMayHaveBroadcast(new Error("User rejected the request"))).toBe(false);
  });
  it("matches the exact wallet decline messages along the cause chain", () => {
    const privy = new Error("Failed to connect to wallet", { cause: new Error("User exited the modal before submitting the transaction") });
    expect(atomicSendMayHaveBroadcast(privy)).toBe(false);
    expect(atomicSendMayHaveBroadcast(new Error("Transaction cancelled."))).toBe(false);
  });
  it("a 4xx status (but not 408) is a refusal; anything else is ambiguous", () => {
    expect(atomicSendMayHaveBroadcast(new Error("x"), "403 Forbidden")).toBe(false);
    expect(atomicSendMayHaveBroadcast(new Error("x"), "408 Request Timeout")).toBe(true);
    expect(atomicSendMayHaveBroadcast(new Error("socket hang up"))).toBe(true);
  });
});

describe("buildBatchTx", () => {
  it("prepends the compute-budget instructions, drops a Lighthouse injection, sets blockhash and payer", () => {
    const payer = Keypair.generate().publicKey;
    const transfer = SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1 });
    const lighthouse = new (transfer.constructor as any)({ programId: new (payer.constructor as any)(LIGHTHOUSE_PROGRAM_ID), keys: [], data: Buffer.alloc(0) });
    const tx = buildBatchTx({ instructions: [lighthouse, transfer], computeUnits: 300_000, priorityFeeMicroLamports: 777, blockhash: "11111111111111111111111111111111", feePayer: payer });
    expect(tx.instructions).toHaveLength(4);
    const budget = ComputeBudgetProgram.programId.toBase58();
    expect(ComputeBudgetProgram.programId.equals(tx.instructions[1].programId)).toBe(true);
    expect(tx.instructions[1].data.readUInt32LE(1)).toBe(300_000);
    expect(Number(tx.instructions[2].data.readBigUInt64LE(1))).toBe(777);
    expect(tx.instructions.slice(0, 3).every((i) => i.programId.toBase58() === budget)).toBe(true);
    expect(tx.instructions[3]).toBe(transfer);
    expect(tx.recentBlockhash).toBe("11111111111111111111111111111111");
    expect(tx.feePayer?.equals(payer)).toBe(true);
  });
});

describe("signAllCompat", () => {
  const txs = [new Transaction(), new Transaction()];
  txs[0].recentBlockhash = "A";
  txs[1].recentBlockhash = "B";
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  it("uses signAllTransactions once when available", async () => {
    const signAll = vi.fn(async (t: Transaction[]) => t);
    const signOne = vi.fn();
    expect(await signAllCompat({ signAllTransactions: signAll, signTransaction: signOne }, txs)).toBe(txs);
    expect(signAll).toHaveBeenCalledTimes(1);
    expect(signOne).not.toHaveBeenCalled();
  });
  it("falls back to sequential signTransaction in order", async () => {
    const order: Transaction[] = [];
    const signOne = vi.fn(async (t: Transaction) => { order.push(t); return t; });
    const out = await signAllCompat({ signTransaction: signOne }, txs);
    expect(out[0]).toBe(txs[0]);
    expect(out[1]).toBe(txs[1]);
    expect(order[0]).toBe(txs[0]);
    expect(order[1]).toBe(txs[1]);
  });
  it("throws when the wallet can sign nothing", async () => {
    await expect(signAllCompat({}, txs)).rejects.toThrow("does not support signAllTransactions or signTransaction");
  });
});

describe("confirmSignatureByPolling", () => {
  it("resolves once the signature is confirmed", async () => {
    const conn = { getSignatureStatuses: vi.fn(async () => ({ value: [{ confirmationStatus: "confirmed", err: null }] })) } as any;
    await expect(confirmSignatureByPolling(conn, "sig")).resolves.toBeUndefined();
    expect(conn.getSignatureStatuses).toHaveBeenCalledWith(["sig"], expect.anything());
  });
});

describe("wait-loop decisions", () => {
  const ids = resolveDevnetProgramIds();
  const refusal = (programId: string | null, code: number | null) => {
    const r = new SimulationRefusal({ InstructionError: [0, { Custom: code ?? 0 }] });
    return Object.assign(r, { programId, code });
  };
  const base = { attempt: 0, waitDelaysMs: WAIT_DELAYS_MS, keepWaiting: false, aborted: false };

  it("isWaitableRefusal: wrapper stale codes and matcher stale marks wait; anything else does not", () => {
    expect(isWaitableRefusal(refusal(String(ids.wrapper), WRAPPER_ERR.EngineStale))).toBe(true);
    expect(isWaitableRefusal(refusal(String(ids.wrapper), 999_999))).toBe(false);
    expect(isWaitableRefusal(refusal(String(ids.matcher), 8002))).toBe(true);
    expect(isWaitableRefusal(refusal(String(ids.matcher), 8003))).toBe(true);
    expect(isWaitableRefusal(refusal(String(ids.matcher), 1))).toBe(false);
    expect(isWaitableRefusal(refusal(Keypair.generate().publicKey.toBase58(), 8002))).toBe(false);
    expect(isWaitableRefusal(refusal(String(ids.wrapper), null))).toBe(false);
    expect(isWaitableRefusal(new Error("nope"))).toBe(false);
  });

  it("waitOnRefusal: waits, unless exhausted, aborted, not waitable, or shouldWait declines", () => {
    const e = refusal(String(ids.matcher), 8002);
    expect(waitOnRefusal(e, base)).toBe(true);
    expect(waitOnRefusal(e, { ...base, attempt: WAIT_DELAYS_MS.length })).toBe(false);
    expect(waitOnRefusal(e, { ...base, attempt: WAIT_DELAYS_MS.length, keepWaiting: true })).toBe(true);
    expect(waitOnRefusal(e, { ...base, attempt: 0, waitDelaysMs: [], keepWaiting: true })).toBe(false);
    expect(waitOnRefusal(e, { ...base, aborted: true })).toBe(false);
    expect(waitOnRefusal(new Error("x"), base)).toBe(false);
    expect(waitOnRefusal(e, { ...base, shouldWait: () => false })).toBe(false);
    expect(waitOnRefusal(e, { ...base, shouldWait: () => true })).toBe(true);
  });

  it("waitBudgetSpent: an undefined budget is never spent", () => {
    expect(waitBudgetSpent(1e9, undefined)).toBe(false);
    expect(waitBudgetSpent(99, 100)).toBe(false);
    expect(waitBudgetSpent(100, 100)).toBe(true);
  });

  it("the stop errors carry a name and say nothing was sent", () => {
    const cause = new Error("last refusal");
    const ex = new WaitExhaustedError(cause);
    expect(ex.name).toBe("WaitExhaustedError");
    expect(ex.cause).toBe(cause);
    expect(ex.message).toContain("nothing was sent");
    const st = new WaitStoppedError();
    expect(st.name).toBe("WaitStoppedError");
    expect(st.message).toContain("nothing was sent");
  });
});
