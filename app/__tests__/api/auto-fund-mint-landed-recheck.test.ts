/**
 * S3 audit 2026-10-17 — /api/auto-fund must not double-mint when the USDC mint
 * LANDS but confirmTransaction throws (slow devnet RPC: "block height exceeded").
 * The faucet / playground-faucet / airdrop / pre-fund routes re-check the
 * signature status (#2599/#2629); auto-fund treated the throw as "not minted",
 * released the 24h claim (when the SOL airdrop also failed) and a retry minted
 * another 1,000 USDC.
 */

// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getBalance: vi.fn(),
  getTokenAccountBalance: vi.fn(),
  getLatestBlockhash: vi.fn(),
  sendRawTransaction: vi.fn(),
  confirmTransaction: vi.fn(),
  getSignatureStatus: vi.fn(),

  getAssociatedTokenAddress: vi.fn(),
  getDevnetMintSigner: vi.fn(),

  tryFaucetGate: vi.fn(),
  releaseFaucetClaim: vi.fn(),

  analyticsInsert: vi.fn(),
  analyticsFrom: vi.fn(),

  captureException: vi.fn(),
}));

vi.mock("@solana/web3.js", () => {
  class PublicKey {
    constructor(private readonly value: unknown) {}
    toBase58(): string {
      return typeof this.value === "string" ? this.value : "11111111111111111111111111111111";
    }
  }
  class Transaction {
    instructions: unknown[] = [];
    add(...ix: unknown[]) { this.instructions.push(...ix); return this; }
    serialize(): Buffer { return Buffer.from([]); }
  }
  // The PUBLIC devnet Connection (used only for the best-effort SOL airdrop).
  // Deliberately has no requestAirdrop/confirmTransaction — calling either throws,
  // which the airdrop's own internal try/catch swallows as non-fatal. Isolated
  // from the SERVER connection (mocked separately below via "@/lib/server-rpc")
  // so a getBalance()-throws test can't be confused with a public-RPC failure.
  class Connection {}
  return { Connection, PublicKey, Transaction, LAMPORTS_PER_SOL: 1_000_000_000 };
});

vi.mock("@solana/spl-token", () => ({
  getAssociatedTokenAddress: mocks.getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction: vi.fn(),
  createMintToInstruction: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    rpcUrl: "https://api.devnet.solana.com",
    testUsdcMint: "So11111111111111111111111111111111111111112",
  }),
}));

vi.mock("@/lib/server-rpc", () => ({
  getServerConnection: () => ({
    getBalance: mocks.getBalance,
    getTokenAccountBalance: mocks.getTokenAccountBalance,
    getLatestBlockhash: mocks.getLatestBlockhash,
    sendRawTransaction: mocks.sendRawTransaction,
    confirmTransaction: mocks.confirmTransaction,
    getSignatureStatus: mocks.getSignatureStatus,
  }),
}));

vi.mock("@/lib/devnet-signer", () => ({
  getDevnetMintSigner: mocks.getDevnetMintSigner,
}));

vi.mock("@/lib/supabase", () => ({
  getServiceClient: () => ({ from: mocks.analyticsFrom }),
}));

vi.mock("@/lib/faucet-rate-gate", () => ({
  tryFaucetGate: mocks.tryFaucetGate,
  releaseFaucetClaim: mocks.releaseFaucetClaim,
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: mocks.captureException,
}));

function createRequest(): NextRequest {
  return new NextRequest("http://localhost/api/auto-fund", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet: "11111111111111111111111111111111" }),
  });
}

let POST: typeof import("@/app/api/auto-fund/route").POST;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();

  process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
  delete process.env.NEXT_PUBLIC_SOLANA_NETWORK;

  // The gate ALLOWS and hands back a claimId — i.e. the claim is now reserved.
  mocks.tryFaucetGate.mockResolvedValue({ allowed: true, nextClaimAt: null, claimId: 4242 });
  mocks.releaseFaucetClaim.mockResolvedValue(undefined);
  mocks.analyticsInsert.mockResolvedValue({ error: null });
  mocks.analyticsFrom.mockReturnValue({ insert: mocks.analyticsInsert });

  mocks.getAssociatedTokenAddress.mockResolvedValue({
    toBase58: () => "11111111111111111111111111111111",
  });
  mocks.getTokenAccountBalance.mockResolvedValue({ value: { uiAmount: 0 } });
  mocks.getLatestBlockhash.mockResolvedValue({ blockhash: "bh", lastValidBlockHeight: 1 });
  mocks.sendRawTransaction.mockResolvedValue("sig");
  mocks.confirmTransaction.mockResolvedValue({ context: { slot: 1 }, value: { err: null } });
  mocks.getDevnetMintSigner.mockReturnValue({
    publicKey: () => "11111111111111111111111111111111",
    signTransaction: (tx: unknown) => tx,
  });

  // Default: enough SOL, so the airdrop branch is skipped and the USDC branch
  // decides the outcome — kept overridable per-test.
  mocks.getBalance.mockResolvedValue(1_000_000_000);

  const route = await import("@/app/api/auto-fund/route");
  POST = route.POST;
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_DEFAULT_NETWORK;
  delete process.env.NEXT_PUBLIC_SOLANA_NETWORK;
});

describe("S3 audit: auto-fund re-checks a mint whose confirmation threw", () => {
  it("keeps the claim when the mint landed but confirmTransaction threw", async () => {
    mocks.getBalance.mockResolvedValue(0); // airdrop attempt fails (no requestAirdrop)
    mocks.confirmTransaction.mockRejectedValue(new Error("block height exceeded"));
    mocks.getSignatureStatus.mockResolvedValue({ value: { err: null, confirmationStatus: "confirmed" } });

    const res = await POST(createRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.usdc_minted).toBe(true);
    expect(body.funded).toBe(true);
    expect(mocks.releaseFaucetClaim).not.toHaveBeenCalled();
  });

  it("CONTROL: releases the claim when the blockhash expired and the mint is not found", async () => {
    mocks.getBalance.mockResolvedValue(0);
    const expired = new Error("Signature sig has expired: block height exceeded.");
    expired.name = "TransactionExpiredBlockheightExceededError";
    mocks.confirmTransaction.mockRejectedValue(expired);
    mocks.getSignatureStatus.mockResolvedValue({ value: null });

    const res = await POST(createRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.funded).toBe(false);
    expect(mocks.releaseFaucetClaim).toHaveBeenCalledWith(expect.anything(), 4242);
  });

  it("keeps the claim when confirm failed for a non-expiry reason and the mint is not yet visible", async () => {
    mocks.getBalance.mockResolvedValue(0);
    mocks.confirmTransaction.mockRejectedValue(new Error("fetch failed"));
    mocks.getSignatureStatus.mockResolvedValue({ value: null });

    const res = await POST(createRequest());

    expect(res.status).toBe(200);
    expect(mocks.releaseFaucetClaim).not.toHaveBeenCalled();
  });

  it("keeps the claim (no double mint) when the re-check itself errors after a send", async () => {
    mocks.getBalance.mockResolvedValue(0);
    mocks.confirmTransaction.mockRejectedValue(new Error("block height exceeded"));
    mocks.getSignatureStatus.mockRejectedValue(new Error("RPC down"));

    const res = await POST(createRequest());

    expect(res.status).toBe(200);
    expect(mocks.releaseFaucetClaim).not.toHaveBeenCalled();
  });
});
