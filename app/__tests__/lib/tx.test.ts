import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair } from "@solana/web3.js";

// Mock getConfig before importing tx module
vi.mock("@/lib/config", () => ({
  getConfig: () => ({ network: "devnet", rpcUrl: "https://api.devnet.solana.com" }),
}));

import { TransactionExpiredBlockheightExceededError } from "@solana/web3.js";
import { sendTx, estimateFees, getClockDriftWarning, isBlockhashExpiredError, isConfirmationTimeoutError, checkSignatureLanded } from "@/lib/tx";
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
    }));
    const { sendTx: freshSendTx } = await import("@/lib/tx");

    const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
    const getGenesisHash = vi.fn().mockResolvedValue(MAINNET_GENESIS);
    const conn = {
      rpcEndpoint: "https://api.devnet.solana.com",
      getGenesisHash,
    } as any;
    const wallet = {
      publicKey: Keypair.generate().publicKey,
      signTransaction: vi.fn(),
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
});
