// @vitest-environment node
//
// Node, not jsdom: sendTx's tx-build path calls
// ComputeBudgetProgram.requestHeapFrame, whose buffer-layout encoder rejects
// jsdom's realm-separated Uint8Array ("b must be a Uint8Array") — the same
// test-environment artifact __tests__/setup.ts documents for tweetnacl.
// Nothing in this file touches the DOM.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, Transaction } from "@solana/web3.js";
import bs58 from "bs58";

// The network sendTx sees via getNetwork(). Defaults to "mainnet" so every
// pre-existing test keeps its meaning: before the devnet gate existed, sendTx
// took the atomic signAndSendTransaction path on every network.
const netState = vi.hoisted(() => ({ network: "mainnet" as "mainnet" | "devnet" }));

// Mock getConfig before importing tx module
vi.mock("@/lib/config", () => ({
  getConfig: () => ({ network: "devnet", rpcUrl: "https://api.devnet.solana.com" }),
  getNetwork: () => netState.network,
}));

import { TransactionExpiredBlockheightExceededError } from "@solana/web3.js";
import { sendTx, estimateFees, getClockDriftWarning, isBlockhashExpiredError, isConfirmationTimeoutError, checkSignatureLanded, extractTxErrorMessage, TxCancelledError, isTxCancelledError } from "@/lib/tx";
import type { SendTxParams, FeeEstimate } from "@/lib/tx";

describe("sendTx", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws if wallet has no publicKey", async () => {
    const wallet = { publicKey: null, signTransaction: vi.fn() };
    await expect(
      sendTx({
        connection: {} as any,
        wallet,
        instructions: [],
      })
    ).rejects.toThrow("Wallet not connected");
  });

  it("throws if wallet has no signTransaction", async () => {
    const wallet = { publicKey: Keypair.generate().publicKey };
    await expect(
      sendTx({
        connection: {} as any,
        wallet: wallet as any,
        instructions: [],
      })
    ).rejects.toThrow("Wallet not connected");
  });

  it("GH#2623: throws TxCancelledError instead of signing when abortSignal is already aborted", async () => {
    // The create-market wizard's unmount cleanup aborts BETWEEN sequential
    // steps. Without this check, sendTx would build a tx and call
    // wallet.signTransaction (a fresh wallet popup) for a step the user has
    // already navigated away from. Checked before wallet.signTransaction is
    // ever reached — a bare `{}` connection proves nothing else is touched.
    const wallet = { publicKey: Keypair.generate().publicKey, signTransaction: vi.fn() };
    const controller = new AbortController();
    controller.abort();
    await expect(
      sendTx({
        connection: {} as any,
        wallet: wallet as any,
        instructions: [],
        abortSignal: controller.signal,
      })
    ).rejects.toThrow(TxCancelledError);
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });

  it("CONTROL: an abortSignal that has NOT fired does not block sendTx", async () => {
    // Distinguishes `abortSignal?.aborted` from a check that fires on the
    // mere PRESENCE of an abortSignal — every sequential create-market step
    // now passes one on every call (see useCreateMarket.ts), so a check that
    // fired unconditionally would block every step, not just cancelled ones.
    // A valid wallet reaches past the FIRST guard (unlike the null-publicKey
    // wallet used elsewhere in this file) so this exercises the abort check
    // specifically; `connection: {}` then fails for an UNRELATED reason
    // (no RPC methods), which is fine — the point is it's not TxCancelledError.
    const wallet = { publicKey: Keypair.generate().publicKey, signTransaction: vi.fn() };
    const controller = new AbortController(); // never aborted
    let threw: unknown;
    try {
      await sendTx({ connection: {} as any, wallet: wallet as any, instructions: [], abortSignal: controller.signal });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeDefined();
    expect(isTxCancelledError(threw)).toBe(false);
    expect(wallet.signTransaction).not.toHaveBeenCalled(); // failed before signing, for the unrelated reason
  });

  it("BUG 24: no longer performs the dead genesis-hash network check", async () => {
    // validateNetwork() used to compare the app's OWN configured Connection's
    // genesis hash against its own config — a tautology (the connection is
    // always built from that same config) that also 403'd in production
    // because getGenesisHash isn't in the RPC proxy's method allowlist (see
    // app/api/rpc/route.ts ALLOWED_RPC_METHODS). It could never actually catch
    // "wallet on a different network than the app" and was removed as dead
    // weight in the sendTx hot path. Assert sendTx no longer calls
    // getGenesisHash and never throws "Network mismatch".
    vi.resetModules();
    vi.mock("@/lib/config", () => ({
      getConfig: () => ({ network: "devnet", rpcUrl: "https://api.devnet.solana.com" }),
      getNetwork: () => netState.network,
    }));
    const { sendTx: freshSendTx } = await import("@/lib/tx");

    const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
    const getGenesisHash = vi.fn().mockResolvedValue(MAINNET_GENESIS);
    const conn = {
      rpcEndpoint: "https://api.devnet.solana.com",
      getGenesisHash,
      getRecentPrioritizationFees: vi.fn().mockResolvedValue([]),
      getBalance: vi.fn().mockResolvedValue(10_000_000),
      getLatestBlockhash: vi.fn().mockResolvedValue({
        blockhash: "11111111111111111111111111111111",
        lastValidBlockHeight: 123,
      }),
    } as any;
    const wallet = {
      publicKey: Keypair.generate().publicKey,
      signTransaction: vi.fn().mockRejectedValue(new Error("mock wallet stop")),
    };

    let caught: unknown;
    try {
      await freshSendTx({ connection: conn, wallet, instructions: [] });
    } catch (e) {
      caught = e;
    }
    // It may still reject for unrelated reasons (the wallet/connection mocks
    // here aren't a full sendTx harness) — the point is it's never
    // "Network mismatch", and getGenesisHash is never even called.
    expect((caught as Error | undefined)?.message).not.toContain("Network mismatch");
    expect(getGenesisHash).not.toHaveBeenCalled();
  });

  it("exports SendTxParams type with expected shape", () => {
    // Type-level test — verifying the interface exists and is importable
    const params: Partial<SendTxParams> = {
      computeUnits: 200_000,
      maxRetries: 2,
    };
    expect(params.computeUnits).toBe(200_000);
    expect(params.maxRetries).toBe(2);
  });
});


describe("extractTxErrorMessage", () => {
  it("preserves nested failing log lines when a wallet wraps the failure as unexpected, filtering noise", () => {
    const err = new Error("Unexpected error") as Error & { cause?: unknown };
    err.cause = {
      logs: [
        "Program log: Instruction: Trade",
        "Program failed: custom program error: 0x15",
      ],
    };

    const msg = extractTxErrorMessage(err);

    expect(msg).toContain("Unexpected error");
    expect(msg).toContain("custom program error: 0x15");
    // Non-failure log noise must NOT enter the thrown message — it drowns the
    // failing line and creates substring false positives downstream.
    expect(msg).not.toContain("Instruction: Trade");
  });

  it("preserves nested cause messages from wrapped transaction errors", () => {
    const err = new Error("Unexpected error") as Error & { cause?: unknown };
    err.cause = new Error("Transaction simulation failed: Error processing Instruction 0: custom program error: 0x13");

    const msg = extractTxErrorMessage(err);

    expect(msg).toContain("Unexpected error");
    expect(msg).toContain("custom program error: 0x13");
  });

  it("drops invoke/success log lines and caps admitted log lines at 12, preserving order", () => {
    const noisy = Array.from({ length: 30 }, (_, i) => `Program log: step ${i} ok`);
    const failures = Array.from({ length: 20 }, (_, i) => `Program log: failed check ${i}`);
    const err = new Error("boom") as Error & { cause?: unknown };
    err.cause = {
      logs: [
        "Program SomeProg1111111111111111111111111111111111 invoke [1]",
        ...noisy,
        ...failures,
        "Program SomeProg1111111111111111111111111111111111 success",
      ],
    };

    const msg = extractTxErrorMessage(err);
    const lines = msg.split("\n");

    expect(msg).not.toContain("invoke [1]");
    expect(msg).not.toContain("success");
    expect(msg).not.toContain("step 0 ok");
    // "boom" + capped 12 failure lines
    expect(lines.length).toBe(13);
    expect(lines[1]).toBe("Program log: failed check 0");
    expect(lines[12]).toBe("Program log: failed check 11");
  });
});

describe("sendTx — who submits: never the wallet on devnet (Solflare 'Network mismatch')", () => {
  // Tester report 2026-09-28: Solflare blocked "Initialize LP" and "Deposit &
  // finalize" with "Network mismatch — your network is devnet, but this
  // transaction is for mainnet", while the multi-signer steps and Reclaim went
  // through. Those two are the single-signer txs, i.e. the ones that reached the
  // atomic signAndSendTransaction branch, where the WALLET chooses the cluster it
  // submits to. We pass chain "solana:devnet" (PrivyProviderClient) and Privy
  // forwards it; Solflare still resolves the submit to mainnet.
  const SIG = bs58.encode(new Uint8Array(64).fill(7));

  afterEach(() => {
    netState.network = "mainnet";
  });

  const makeConn = () => {
    const sendRawTransaction = vi.fn().mockResolvedValue(SIG);
    const conn = {
      // The playground's real browser endpoint: no "devnet" in it.
      rpcEndpoint: "https://percolator-playground.vercel.app/api/rpc",
      getRecentPrioritizationFees: vi.fn().mockResolvedValue([]),
      getBalance: vi.fn().mockResolvedValue(1_000_000_000),
      getLatestBlockhash: vi.fn().mockResolvedValue({
        blockhash: "11111111111111111111111111111111",
        lastValidBlockHeight: 10_000_000,
      }),
      getBlockHeight: vi.fn().mockResolvedValue(1),
      simulateTransaction: vi.fn().mockResolvedValue({ value: { err: null, logs: [] } }),
      sendRawTransaction,
      getSignatureStatuses: vi
        .fn()
        .mockResolvedValue({ value: [{ confirmationStatus: "confirmed", err: null }] }),
    } as any;
    return { conn, sendRawTransaction };
  };

  // A Privy-bridged wallet exposes BOTH methods — that's what made the atomic
  // branch reachable for every single-signer tx.
  const makeWallet = () => {
    const kp = Keypair.generate();
    return {
      publicKey: kp.publicKey,
      signTransaction: vi.fn(async (tx: Transaction) => {
        tx.partialSign(kp);
        return tx;
      }),
      signAndSendTransaction: vi.fn().mockResolvedValue(bs58.decode(SIG)),
    };
  };

  it("devnet: a single-signer tx is signed by the wallet and submitted by US — the wallet never submits", async () => {
    netState.network = "devnet";
    const { conn, sendRawTransaction } = makeConn();
    const wallet = makeWallet();

    const sig = await sendTx({ connection: conn, wallet, instructions: [] });

    expect(wallet.signAndSendTransaction).not.toHaveBeenCalled();
    expect(wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(sig).toBe(SIG);
  });

  it("mainnet: PERC-8388's atomic path is unchanged — the wallet signs AND submits", async () => {
    netState.network = "mainnet";
    const { conn, sendRawTransaction } = makeConn();
    const wallet = makeWallet();

    const sig = await sendTx({ connection: conn, wallet, instructions: [] });

    expect(wallet.signAndSendTransaction).toHaveBeenCalledTimes(1);
    expect(wallet.signTransaction).not.toHaveBeenCalled();
    expect(sendRawTransaction).not.toHaveBeenCalled();
    expect(sig).toBe(SIG);
  });
});

describe("sendTx atomic signAndSendTransaction path — error detail preservation", () => {
  const LIGHTHOUSE_ID = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";

  const makeConn = () =>
    ({
      rpcEndpoint: "https://api.devnet.solana.com",
      getRecentPrioritizationFees: vi.fn().mockResolvedValue([]),
      getBalance: vi.fn().mockResolvedValue(1_000_000_000),
      getLatestBlockhash: vi.fn().mockResolvedValue({
        blockhash: "11111111111111111111111111111111",
        lastValidBlockHeight: 123,
      }),
      simulateTransaction: vi.fn().mockResolvedValue({ value: { err: null, logs: [] } }),
    }) as any;

  const makeWallet = (sendErr: unknown) => ({
    publicKey: Keypair.generate().publicKey,
    signAndSendTransaction: vi.fn().mockRejectedValue(sendErr),
  });

  it("throws the EXTRACTED message (nested cause detail) instead of the wallet's generic wrapper", async () => {
    // Privy-style: generic top-level message, real detail buried in cause.logs.
    const privyErr = new Error("Unexpected error") as Error & { cause?: unknown };
    privyErr.cause = {
      logs: [
        "Program log: Instruction: Deposit",
        "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P failed: custom program error: 0x13",
      ],
    };

    let caught: unknown;
    try {
      await sendTx({ connection: makeConn(), wallet: makeWallet(privyErr), instructions: [] });
    } catch (e) {
      caught = e;
    }

    const err = caught as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("Unexpected error");
    expect(err.message).toContain("custom program error: 0x13");
    // Original wallet error preserved for debugging.
    expect(err.cause).toBe(privyErr);
  });

  it("does NOT show the wallet-security message for a PASSING Lighthouse assertion + unrelated 0x31 failure", async () => {
    const privyErr = new Error("Unexpected error") as Error & { cause?: unknown };
    privyErr.cause = {
      logs: [
        `Program ${LIGHTHOUSE_ID} invoke [1]`,
        `Program ${LIGHTHOUSE_ID} success`,
        "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]",
        "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P failed: custom program error: 0x31",
      ],
    };

    let caught: unknown;
    try {
      await sendTx({ connection: makeConn(), wallet: makeWallet(privyErr), instructions: [] });
    } catch (e) {
      caught = e;
    }

    const err = caught as Error;
    expect(err.message).not.toContain("wallet security");
    expect(err.message).toContain("custom program error: 0x31");
  });

  it("shows the wallet-security message for a GENUINE Lighthouse 0x1900 failure", async () => {
    const privyErr = new Error("Unexpected error") as Error & { cause?: unknown };
    privyErr.cause = {
      logs: [
        `Program ${LIGHTHOUSE_ID} invoke [1]`,
        `Program ${LIGHTHOUSE_ID} failed: custom program error: 0x1900`,
      ],
    };

    let caught: unknown;
    try {
      await sendTx({ connection: makeConn(), wallet: makeWallet(privyErr), instructions: [] });
    } catch (e) {
      caught = e;
    }

    const err = caught as Error;
    expect(err.message).toContain("Transaction blocked by wallet security");
    expect(err.cause).toBe(privyErr);
  });
});

describe("estimateFees", () => {
  it("calculates base fee for single signer", () => {
    const est = estimateFees(200_000, 100_000, 1);
    expect(est.baseFee).toBe(5000);
    // priority = ceil(200_000 * 100_000 / 1_000_000) = 20_000
    expect(est.priorityFee).toBe(20_000);
    expect(est.total).toBe(25_000);
    expect(est.totalSol).toBeCloseTo(0.000025, 6);
  });

  it("scales base fee with multiple signers", () => {
    const est = estimateFees(200_000, 100_000, 3);
    expect(est.baseFee).toBe(15_000); // 5000 × 3
    expect(est.total).toBe(35_000); // 15_000 + 20_000
  });

  it("handles zero priority fee", () => {
    const est = estimateFees(200_000, 0, 1);
    expect(est.priorityFee).toBe(0);
    expect(est.total).toBe(5000);
  });

  it("rounds priority fee up (no fractional lamports)", () => {
    // 100 CU × 1 microLamport / 1_000_000 = 0.0001 → ceil to 1
    const est = estimateFees(100, 1, 1);
    expect(est.priorityFee).toBe(1);
  });

  it("defaults to 1 signature when not specified", () => {
    const est = estimateFees(200_000, 50_000);
    expect(est.baseFee).toBe(5000);
  });
});

describe("getClockDriftWarning", () => {
  it("returns null when no drift has been detected", () => {
    // On module load, cachedClockDriftSeconds is 0 — no warning
    expect(getClockDriftWarning()).toBeNull();
  });
});

describe("isBlockhashExpiredError", () => {
  // Positive cases — the market-launch batch pipeline's tail-recovery
  // (hooks/useCreateMarket.ts's `broadcastTailTx`) depends on these matching
  // so a genuinely expired blockhash triggers the refresh-and-re-sign path.
  it("matches web3.js's TransactionExpiredBlockheightExceededError class", () => {
    expect(isBlockhashExpiredError(new TransactionExpiredBlockheightExceededError("some-signature"))).toBe(true);
  });

  it('matches a "Blockhash not found" message', () => {
    expect(isBlockhashExpiredError(new Error("failed to send transaction: Blockhash not found"))).toBe(true);
  });

  it('matches a "block height exceeded" message', () => {
    expect(isBlockhashExpiredError(new Error("Transaction expired: block height exceeded"))).toBe(true);
  });

  it('matches a raw "BlockhashNotFound" JSON-RPC transaction-error string', () => {
    expect(isBlockhashExpiredError(new Error('{"err":"BlockhashNotFound"}'))).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isBlockhashExpiredError(new Error("BLOCKHASH NOT FOUND"))).toBe(true);
  });

  it('matches a "has expired" message (consistency with sendTx\'s own predicate)', () => {
    expect(isBlockhashExpiredError(new Error("Transaction's blockhash has expired"))).toBe(true);
  });

  it("does NOT match a confirmation timeout (that path may have landed — needs a status check)", () => {
    expect(isBlockhashExpiredError(new Error("Confirmation timeout (90s) — tx may still land. Check explorer: abc"))).toBe(false);
  });

  // Negative cases — a generic send/simulation failure must NOT trigger the
  // extra re-approval popup; only genuine expiry should.
  it("does not match a generic program error", () => {
    expect(isBlockhashExpiredError(new Error("custom program error: 0x1"))).toBe(false);
  });

  it("does not match an insufficient-funds error", () => {
    expect(isBlockhashExpiredError(new Error("Attempt to debit an account but found no record of a prior credit."))).toBe(false);
  });

  it("does not match a non-Error, non-string value", () => {
    expect(isBlockhashExpiredError({ some: "object" })).toBe(false);
    expect(isBlockhashExpiredError(undefined)).toBe(false);
    expect(isBlockhashExpiredError(null)).toBe(false);
  });

  it("does not match an empty-message Error", () => {
    expect(isBlockhashExpiredError(new Error(""))).toBe(false);
  });
});

describe("isConfirmationTimeoutError", () => {
  it("matches pollConfirmation's timeout message", () => {
    expect(isConfirmationTimeoutError(new Error("Confirmation timeout (90s) — tx may still land. Check explorer: sig123"))).toBe(true);
  });
  it("is case-insensitive", () => {
    expect(isConfirmationTimeoutError(new Error("CONFIRMATION TIMEOUT"))).toBe(true);
  });
  it("does not match a blockhash-expiry error (that path has no signature to check)", () => {
    expect(isConfirmationTimeoutError(new Error("Blockhash not found"))).toBe(false);
  });
  it("does not match generic errors or non-strings", () => {
    expect(isConfirmationTimeoutError(new Error("custom program error: 0x1"))).toBe(false);
    expect(isConfirmationTimeoutError(null)).toBe(false);
    expect(isConfirmationTimeoutError({ x: 1 })).toBe(false);
  });
});

describe("checkSignatureLanded", () => {
  const conn = (value: unknown) =>
    ({ getSignatureStatuses: vi.fn().mockResolvedValue({ value: [value] }) }) as never;

  it('returns "landed" for a confirmed status with no error', async () => {
    expect(await checkSignatureLanded(conn({ err: null, confirmationStatus: "confirmed" }), "s")).toBe("landed");
  });
  it('returns "landed" for a finalized status', async () => {
    expect(await checkSignatureLanded(conn({ err: null, confirmationStatus: "finalized" }), "s")).toBe("landed");
  });
  it('returns "not-found" for a null status (dropped)', async () => {
    expect(await checkSignatureLanded(conn(null), "s")).toBe("not-found");
  });
  it('returns "unknown" for an on-chain error (a rebuild would just fail again)', async () => {
    expect(await checkSignatureLanded(conn({ err: { InstructionError: [0, "Custom"] } }), "s")).toBe("unknown");
  });
  it('returns "unknown" for processed-but-not-yet-confirmed (indeterminate)', async () => {
    expect(await checkSignatureLanded(conn({ err: null, confirmationStatus: "processed" }), "s")).toBe("unknown");
  });
  it('returns "unknown" when the RPC call throws (fail safe — never rebuild on uncertainty)', async () => {
    const throwing = { getSignatureStatuses: vi.fn().mockRejectedValue(new Error("rpc down")) } as never;
    expect(await checkSignatureLanded(throwing, "s")).toBe("unknown");
  });

  describe("GH#2623: retries once before a false-negative not-found triggers a re-sign", () => {
    it('a first "not-found" that turns "landed" on retry returns "landed", not "not-found"', async () => {
      // Simulates a load-balanced RPC backend that hasn't indexed the
      // signature yet on the first query but has by the second — the
      // documented "BlockhashNotFound propagation lag" gremlin (eb10959 /
      // #2603 / #2598 / #2400). Before this fix, the caller
      // (attemptFreshBatchedLaunch's broadcastTailTx) would have treated the
      // FIRST "not-found" as authoritative and rebuilt + re-signed a step
      // that had, in fact, already landed.
      const getSignatureStatuses = vi
        .fn()
        .mockResolvedValueOnce({ value: [null] })
        .mockResolvedValueOnce({ value: [{ err: null, confirmationStatus: "confirmed" }] });
      const conn = { getSignatureStatuses } as never;
      expect(await checkSignatureLanded(conn, "s")).toBe("landed");
      expect(getSignatureStatuses).toHaveBeenCalledTimes(2);
    });

    it('queries only ONCE when the first query already resolves (landed/unknown) — no needless delay', async () => {
      // CONTROL distinguishing "retries on not-found specifically" from "always
      // queries twice": a definitive first answer must not incur the retry's
      // ~800ms delay at all.
      const getSignatureStatuses = vi.fn().mockResolvedValue({ value: [{ err: null, confirmationStatus: "confirmed" }] });
      const conn = { getSignatureStatuses } as never;
      expect(await checkSignatureLanded(conn, "s")).toBe("landed");
      expect(getSignatureStatuses).toHaveBeenCalledTimes(1);
    });

    it('a signature that is STILL "not-found" on retry returns "not-found" — genuinely dropped, safe to rebuild', async () => {
      // CONTROL for the retry not silently converting every case to "landed":
      // consistently absent must still return "not-found" so a truly dropped
      // tx remains safe to rebuild.
      const getSignatureStatuses = vi.fn().mockResolvedValue({ value: [null] });
      const conn = { getSignatureStatuses } as never;
      expect(await checkSignatureLanded(conn, "s")).toBe("not-found");
      expect(getSignatureStatuses).toHaveBeenCalledTimes(2);
    });
  });
});

describe("TxCancelledError / isTxCancelledError (GH#2623)", () => {
  it("isTxCancelledError is true only for a TxCancelledError instance", () => {
    expect(isTxCancelledError(new TxCancelledError())).toBe(true);
    expect(isTxCancelledError(new Error("Transaction cancelled — you rejected the signing request."))).toBe(false);
    expect(isTxCancelledError("Transaction cancelled")).toBe(false);
    expect(isTxCancelledError(null)).toBe(false);
    expect(isTxCancelledError(undefined)).toBe(false);
  });

  it("carries a default message when none is given, and the given one otherwise", () => {
    expect(new TxCancelledError().message).toMatch(/cancelled/i);
    expect(new TxCancelledError("custom reason").message).toBe("custom reason");
  });
});

describe("sendTx — R2-S7 landed check works when sendRawTransaction throws", () => {
  // The signature is known from the signed tx BEFORE broadcast. If the send then
  // throws a blockhash-expiry-shaped error but the tx actually landed, sendTx must
  // return that signature instead of throwing (callers report a landed tx as failed).
  const makeConn = (sendErr: Error, status: unknown) => {
    const sendRawTransaction = vi.fn().mockRejectedValue(sendErr);
    const getSignatureStatuses = vi.fn().mockResolvedValue({ value: [status] });
    const conn = {
      rpcEndpoint: "https://api.devnet.solana.com",
      getRecentPrioritizationFees: vi.fn().mockResolvedValue([]),
      getBalance: vi.fn().mockResolvedValue(1_000_000_000),
      getLatestBlockhash: vi.fn().mockResolvedValue({
        blockhash: "11111111111111111111111111111111",
        lastValidBlockHeight: 10_000_000,
      }),
      getBlockHeight: vi.fn().mockResolvedValue(1),
      simulateTransaction: vi.fn().mockResolvedValue({ value: { err: null, logs: [] } }),
      sendRawTransaction,
      getSignatureStatuses,
    } as any;
    return { conn, sendRawTransaction, getSignatureStatuses };
  };

  const makeWallet = () => {
    const kp = Keypair.generate();
    const signed: { sig: string | null } = { sig: null };
    return {
      signed,
      wallet: {
        publicKey: kp.publicKey,
        signTransaction: vi.fn(async (tx: Transaction) => {
          tx.partialSign(kp);
          signed.sig = bs58.encode(tx.signature as Buffer);
          return tx;
        }),
      },
    };
  };

  it("returns the pre-broadcast signature when the send throws but the tx landed", async () => {
    netState.network = "devnet";
    const { conn, sendRawTransaction, getSignatureStatuses } = makeConn(
      new Error("Blockhash not found"),
      { confirmationStatus: "confirmed", err: null },
    );
    const { wallet, signed } = makeWallet();

    const sig = await sendTx({ connection: conn, wallet, instructions: [] });

    expect(sendRawTransaction).toHaveBeenCalledTimes(1); // no rebuild/resend
    expect(getSignatureStatuses).toHaveBeenCalledWith([signed.sig], { searchTransactionHistory: true });
    expect(sig).toBe(signed.sig);
  });

  it("still throws when the send threw and the tx did NOT land (no false success)", async () => {
    netState.network = "devnet";
    const { conn } = makeConn(new Error("Blockhash not found"), null);
    const { wallet } = makeWallet();

    await expect(
      sendTx({ connection: conn, wallet, instructions: [], maxRetries: 0 }),
    ).rejects.toThrow(/Blockhash not found/i);
  });
});
