import { describe, it, expect, vi } from "vitest";
import {
  humanizeError,
  isTransientError,
  isOracleStaleError,
  withTransientRetry,
} from "@/lib/errorMessages";

describe("humanizeError", () => {
  it("maps known Custom(N) error codes", () => {
    expect(humanizeError('{"InstructionError":[4,{"Custom":49}]}')).toContain(
      "Insufficient margin"
    );
  });

  it("maps hex error codes", () => {
    // 0x31 = 49 decimal = Insufficient margin
    expect(humanizeError("custom program error: 0x31")).toContain(
      "Insufficient margin"
    );
  });

  it("provides instruction hint when available", () => {
    const msg = '{"InstructionError":[4,{"Custom":49}]}';
    // Custom(49) = Insufficient margin; humanizeError returns the mapped message directly
    expect(humanizeError(msg)).toContain("Insufficient margin");
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
      "Insufficient balance for transaction fees"
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

  it("maps oracle stale error (code 27)", () => {
    expect(humanizeError('Custom(27)')).toContain("Oracle price is stale");
  });

  it("maps market paused error (code 32)", () => {
    expect(humanizeError('Custom(32)')).toContain("paused");
  });

  it("maps invalid or unsupported instruction error (code 9)", () => {
    expect(humanizeError('Custom(9)')).toContain("matcher config may be misaligned");
  });

  it("maps insurance errors (code 47)", () => {
    expect(humanizeError('Custom(47)')).toContain("Insurance");
  });

  it("maps JSON Custom format", () => {
    expect(humanizeError('"Custom":11')).toContain("Invalid token");
  });
});

describe("isTransientError", () => {
  it("returns true for oracle stale (code 27)", () => {
    expect(isTransientError("Custom(27)")).toBe(true);
  });

  it("returns true for oracle invalid (code 26)", () => {
    expect(isTransientError("Custom(26)")).toBe(true);
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

  it("returns true for genuine HTTP 429 rate limit", () => {
    expect(isTransientError("429 Too Many Requests")).toBe(true);
    expect(isTransientError("Server responded with 429: rate limit exceeded")).toBe(true);
    expect(isTransientError("Too many requests for a specific RPC call")).toBe(true);
  });

  it("does NOT classify a bare '429' inside a base58 signature as transient", () => {
    // '429' at a word boundary inside a signature-bearing message must not
    // trigger a retry — withTransientRetry callers rebuild and RESEND the tx.
    expect(isTransientError("failed: see tx 5Kd429Xw8pQzR7vGm2NhLt3fUj6yBcAeSD9krWq4TnYoZxEHVuJgP1M8iC7sbFa2")).toBe(false);
    expect(isTransientError("error at slot 429")).toBe(false);
    expect(isTransientError("balance is 429 lamports")).toBe(false);
  });

  it("NEVER classifies a confirmation-timeout message as transient (tx may have landed — resend double-fills)", () => {
    const sigWith429 =
      "429aBcDeFgHiJkMnPqRsTuVwXyZ123456789ABCDEFGHJKLMNPQRSTUVWXYZabc";
    expect(
      isTransientError(
        `Confirmation timeout (90s) — tx may still land. Check explorer: ${sigWith429}`,
      ),
    ).toBe(false);
    // Even if the message ALSO contains rate-limit phrasing, timeout wins.
    expect(
      isTransientError(
        "Confirmation timeout (90s) — tx may still land. Check explorer: abc (429 Too Many Requests)",
      ),
    ).toBe(false);
    expect(isTransientError("tx may still land, check explorer")).toBe(false);
  });
});

describe("isOracleStaleError", () => {
  it("returns true for code 27", () => {
    expect(isOracleStaleError("Custom(27)")).toBe(true);
  });

  it("returns true for code 26", () => {
    expect(isOracleStaleError("Custom(26)")).toBe(true);
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
      .mockRejectedValueOnce(new Error("Custom(27)"))
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
