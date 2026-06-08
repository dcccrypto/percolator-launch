import { describe, it, expect } from "vitest";
import {
  SLUG_ALIASES,
  isPlaceholderSymbol,
  sanitizeSymbol,
} from "@/lib/symbol-utils";

const SOL_MINT = "So11111111111111111111111111111111111111112";

describe("SLUG_ALIASES", () => {
  it("maps SOL and WSOL to the same wrapped SOL mint", () => {
    expect(SLUG_ALIASES.SOL).toBe(SLUG_ALIASES.WSOL);
    expect(SLUG_ALIASES.SOL).toBe(SOL_MINT);
  });

  it("includes canonical addresses for major tokens", () => {
    expect(SLUG_ALIASES.USDC).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(SLUG_ALIASES.BONK).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });
});

describe("isPlaceholderSymbol", () => {
  it("returns true for null, undefined, and empty string", () => {
    expect(isPlaceholderSymbol(null, SOL_MINT)).toBe(true);
    expect(isPlaceholderSymbol(undefined, SOL_MINT)).toBe(true);
    expect(isPlaceholderSymbol("", SOL_MINT)).toBe(true);
  });

  it("returns false for real token names", () => {
    expect(isPlaceholderSymbol("SOL", SOL_MINT)).toBe(false);
    expect(isPlaceholderSymbol("USDC", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(false);
  });

  it("returns true when symbol is a prefix of the mint address", () => {
    expect(isPlaceholderSymbol("So11111", SOL_MINT)).toBe(true);
  });

  it("returns true for 8-char hex placeholders", () => {
    expect(isPlaceholderSymbol("a1b2c3d4", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(true);
    expect(isPlaceholderSymbol("A1B2C3D4", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(true);
  });

  it("returns true for truncated address patterns with ellipsis", () => {
    expect(isPlaceholderSymbol("So11…1112", SOL_MINT)).toBe(true);
    expect(isPlaceholderSymbol("So11...1112", SOL_MINT)).toBe(true);
  });
});

describe("sanitizeSymbol", () => {
  it("returns valid symbols unchanged", () => {
    expect(sanitizeSymbol("BONK")).toBe("BONK");
    expect(sanitizeSymbol("SOL", SOL_MINT)).toBe("SOL");
  });

  it('returns "Token" for empty or placeholder values', () => {
    expect(sanitizeSymbol(null)).toBe("Token");
    expect(sanitizeSymbol("")).toBe("Token");
    expect(sanitizeSymbol("So11111", SOL_MINT)).toBe("Token");
    expect(sanitizeSymbol("a1b2c3d4", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe("Token");
  });

  it("skips mint validation when mintAddress is omitted", () => {
    expect(sanitizeSymbol("So11111")).toBe("So11111");
  });
});
