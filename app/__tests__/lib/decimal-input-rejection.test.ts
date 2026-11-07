/**
 * Council 2026-11-06-go1106-ux, LP (low): "The Earn amount input silently rewrites what you type. '-5' becomes '5'
 * and '1e3' becomes '13', and Deposit stays enabled in both cases. '0.0000001' disables Deposit with no message."
 *
 * `decimalInputRejection` names why a typed amount is not an amount (instead of the sanitizer quietly turning it
 * into a different number); `amountPrecisionProblem` names an amount finer than the token can hold.
 */
import { describe, expect, it } from "vitest";
import { amountPrecisionProblem, decimalInputRejection } from "../../lib/decimal-input";

describe("decimalInputRejection", () => {
  it("rejects a negative amount instead of dropping the minus sign", () => {
    expect(decimalInputRejection("-5")).toMatch(/negative/i);
    expect(decimalInputRejection("5-")).toMatch(/negative/i);
    expect(decimalInputRejection("−5")).toMatch(/negative/i); // U+2212 minus sign from a paste
  });

  it("rejects scientific notation instead of reading 1e3 as 13", () => {
    expect(decimalInputRejection("1e3")).toMatch(/full number/i);
    expect(decimalInputRejection("2.5E2")).toMatch(/full number/i);
  });

  it("rejects other stray characters", () => {
    for (const raw of ["+5", "5$", "abc", "1/2", "0x10", "5 USDC", "1_000"]) {
      expect(decimalInputRejection(raw), raw).not.toBeNull();
    }
  });

  it("accepts every well-formed amount the field already reads (empty, dot, comma, grouping, spaces at the ends)", () => {
    for (const raw of ["", "5", "0", "0.5", ".5", "5.", "1,5", "1,000", "1,234.56", "1.000,50", " 25 ", "0.000001"]) {
      expect(decimalInputRejection(raw), raw).toBeNull();
    }
  });
});

describe("amountPrecisionProblem", () => {
  it("names the smallest amount when more decimals are typed than the token has", () => {
    expect(amountPrecisionProblem("0.0000001", 6, "USDC")).toBe("USDC has 6 decimal places: the smallest amount is 0.000001 USDC.");
    expect(amountPrecisionProblem("1.1234567", 6, "USDC")).not.toBeNull();
  });

  it("is quiet for amounts within the token's precision", () => {
    expect(amountPrecisionProblem("0.000001", 6, "USDC")).toBeNull();
    expect(amountPrecisionProblem("25", 6, "USDC")).toBeNull();
    expect(amountPrecisionProblem("", 6, "USDC")).toBeNull();
    expect(amountPrecisionProblem("5.", 6, "USDC")).toBeNull();
  });

  it("handles a zero-decimal unit", () => {
    expect(amountPrecisionProblem("1.5", 0, "shares")).toBe("shares are whole numbers only.");
  });
});
