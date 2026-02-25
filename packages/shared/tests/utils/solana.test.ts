import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair, Transaction, TransactionInstruction, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

// We need to mock the rpc-client module to avoid creating real connections
vi.mock("../../src/utils/rpc-client.js", () => ({
  acquireToken: vi.fn().mockResolvedValue(undefined),
  getPrimaryConnection: vi.fn(),
  getFallbackConnection: vi.fn(),
  backoffMs: (attempt: number, baseMs = 1000, maxMs = 30_000) =>
    Math.min(baseMs * 2 ** attempt, maxMs),
}));

import { loadKeypair, checkTransactionSize, pollSignatureStatus } from "../../src/utils/solana.js";

// ============================================================================
// loadKeypair
// ============================================================================

describe("loadKeypair", () => {
  it("loads keypair from JSON array string", () => {
    const kp = Keypair.generate();
    const jsonStr = `[${Array.from(kp.secretKey).join(",")}]`;
    const loaded = loadKeypair(jsonStr);
    expect(loaded.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
    expect(loaded.secretKey).toEqual(kp.secretKey);
  });

  it("loads keypair from base58 string", () => {
    const kp = Keypair.generate();
    const b58 = bs58.encode(kp.secretKey);
    const loaded = loadKeypair(b58);
    expect(loaded.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it("trims whitespace from input", () => {
    const kp = Keypair.generate();
    const jsonStr = `  [${Array.from(kp.secretKey).join(",")}]  `;
    const loaded = loadKeypair(jsonStr);
    expect(loaded.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it("handles JSON array with spaces", () => {
    const kp = Keypair.generate();
    const bytes = Array.from(kp.secretKey);
    const jsonStr = `[ ${bytes.join(", ")} ]`;
    const loaded = loadKeypair(jsonStr);
    expect(loaded.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it("throws for invalid base58", () => {
    expect(() => loadKeypair("not-valid-base58!!!")).toThrow();
  });

  it("throws for invalid JSON array content", () => {
    expect(() => loadKeypair("[invalid,json,content]")).toThrow();
  });
});

// ============================================================================
// checkTransactionSize
// ============================================================================

describe("checkTransactionSize", () => {
  it("does not throw for small transaction", () => {
    const tx = new Transaction();
    const ix = new TransactionInstruction({
      keys: [],
      programId: PublicKey.unique(),
      data: Buffer.from([1, 2, 3]),
    });
    tx.add(ix);

    // Need a blockhash and fee payer for serialization
    tx.recentBlockhash = "11111111111111111111111111111111";
    tx.feePayer = Keypair.generate().publicKey;

    expect(() => checkTransactionSize(tx)).not.toThrow();
  });

  it("throws for oversized transaction (serialization or size check)", () => {
    const tx = new Transaction();
    // Create a massive instruction data to exceed 1232 bytes
    const bigData = Buffer.alloc(1300, 0);
    const ix = new TransactionInstruction({
      keys: [],
      programId: PublicKey.unique(),
      data: bigData,
    });
    tx.add(ix);
    tx.recentBlockhash = "11111111111111111111111111111111";
    tx.feePayer = Keypair.generate().publicKey;

    // Either serialization itself throws (offset out of range) or our size check throws
    expect(() => checkTransactionSize(tx)).toThrow();
  });
});

// ============================================================================
// pollSignatureStatus
// ============================================================================

describe("pollSignatureStatus", () => {
  it("rejects invalid signature format immediately", async () => {
    await expect(
      pollSignatureStatus(null as any, "not-a-valid-signature!!!", 100)
    ).rejects.toThrow("Invalid signature format");
  });

  it("rejects empty string signature", async () => {
    await expect(
      pollSignatureStatus(null as any, "", 100)
    ).rejects.toThrow("Invalid signature format");
  });
});
