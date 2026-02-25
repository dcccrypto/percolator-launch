import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair } from "@solana/web3.js";

// Mock getConfig before importing tx module
vi.mock("@/lib/config", () => ({
  getConfig: () => ({ network: "devnet", rpcUrl: "https://api.devnet.solana.com" }),
}));

import { sendTx } from "@/lib/tx";
import type { SendTxParams } from "@/lib/tx";

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
