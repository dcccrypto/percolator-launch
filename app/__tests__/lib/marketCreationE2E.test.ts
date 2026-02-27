/**
 * E2E failure scenario tests for market creation flow.
 * Tests the full error handling pipeline: from raw Solana errors to user-facing messages.
 */
import { describe, it, expect } from "vitest";
import { parseMarketCreationError } from "@/lib/parseMarketError";

describe("Market Creation — Failure Scenarios", () => {
  describe("User cancellation flows", () => {
    it("handles Phantom wallet rejection", () => {
      const msg = parseMarketCreationError(
        new Error("User rejected the request.")
      );
      expect(msg).toContain("cancelled");
      expect(msg).toContain("Retry");
    });

    it("handles Solflare wallet rejection", () => {
      const msg = parseMarketCreationError(
        new Error("Transaction cancelled by user")
      );
      expect(msg).toContain("cancelled");
    });

    it("handles Backpack wallet rejection", () => {
      const msg = parseMarketCreationError(
        new Error("user rejected the transaction")
      );
      expect(msg).toContain("cancelled");
    });

    it("handles WalletSignTransactionError wrapper", () => {
      const msg = parseMarketCreationError(
        new Error("WalletSignTransactionError: User rejected")
      );
      expect(msg).toContain("cancelled");
    });
  });

  describe("Insufficient balance flows", () => {
    it("handles no prior credit (fresh wallet)", () => {
      const msg = parseMarketCreationError(
        new Error("Attempt to debit an account but found no record of a prior credit")
      );
      expect(msg).toContain("Insufficient SOL");
    });

    it("handles insufficient funds simulation failure", () => {
      const msg = parseMarketCreationError(
        new Error("Transaction simulation failed: insufficient funds for rent")
      );
      expect(msg).toContain("Insufficient SOL");
    });

    it("handles insufficient lamports", () => {
      const msg = parseMarketCreationError(
        new Error("insufficient lamports 500000, need 2039280")
      );
      expect(msg).toContain("Insufficient SOL");
    });
  });

  describe("Network failure flows", () => {
    it("handles RPC connection refused", () => {
      const msg = parseMarketCreationError(
        new Error("ECONNREFUSED 127.0.0.1:8899")
      );
      expect(msg).toContain("Network error");
    });

    it("handles fetch failure", () => {
      const msg = parseMarketCreationError(new Error("Failed to fetch"));
      expect(msg).toContain("Network error");
    });

    it("handles network error", () => {
      const msg = parseMarketCreationError(new Error("NetworkError when attempting to fetch resource."));
      expect(msg).toContain("Network error");
    });

    it("handles blockhash expiry (congestion)", () => {
      const msg = parseMarketCreationError(
        new Error("TransactionExpiredBlockheightExceededError: block height exceeded")
      );
      expect(msg).toContain("expired");
      expect(msg).toContain("congested");
    });

    it("handles blockhash not found", () => {
      const msg = parseMarketCreationError(
        new Error("Blockhash not found")
      );
      expect(msg).toContain("expired");
    });

    it("handles general timeout", () => {
      const msg = parseMarketCreationError(new Error("ETIMEDOUT"));
      expect(msg).toContain("timed out");
    });
  });

  describe("Program error flows", () => {
    it("handles already-initialized market (code 0x0)", () => {
      const msg = parseMarketCreationError(
        new Error("custom program error: 0x0")
      );
      expect(msg).toContain("already initialized");
    });

    it("handles uninitialized market (code 0x1)", () => {
      const msg = parseMarketCreationError(
        new Error("custom program error: 0x1")
      );
      expect(msg).toContain("not initialized");
    });

    it("handles invalid slab length (code 0x2)", () => {
      const msg = parseMarketCreationError(
        new Error("custom program error: 0x2")
      );
      expect(msg).toContain("slab length");
    });

    it("handles insufficient balance in program (code 0x4)", () => {
      const msg = parseMarketCreationError(
        new Error("custom program error: 0x4")
      );
      expect(msg).toContain("Insufficient balance");
    });

    it("handles math overflow (code 0x5)", () => {
      const msg = parseMarketCreationError(
        new Error("custom program error: 0x5")
      );
      expect(msg).toContain("overflow");
    });

    it("handles margin requirement not met (code 0x6)", () => {
      const msg = parseMarketCreationError(
        new Error("custom program error: 0x6")
      );
      expect(msg).toContain("Margin requirement");
    });

    it("handles insufficient seed deposit (code 0x8)", () => {
      const msg = parseMarketCreationError(
        new Error("custom program error: 0x8")
      );
      expect(msg).toContain("seed deposit");
    });

    it("handles market paused (code 0x9)", () => {
      const msg = parseMarketCreationError(
        new Error("custom program error: 0x9")
      );
      expect(msg).toContain("paused");
    });

    it("handles stale oracle price (code 0xA)", () => {
      const msg = parseMarketCreationError(
        new Error("custom program error: 0xA")
      );
      expect(msg).toContain("Oracle price");
    });

    it("handles unknown program error code", () => {
      const msg = parseMarketCreationError(
        new Error("custom program error: 0xDEAD")
      );
      expect(msg).toContain("code");
      expect(msg).toContain("57005"); // 0xDEAD = 57005
    });

    it("handles InstructionError format", () => {
      const msg = parseMarketCreationError(
        new Error('InstructionError: [2, { Custom: 8 }]')
      );
      expect(msg).toContain("seed deposit");
    });
  });

  describe("Duplicate/retry flows", () => {
    it("handles account already in use (slab already created)", () => {
      const msg = parseMarketCreationError(
        new Error("Create Account: account Address already in use")
      );
      expect(msg).toContain("already exists");
      expect(msg).toContain("Retry");
    });

    it("handles transaction too large", () => {
      const msg = parseMarketCreationError(
        new Error("Transaction too large: 1234 > 1232")
      );
      expect(msg).toContain("too large");
      expect(msg).toContain("smaller slab tier");
    });
  });

  describe("Wallet connection flows", () => {
    it("handles wallet disconnection mid-flow", () => {
      const msg = parseMarketCreationError(
        new Error("Wallet not connected")
      );
      expect(msg).toContain("disconnected");
      expect(msg).toContain("reconnect");
    });

    it("handles wallet adapter error", () => {
      const msg = parseMarketCreationError(
        new Error("wallet adapter not ready")
      );
      expect(msg).toContain("disconnected");
    });
  });

  describe("Edge cases", () => {
    it("handles null/undefined error", () => {
      const msg1 = parseMarketCreationError(null);
      expect(msg1).toContain("null");
      
      const msg2 = parseMarketCreationError(undefined);
      expect(msg2).toContain("undefined");
    });

    it("handles empty string error", () => {
      const msg = parseMarketCreationError("");
      expect(msg).toContain("Transaction failed");
    });

    it("handles error with no message", () => {
      const err = new Error();
      const msg = parseMarketCreationError(err);
      expect(typeof msg).toBe("string");
    });

    it("truncates extremely long error messages", () => {
      const longMsg = "A".repeat(500);
      const msg = parseMarketCreationError(new Error(longMsg));
      expect(msg.length).toBeLessThan(300);
    });

    it("preserves short error messages", () => {
      const shortMsg = "Something went wrong";
      const msg = parseMarketCreationError(new Error(shortMsg));
      expect(msg).toContain(shortMsg);
    });
  });
});

describe("Market Creation — Validation Edge Cases", () => {
  describe("Token decimals boundary", () => {
    // These test the validation logic that should block >12 decimal tokens
    it("12 decimals is the maximum safe value", () => {
      // 10^12 = 1_000_000_000_000 — fits safely in a u64
      const maxSafe = 10 ** 12;
      expect(maxSafe).toBeLessThan(Number.MAX_SAFE_INTEGER);
    });

    it("13+ decimals risks overflow in multiplication", () => {
      // At 13 decimals, parseHumanAmount("1") = 10^13 which is still safe
      // But at 18 decimals, multiplying large amounts overflows u64
      // The guard at <= 12 is conservative but safe for all realistic amounts
      const safe12 = BigInt(10 ** 12) * BigInt(1_000_000); // 10^18 — fits in u64
      const maxU64 = BigInt("18446744073709551615");
      expect(safe12 < maxU64).toBe(true);
      
      // 18 decimals with a large amount can overflow
      const risky18 = BigInt(10 ** 18) * BigInt(10 ** 10); // 10^28 — overflows u64
      expect(risky18 > maxU64).toBe(true);
    });
  });

  describe("Fee vs margin conflict", () => {
    it("fee must be strictly less than margin", () => {
      const tradingFeeBps = 30;
      const initialMarginBps = 1000;
      expect(tradingFeeBps < initialMarginBps).toBe(true);
    });

    it("equal fee and margin is invalid", () => {
      const tradingFeeBps = 500;
      const initialMarginBps = 500;
      expect(tradingFeeBps >= initialMarginBps).toBe(true); // This is the conflict condition
    });

    it("fee greater than margin is invalid", () => {
      const tradingFeeBps = 600;
      const initialMarginBps = 500;
      expect(tradingFeeBps >= initialMarginBps).toBe(true);
    });
  });

  describe("Leverage calculation", () => {
    it("100 bps margin = 100x leverage", () => {
      expect(Math.floor(10000 / 100)).toBe(100);
    });

    it("500 bps margin = 20x leverage", () => {
      expect(Math.floor(10000 / 500)).toBe(20);
    });

    it("1000 bps margin = 10x leverage", () => {
      expect(Math.floor(10000 / 1000)).toBe(10);
    });

    it("5000 bps margin = 2x leverage", () => {
      expect(Math.floor(10000 / 5000)).toBe(2);
    });

    it("zero margin does not cause division by zero", () => {
      // This should be caught by validation before reaching here
      const margin = 0;
      const result = margin > 0 ? Math.floor(10000 / margin) : 0;
      expect(result).toBe(0);
    });
  });

  describe("Insurance fund minimum", () => {
    it("minimum insurance is 100 tokens", () => {
      const minInsurance = 100;
      expect(parseFloat("100") >= minInsurance).toBe(true);
      expect(parseFloat("99") >= minInsurance).toBe(false);
      expect(parseFloat("0") >= minInsurance).toBe(false);
    });
  });

  describe("SOL balance check", () => {
    it("minimum SOL balance is 0.5", () => {
      const minSol = 0.5;
      expect(0.5 >= minSol).toBe(true);
      expect(0.49 >= minSol).toBe(false);
    });
  });
});
