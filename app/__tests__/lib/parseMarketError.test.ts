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

  it("parses custom program error hex code", () => {
    const msg = parseMarketCreationError(
      new Error("Transaction simulation failed: custom program error: 0x8")
    );
    expect(msg).toContain("seed deposit");
  });

  it("parses already initialized error", () => {
    const msg = parseMarketCreationError(
      new Error("custom program error: 0x0")
    );
    expect(msg).toContain("already initialized");
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
});
