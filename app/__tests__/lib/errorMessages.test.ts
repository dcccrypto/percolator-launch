import { describe, it, expect, vi } from "vitest";
import { humanizeError, isTransientError, isOracleStaleError, withTransientRetry } from "../../lib/errorMessages";

describe("humanizeError", () => {
  // ── Known error codes via hex format ──
  it("maps hex error code 0x0 to invalid market magic", () => {
    expect(humanizeError("custom program error: 0x0")).toContain("Invalid market magic");
  });

  it("maps hex error code 0x1 to version mismatch", () => {
    expect(humanizeError("custom program error: 0x1")).toContain("Version mismatch");
  });

  it("maps hex error code 0xE (14) to undercollateralized", () => {
    expect(humanizeError("custom program error: 0xE")).toContain("Undercollateralized");
  });

  it("maps hex error code 0x21 (33) to market is paused", () => {
    expect(humanizeError("custom program error: 0x21")).toContain("paused");
  });

  // ── Custom(N) format ──
  it("parses Custom(6) as oracle stale", () => {
    expect(humanizeError("Custom(6)")).toContain("Oracle price is stale");
  });

  it("parses Custom(14) as undercollateralized", () => {
    expect(humanizeError("Custom(14)")).toContain("Undercollateralized");
  });

  // ── JSON format: {"Custom":N} ──
  it('parses {"Custom":14} from getSignatureStatuses', () => {
    expect(humanizeError('"Custom":14')).toContain("Undercollateralized");
  });

  it('parses {"Custom":6} as oracle stale', () => {
    expect(humanizeError('"Custom": 6')).toContain("Oracle price is stale");
  });

  // ── Instruction index hint ──
  it("appends instruction hint when InstructionError is present", () => {
    const msg = '{"InstructionError": [4, {"Custom": 14}]}';
    const result = humanizeError(msg);
    expect(result).toContain("Undercollateralized");
    expect(result).toContain("(in trade)");
  });

  it("appends oracle push hint for instruction index 2", () => {
    const msg = '{"InstructionError": [2, {"Custom": 6}]}';
    const result = humanizeError(msg);
    expect(result).toContain("Oracle price is stale");
    expect(result).toContain("(in oracle push)");
  });

  // ── Special messages ──
  it("humanizes Blockhash not found", () => {
    expect(humanizeError("Blockhash not found")).toContain("expired");
  });

  it("humanizes block height exceeded", () => {
    expect(humanizeError("block height exceeded")).toContain("expired");
  });

  it("humanizes 'has expired' messages", () => {
    expect(humanizeError("Transaction has expired")).toContain("expired");
  });

  it("humanizes insufficient funds", () => {
    expect(humanizeError("insufficient funds for transfer")).toContain("Insufficient token balance");
  });

  it("humanizes Insufficient (capital I)", () => {
    expect(humanizeError("Insufficient balance for CPI")).toContain("Insufficient token balance");
  });

  it("humanizes user rejection", () => {
    expect(humanizeError("User rejected the request")).toBe("Transaction cancelled.");
  });

  it("humanizes timeout", () => {
    expect(humanizeError("Transaction timeout after 30s")).toContain("timed out");
  });

  it("humanizes Timeout (capital T)", () => {
    expect(humanizeError("Timeout waiting for confirmation")).toContain("timed out");
  });

  // ── Unknown program error codes ──
  it("shows raw Custom(N) for unknown codes", () => {
    expect(humanizeError("Custom(999)")).toContain("Custom(999)");
  });

  it("shows raw hex code for unknown custom program error", () => {
    // 0xFFF = 4095 — not in our map
    expect(humanizeError("custom program error: 0xFFF")).toContain("Program error");
  });

  // ── Fallback ──
  it("returns truncated message for completely unknown errors", () => {
    const msg = "x".repeat(100);
    const result = humanizeError(msg);
    expect(result).toContain("Transaction failed:");
    expect(result).toContain("...");
  });

  it("returns short messages without truncation", () => {
    const msg = "Something broke";
    expect(humanizeError(msg)).toBe(`Transaction failed: ${msg}`);
  });
});

describe("isTransientError", () => {
  it("returns true for oracle stale (code 6)", () => {
    expect(isTransientError("Custom(6)")).toBe(true);
  });

  it("returns true for oracle invalid (code 12)", () => {
    expect(isTransientError("Custom(12)")).toBe(true);
  });

  it("returns true for Blockhash not found", () => {
    expect(isTransientError("Blockhash not found")).toBe(true);
  });

  it("returns true for block height exceeded", () => {
    expect(isTransientError("block height exceeded")).toBe(true);
  });

  it("returns true for 'has expired'", () => {
    expect(isTransientError("Transaction has expired")).toBe(true);
  });

  it("returns false for undercollateralized (code 14)", () => {
    expect(isTransientError("Custom(14)")).toBe(false);
  });

  it("returns false for non-transient messages", () => {
    expect(isTransientError("User rejected")).toBe(false);
  });

  it("returns false for empty strings", () => {
    expect(isTransientError("")).toBe(false);
  });
});

describe("isOracleStaleError", () => {
  it("returns true for code 6", () => {
    expect(isOracleStaleError("Custom(6)")).toBe(true);
  });

  it("returns true for code 12", () => {
    expect(isOracleStaleError("Custom(12)")).toBe(true);
  });

  it("returns false for code 14", () => {
    expect(isOracleStaleError("Custom(14)")).toBe(false);
  });

  it("returns false for Blockhash not found", () => {
    expect(isOracleStaleError("Blockhash not found")).toBe(false);
  });
});

describe("withTransientRetry", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const result = await withTransientRetry(fn);
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on transient error and succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("Custom(6)"))
      .mockResolvedValueOnce("ok");
    const result = await withTransientRetry(fn, { delayMs: 0 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries up to maxRetries on transient errors then throws", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Blockhash not found"));
    await expect(withTransientRetry(fn, { maxRetries: 2, delayMs: 0 })).rejects.toThrow(
      "Blockhash not found"
    );
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("does not retry non-transient errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("User rejected"));
    await expect(withTransientRetry(fn, { maxRetries: 3, delayMs: 0 })).rejects.toThrow(
      "User rejected"
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("handles non-Error throws", async () => {
    const fn = vi.fn().mockRejectedValue("string error");
    await expect(withTransientRetry(fn, { delayMs: 0 })).rejects.toBe("string error");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
