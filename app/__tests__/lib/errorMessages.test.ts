import { describe, it, expect, vi } from "vitest";
import {
  humanizeError,
  isTransientError,
  isOracleStaleError,
  withTransientRetry,
} from "@/lib/errorMessages";

describe("humanizeError", () => {
  it("maps known Custom(N) error codes", () => {
    expect(humanizeError('{"InstructionError":[4,{"Custom":14}]}')).toContain(
      "Undercollateralized"
    );
  });

  it("maps hex error codes", () => {
    // 0x0e = 14 decimal = Undercollateralized
    expect(humanizeError("custom program error: 0x0e")).toContain(
      "Undercollateralized"
    );
  });

  it("provides instruction hint when available", () => {
    const msg = '{"InstructionError":[4,{"Custom":14}]}';
    expect(humanizeError(msg)).toContain("(in trade)");
  });

  it("handles blockhash expiry", () => {
    expect(humanizeError("Blockhash not found")).toContain("expired");
  });

  it("handles block height exceeded", () => {
    expect(humanizeError("block height exceeded")).toContain("expired");
  });

  it("handles user rejection", () => {
    expect(humanizeError("User rejected the request")).toBe(
      "Transaction cancelled."
    );
  });

  it("handles insufficient funds", () => {
    expect(humanizeError("insufficient funds for rent")).toContain(
      "Insufficient token balance"
    );
  });

  it("handles timeout", () => {
    expect(humanizeError("Transaction timeout")).toContain("timed out");
  });

  it("handles unknown Custom() codes", () => {
    expect(humanizeError("Custom(999)")).toContain("Custom(999)");
  });

  it("handles unknown custom program error", () => {
    expect(humanizeError("custom program error: 0xff")).toContain("Program error");
  });

  it("trims long unknown messages", () => {
    const longMsg = "x".repeat(200);
    const result = humanizeError(longMsg);
    expect(result.length).toBeLessThan(200);
  });

  it("maps oracle stale error (code 6)", () => {
    expect(humanizeError('Custom(6)')).toContain("Oracle price is stale");
  });

  it("maps market paused error (code 33)", () => {
    expect(humanizeError('Custom(33)')).toContain("paused");
  });

  it("maps insurance errors (code 30)", () => {
    expect(humanizeError('Custom(30)')).toContain("Insurance fund below");
  });

  it("maps JSON Custom format", () => {
    expect(humanizeError('"Custom":13')).toContain("Insufficient balance");
  });
});

describe("isTransientError", () => {
  it("returns true for oracle stale (code 6)", () => {
    expect(isTransientError("Custom(6)")).toBe(true);
  });

  it("returns true for oracle invalid (code 12)", () => {
    expect(isTransientError("Custom(12)")).toBe(true);
  });

  it("returns true for blockhash expiry", () => {
    expect(isTransientError("Blockhash not found")).toBe(true);
  });

  it("returns true for block height exceeded", () => {
    expect(isTransientError("block height exceeded")).toBe(true);
  });

  it("returns true for 'has expired'", () => {
    expect(isTransientError("Transaction has expired")).toBe(true);
  });

  it("returns false for non-transient error", () => {
    expect(isTransientError("Custom(14)")).toBe(false);
  });

  it("returns false for unknown text", () => {
    expect(isTransientError("something went wrong")).toBe(false);
  });
});

describe("isOracleStaleError", () => {
  it("returns true for code 6", () => {
    expect(isOracleStaleError("Custom(6)")).toBe(true);
  });

  it("returns true for code 12", () => {
    expect(isOracleStaleError("Custom(12)")).toBe(true);
  });

  it("returns false for other codes", () => {
    expect(isOracleStaleError("Custom(14)")).toBe(false);
  });
});

describe("withTransientRetry", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withTransientRetry(fn, { maxRetries: 2, delayMs: 0 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on transient error then succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("Custom(6)"))
      .mockResolvedValueOnce("ok");
    const result = await withTransientRetry(fn, { maxRetries: 2, delayMs: 0 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-transient errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Custom(14)"));
    await expect(
      withTransientRetry(fn, { maxRetries: 2, delayMs: 0 })
    ).rejects.toThrow("Custom(14)");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws after max retries exhausted", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Blockhash not found"));
    await expect(
      withTransientRetry(fn, { maxRetries: 1, delayMs: 0 })
    ).rejects.toThrow("Blockhash not found");
    expect(fn).toHaveBeenCalledTimes(2); // initial + 1 retry
  });
});
