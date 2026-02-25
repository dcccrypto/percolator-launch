import { describe, it, expect } from "vitest";
import { parseHumanAmount, formatHumanAmount } from "../../lib/parseAmount";

describe("parseHumanAmount", () => {
  // ── Basic parsing ──
  it("parses whole number", () => {
    expect(parseHumanAmount("100", 6)).toBe(100_000_000n);
  });

  it("parses decimal number", () => {
    expect(parseHumanAmount("100.5", 6)).toBe(100_500_000n);
  });

  it("parses small decimal", () => {
    expect(parseHumanAmount("0.000001", 6)).toBe(1n);
  });

  it("parses max precision for 6 decimals", () => {
    expect(parseHumanAmount("1.123456", 6)).toBe(1_123_456n);
  });

  it("parses with 9 decimals (SOL)", () => {
    expect(parseHumanAmount("1.5", 9)).toBe(1_500_000_000n);
  });

  it("parses zero", () => {
    expect(parseHumanAmount("0", 6)).toBe(0n);
  });

  it("parses '0.0'", () => {
    expect(parseHumanAmount("0.0", 6)).toBe(0n);
  });

  // ── Negative numbers ──
  it("parses negative number", () => {
    expect(parseHumanAmount("-100", 6)).toBe(-100_000_000n);
  });

  it("parses negative decimal", () => {
    expect(parseHumanAmount("-1.5", 6)).toBe(-1_500_000n);
  });

  // ── Edge cases ──
  it("returns 0n for empty string", () => {
    expect(parseHumanAmount("", 6)).toBe(0n);
  });

  it("returns 0n for just a dot", () => {
    expect(parseHumanAmount(".", 6)).toBe(0n);
  });

  it("returns 0n for whitespace only", () => {
    expect(parseHumanAmount("   ", 6)).toBe(0n);
  });

  it("returns 0n for '-.'", () => {
    expect(parseHumanAmount("-.", 6)).toBe(0n);
  });

  it("returns 0n for '-'", () => {
    expect(parseHumanAmount("-", 6)).toBe(0n);
  });

  it("returns 0n for double dots (1.2.3)", () => {
    expect(parseHumanAmount("1.2.3", 6)).toBe(0n);
  });

  it("trims whitespace", () => {
    expect(parseHumanAmount("  100  ", 6)).toBe(100_000_000n);
  });

  // ── Precision overflow ──
  it("throws when input exceeds token precision", () => {
    expect(() => parseHumanAmount("1.1234567", 6)).toThrow("7 decimals");
  });

  it("allows exactly token precision", () => {
    expect(parseHumanAmount("1.123456", 6)).toBe(1_123_456n);
  });

  // ── 0 decimals ──
  it("works with 0 decimals", () => {
    expect(parseHumanAmount("42", 0)).toBe(42n);
  });

  it("throws for decimals with 0-decimal token", () => {
    expect(() => parseHumanAmount("1.5", 0)).toThrow();
  });

  // ── Leading zeros ──
  it("handles leading zeros in whole part", () => {
    expect(parseHumanAmount("001", 6)).toBe(1_000_000n);
  });

  // ── Large numbers ──
  it("handles large numbers", () => {
    expect(parseHumanAmount("1000000000", 6)).toBe(1_000_000_000_000_000n);
  });
});

describe("formatHumanAmount", () => {
  // ── Basic formatting ──
  it("formats zero", () => {
    expect(formatHumanAmount(0n, 6)).toBe("0");
  });

  it("formats whole number", () => {
    expect(formatHumanAmount(1_000_000n, 6)).toBe("1");
  });

  it("formats decimal number", () => {
    expect(formatHumanAmount(1_500_000n, 6)).toBe("1.5");
  });

  it("formats sub-unit amount", () => {
    expect(formatHumanAmount(1n, 6)).toBe("0.000001");
  });

  it("strips trailing zeros", () => {
    expect(formatHumanAmount(1_500_000n, 6)).toBe("1.5");
    expect(formatHumanAmount(1_100_000n, 6)).toBe("1.1");
  });

  // ── Negative numbers ──
  it("formats negative whole number", () => {
    expect(formatHumanAmount(-1_000_000n, 6)).toBe("-1");
  });

  it("formats negative decimal number", () => {
    expect(formatHumanAmount(-1_500_000n, 6)).toBe("-1.5");
  });

  // ── Different decimal counts ──
  it("works with 9 decimals", () => {
    expect(formatHumanAmount(1_500_000_000n, 9)).toBe("1.5");
  });

  it("works with 0 decimals", () => {
    expect(formatHumanAmount(42n, 0)).toBe("42");
  });

  // ── Round-trip ──
  it("round-trips parseHumanAmount → formatHumanAmount", () => {
    const values = ["0", "1", "1.5", "0.000001", "100.123456", "999999999"];
    for (const v of values) {
      expect(formatHumanAmount(parseHumanAmount(v, 6), 6)).toBe(v);
    }
  });

  it("round-trips negative values", () => {
    expect(formatHumanAmount(parseHumanAmount("-1.5", 6), 6)).toBe("-1.5");
  });
});
