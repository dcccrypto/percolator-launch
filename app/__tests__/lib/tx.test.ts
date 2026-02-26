import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair } from "@solana/web3.js";

// Mock getConfig before importing tx module
vi.mock("@/lib/config", () => ({
  getConfig: () => ({ network: "devnet", rpcUrl: "https://api.devnet.solana.com" }),
}));

import { sendTx, estimateFees, getClockDriftWarning } from "@/lib/tx";
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

  it("validates network before sending (mismatch throws)", async () => {
    vi.resetModules();
    vi.mock("@/lib/config", () => ({
      getConfig: () => ({ network: "devnet", rpcUrl: "https://api.devnet.solana.com" }),
    }));
    const { sendTx: freshSendTx } = await import("@/lib/tx");

    const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
    const conn = {
      rpcEndpoint: "https://api.devnet.solana.com",
      getGenesisHash: vi.fn().mockResolvedValue(MAINNET_GENESIS),
    } as any;
    const wallet = {
      publicKey: Keypair.generate().publicKey,
      signTransaction: vi.fn(),
    };

    await expect(
      freshSendTx({ connection: conn, wallet, instructions: [] })
    ).rejects.toThrow("Network mismatch");
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
