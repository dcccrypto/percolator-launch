import { describe, it, expect } from "vitest";
import { parseMarketCreationError } from "@/lib/parseMarketError";

describe("parseMarketCreationError", () => {
  it("parses user rejection", () => {
    const msg = parseMarketCreationError(new Error("User rejected the request"));
    expect(msg).toContain("cancelled");
    expect(msg).toContain("Retry");
  });

  it("parses WalletSignTransactionError", () => {
    const msg = parseMarketCreationError(new Error("WalletSignTransactionError: user rejected"));
    expect(msg).toContain("cancelled");
  });

  it("parses insufficient funds", () => {
    const msg = parseMarketCreationError(
      new Error("Attempt to debit an account but found no record of a prior credit")
    );
    expect(msg).toContain("Insufficient SOL");
  });

  it("parses account already in use", () => {
    const msg = parseMarketCreationError(new Error("already in use"));
    expect(msg).toContain("already exists");
    expect(msg).toContain("Retry");
  });

  it("parses blockhash expired", () => {
    const msg = parseMarketCreationError(new Error("block height exceeded"));
    expect(msg).toContain("expired");
    expect(msg).toContain("Retry");
  });

  // v17 error codes — completely different mapping from v12.
  // Source: @percolatorct/sdk errors.ts PERCOLATOR_ERRORS (ordinals 0-46).

  it("parses custom program error hex code 0x8 — v17 Unauthorized", () => {
    // v17 code 8 = Unauthorized (v12 had InvalidVaultAta at 8)
    const msg = parseMarketCreationError(
      new Error("Transaction simulation failed: custom program error: 0x8")
    );
    expect(msg).toContain("authorized");
  });

  it("parses v17 InvalidAccountKind error (0x4)", () => {
    // v17 code 4 = InvalidAccountKind (v12 had InvalidSlabLen at 4)
    const msg = parseMarketCreationError(
      new Error("custom program error: 0x4")
    );
    expect(msg).toContain("account kind");
  });

  it("parses AlreadyInitialized error (0x2)", () => {
    // v17 code 2 = AlreadyInitialized (same as v12)
    const msg = parseMarketCreationError(
      new Error("custom program error: 0x2")
    );
    expect(msg).toContain("already initialized");
  });

  it("parses InvalidMagic error (0x0)", () => {
    // v17 code 0 = InvalidMagic (same meaning as v12)
    const msg = parseMarketCreationError(
      new Error("custom program error: 0x0")
    );
    expect(msg).toContain("magic");
  });

  it("parses v17 EngineInvalidConfig error (0xe)", () => {
    // v17 code 14 = EngineInvalidConfig; code 13 = InvalidTokenProgram.
    const msg = parseMarketCreationError(
      new Error("custom program error: 0xe")
    );
    expect(msg).toContain("config");
  });

  it("parses v17 EngineInvalidLeg error (0x12)", () => {
    // v17 code 18 = EngineInvalidLeg (v12 had InsufficientSeed at 18)
    const msg = parseMarketCreationError(
      new Error("custom program error: 0x12")
    );
    expect(msg).toContain("leg");
  });

  it("parses network error", () => {
    const msg = parseMarketCreationError(new Error("Failed to fetch"));
    expect(msg).toContain("Network error");
  });

  it("parses timeout", () => {
    const msg = parseMarketCreationError(new Error("Request timeout"));
    expect(msg).toContain("timed out");
  });

  it("truncates very long messages", () => {
    const longMsg = "x".repeat(300);
    const msg = parseMarketCreationError(new Error(longMsg));
    expect(msg.length).toBeLessThan(250);
    expect(msg).toContain("...");
  });

  it("handles non-Error objects", () => {
    const msg = parseMarketCreationError("some string error");
    expect(msg).toContain("some string error");
  });

  it("handles unknown program errors gracefully", () => {
    const msg = parseMarketCreationError(
      new Error("custom program error: 0xFF")
    );
    expect(msg).toContain("code 255");
  });

  // Anchored program-error routing — a successful Tokenkeg CPI in the logs
  // must NOT hijack an unrelated engine failure into "insufficient token
  // balance" (old heuristic: includes("custom program error: 0x1") — which
  // also prefix-matched 0x13 — && includes("TokenkegQ") anywhere).
  describe("token-program error routing (anchored)", () => {
    const TOKENKEG = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const WRAPPER = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

    it("routes 0x13 EngineStale to the engine-stale message even with a successful Tokenkeg CPI in the logs", () => {
      const msg = parseMarketCreationError(new Error(
        [
          "Transaction failed: Unexpected error",
          `Program ${WRAPPER} invoke [1]`,
          `Program ${TOKENKEG} invoke [2]`,
          "Program log: Instruction: Transfer",
          `Program ${TOKENKEG} success`,
          `Program ${WRAPPER} failed: custom program error: 0x13`,
        ].join("\n")
      ));
      expect(msg).not.toContain("Insufficient token balance");
      expect(msg).toContain("stale");
    });

    it("still routes a genuine Tokenkeg 0x1 failure to the insufficient-token-balance message", () => {
      const msg = parseMarketCreationError(new Error(
        [
          `Program ${WRAPPER} invoke [1]`,
          `Program ${TOKENKEG} invoke [2]`,
          "Program log: Instruction: Transfer",
          `Program ${TOKENKEG} failed: custom program error: 0x1`,
        ].join("\n")
      ));
      expect(msg).toContain("Insufficient token balance");
    });

    it("attributes a bare failing line to the innermost still-open invoke (Tokenkeg)", () => {
      const msg = parseMarketCreationError(new Error(
        [
          `Program ${TOKENKEG} invoke [2]`,
          "Program failed: custom program error: 0x1",
        ].join("\n")
      ));
      expect(msg).toContain("Insufficient token balance");
    });

    it("routes a non-token 0x1 failure to the program-error decode path, not token balance", () => {
      const msg = parseMarketCreationError(new Error(
        `Program ${WRAPPER} failed: custom program error: 0x1`
      ));
      expect(msg).not.toContain("Insufficient token balance");
      // 0x1 = v17 InvalidVersion override
      expect(msg).toContain("version mismatch");
    });

    it("routes exact-code 0x12 (not a 0x1 prefix match) via the hex decode path", () => {
      const msg = parseMarketCreationError(new Error(
        [
          `Program ${TOKENKEG} invoke [2]`,
          `Program ${TOKENKEG} success`,
          `Program ${WRAPPER} failed: custom program error: 0x12`,
        ].join("\n")
      ));
      expect(msg).not.toContain("Insufficient token balance");
      // 0x12 = 18 EngineInvalidLeg
      expect(msg).toContain("leg");
    });
  });
});
