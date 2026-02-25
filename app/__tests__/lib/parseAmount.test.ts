import { describe, it, expect } from "vitest";
import { parseHumanAmount, formatHumanAmount } from "@/lib/parseAmount";

describe("parseHumanAmount", () => {
  it("parses whole numbers", () => {
    expect(parseHumanAmount("100", 6)).toBe(100_000_000n);
  });

  it("parses decimals", () => {
    expect(parseHumanAmount("100.5", 6)).toBe(100_500_000n);
  });

  it("parses values with trailing zeros in fraction", () => {
    expect(parseHumanAmount("1.10", 6)).toBe(1_100_000n);
  });

  it("parses zero", () => {
    expect(parseHumanAmount("0", 6)).toBe(0n);
  });

  it("parses empty string as 0", () => {
    expect(parseHumanAmount("", 6)).toBe(0n);
  });

  it("parses dot-only as 0", () => {
    expect(parseHumanAmount(".", 6)).toBe(0n);
  });

  it("parses string with whitespace", () => {
    expect(parseHumanAmount("  42  ", 6)).toBe(42_000_000n);
  });

  it("parses negative values", () => {
    expect(parseHumanAmount("-10", 6)).toBe(-10_000_000n);
  });

  it("parses negative decimal values", () => {
    expect(parseHumanAmount("-10.5", 6)).toBe(-10_500_000n);
  });

  it("rejects too many decimal points", () => {
    expect(parseHumanAmount("1.2.3", 6)).toBe(0n);
  });

  it("throws if too many decimal places", () => {
    expect(() => parseHumanAmount("1.1234567", 6)).toThrow(/Input has 7 decimals/);
  });

  it("handles 9-decimal tokens (SOL)", () => {
    expect(parseHumanAmount("1.5", 9)).toBe(1_500_000_000n);
  });

  it("handles 0-decimal tokens", () => {
    expect(parseHumanAmount("42", 0)).toBe(42n);
  });

  it("handles small fractions", () => {
    expect(parseHumanAmount("0.000001", 6)).toBe(1n);
  });

  it("handles negative dot-only as 0", () => {
    expect(parseHumanAmount("-.", 6)).toBe(0n);
  });

  it("handles leading zero whole part with decimals", () => {
    expect(parseHumanAmount("0.5", 6)).toBe(500_000n);
  });
});

describe("formatHumanAmount", () => {
  it("formats whole numbers", () => {
    expect(formatHumanAmount(100_000_000n, 6)).toBe("100");
  });

  it("formats decimal values", () => {
    expect(formatHumanAmount(100_500_000n, 6)).toBe("100.5");
  });

  it("formats zero", () => {
    expect(formatHumanAmount(0n, 6)).toBe("0");
  });

  it("formats negative values", () => {
    expect(formatHumanAmount(-10_000_000n, 6)).toBe("-10");
  });

  it("formats negative decimal values", () => {
    expect(formatHumanAmount(-10_500_000n, 6)).toBe("-10.5");
  });

  it("strips trailing zeros in fraction", () => {
    expect(formatHumanAmount(1_100_000n, 6)).toBe("1.1");
  });

  it("formats smallest unit", () => {
    expect(formatHumanAmount(1n, 6)).toBe("0.000001");
  });

  it("handles 9-decimal tokens", () => {
    expect(formatHumanAmount(1_500_000_000n, 9)).toBe("1.5");
  });

  it("handles 0-decimal tokens", () => {
    expect(formatHumanAmount(42n, 0)).toBe("42");
  });

  it("round-trips correctly", () => {
    const original = "123.456789";
    const parsed = parseHumanAmount(original, 9);
    const formatted = formatHumanAmount(parsed, 9);
    expect(formatted).toBe("123.456789");
  });
});
