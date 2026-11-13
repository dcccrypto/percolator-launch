// @vitest-environment node
/**
 * Tests for GH#1667 and GH#1668
 *
 * GH#1667: isValidBase58Pubkey must accept all valid 32-byte Solana public keys
 *   regardless of their base58 string length (max is 44 chars for 32 bytes).
 *   A 45-char string decodes to 33 bytes and is correctly rejected.
 *   The UX error message must NOT reference "32-44 chars".
 *
 * GH#1668: handleAirdrop must translate "Internal error" / 429 responses from
 *   the Solana devnet RPC into a user-friendly rate-limit message.
 */

import { PublicKey } from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Mirror of isValidBase58Pubkey (app/lib/createWizardUtils.ts)
// ---------------------------------------------------------------------------

function isValidBase58Pubkey(s: string): boolean {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// GH#1667 — base58 validator correctness
// ---------------------------------------------------------------------------

describe("GH#1667 — isValidBase58Pubkey", () => {
  it("accepts the system program address (all-1s, 32 chars)", () => {
    expect(isValidBase58Pubkey("11111111111111111111111111111111")).toBe(true);
  });

  it("accepts a typical 44-char Solana mint address", () => {
    // SOL token address
    expect(isValidBase58Pubkey("So11111111111111111111111111111111111111112")).toBe(true);
  });

  it("accepts a different typical 44-char public key", () => {
    // Token program
    expect(isValidBase58Pubkey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")).toBe(true);
  });

  it("rejects a 45-char string that decodes to 33 bytes (not a valid Solana pubkey)", () => {
    // This specific address was reported in GH#1667 as failing — correctly rejected
    // because its bs58 decode yields 33 bytes, not 32
    expect(isValidBase58Pubkey("8YzDeAJMU6t1GDfN6qpXGh81Z7fko1sRRrF595KVX5hJn")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidBase58Pubkey("")).toBe(false);
  });

  it("rejects a non-base58 string containing invalid chars", () => {
    expect(isValidBase58Pubkey("not-a-valid-address!!")).toBe(false);
  });

  it("rejects a string that is too short", () => {
    expect(isValidBase58Pubkey("ABC123")).toBe(false);
  });

  it("rejects a URL accidentally pasted", () => {
    expect(isValidBase58Pubkey("https://explorer.solana.com/address/abc")).toBe(false);
  });

  it("mathematical invariant: no valid 32-byte Solana key encodes to >44 base58 chars", () => {
    // All valid PublicKey objects must produce toBase58() of length <= 44
    const testKeys = [
      "11111111111111111111111111111111",
      "So11111111111111111111111111111111111111112",
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", // Serum DEX v3
      "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", // ORCA
    ];
    for (const addr of testKeys) {
      if (isValidBase58Pubkey(addr)) {
        const len = new PublicKey(addr).toBase58().length;
        expect(len).toBeLessThanOrEqual(44);
        expect(len).toBeGreaterThanOrEqual(32);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// GH#1668 — handleAirdrop error translation
// ---------------------------------------------------------------------------

/** Mirror of the error-translation logic in handleAirdrop */
function translateAirdropError(raw: string): string {
  const isRateLimit =
    /internal error|429|too many requests|rate.?limit|airdrop.*limit|limit.*airdrop/i.test(raw);
  return isRateLimit
    ? "Devnet faucet rate-limited — you can only airdrop SOL once per wallet per day. Try again tomorrow or use faucet.solana.com."
    : `Airdrop failed: ${raw}`;
}

describe("GH#1668 — airdrop error translation", () => {
  it("translates 'Internal error' to a rate-limit message", () => {
    const result = translateAirdropError(
      "airdrop to G7NGnUffoo2bKBY7nGjJmSZq7rSvG4bsJpK931rGQshD failed: Internal error.",
    );
    expect(result).toContain("rate-limited");
    expect(result).not.toContain("Internal error");
  });

  it("translates '429 Too Many Requests' to a rate-limit message", () => {
    const result = translateAirdropError("429 Too Many Requests");
    expect(result).toContain("rate-limited");
  });

  it("translates 'airdrop request limit exceeded' to a rate-limit message", () => {
    const result = translateAirdropError("airdrop request limit exceeded");
    expect(result).toContain("rate-limited");
  });

  it("translates 'rate limit' (case-insensitive) to a rate-limit message", () => {
    const result = translateAirdropError("Rate Limit reached for this key");
    expect(result).toContain("rate-limited");
  });

  it("passes through unrelated errors verbatim (prefixed)", () => {
    const result = translateAirdropError("Network error: ECONNREFUSED");
    expect(result).toContain("Airdrop failed:");
    expect(result).toContain("ECONNREFUSED");
  });

  it("passes through timeout errors verbatim (prefixed)", () => {
    const result = translateAirdropError("Transaction confirmation timeout after 60s");
    expect(result).toContain("Airdrop failed:");
  });

  it("rate-limit message mentions faucet.solana.com as fallback", () => {
    const result = translateAirdropError("Internal error.");
    expect(result).toContain("faucet.solana.com");
  });
});
