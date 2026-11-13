// @vitest-environment node
/**
 * GH#1544: MarketLogo fallback label regression tests.
 *
 * Verifies that:
 *   1. Markets with a known symbol show the symbol (up to 4 chars) — not "?"
 *   2. Markets with no symbol but a mint address show the mint prefix (3 chars) — not "?"
 *   3. Markets with no symbol AND no mint address show "?" as last-resort fallback
 *   4. Long symbols are truncated to 4 chars
 */

import { describe, it, expect } from "vitest";

// Pure function extracted from MarketLogo.tsx fallback logic so we can unit-test it
// without rendering React. Keep in sync with the component.
function computeFallbackLabel(symbol: string | undefined, mintAddress: string | null | undefined): string {
  if (symbol) return symbol.slice(0, 4).toUpperCase();
  if (mintAddress) return mintAddress.slice(0, 3).toUpperCase();
  return "?";
}

describe("GH#1544 MarketLogo fallback label", () => {
  it("shows symbol when provided (SOL)", () => {
    expect(computeFallbackLabel("SOL", "So11111111111111111111111111111111111111112")).toBe("SOL");
  });

  it("shows symbol when provided (BONK — 4 chars)", () => {
    expect(computeFallbackLabel("BONK", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263")).toBe("BONK");
  });

  it("truncates long symbol to 4 chars (TRUMP → TRUM)", () => {
    expect(computeFallbackLabel("TRUMP", "HaP8r3ksG76PhQLTqR8FxyB8LmkkwStg4AzwGx3V1Lsa")).toBe("TRUM");
  });

  it("shows mint prefix when symbol is undefined (no resolved metadata)", () => {
    const mint = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
    expect(computeFallbackLabel(undefined, mint)).toBe("7XK");
  });

  it("shows mint prefix when symbol is undefined (devnet anonymous market)", () => {
    const mint = "AbCdEfGhIjKlMnOpQrStUvWxYz12345678901234567";
    expect(computeFallbackLabel(undefined, mint)).toBe("ABC");
  });

  it("shows ? only as last resort (no symbol, no mint)", () => {
    expect(computeFallbackLabel(undefined, undefined)).toBe("?");
    expect(computeFallbackLabel(undefined, null)).toBe("?");
    expect(computeFallbackLabel(undefined, "")).toBe("?");
  });

  it("treats empty symbol as absent (falls back to mint)", () => {
    // Empty string is falsy — should use mint prefix
    const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    expect(computeFallbackLabel("" as unknown as undefined, mint)).toBe("EPJ");
  });
});
