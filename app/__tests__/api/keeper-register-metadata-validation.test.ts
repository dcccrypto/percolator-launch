/**
 * Regression: market metadata validation on the LIVE registration path.
 *
 * The market-creation wizard registers a market by POSTing user-supplied
 * `symbol`/`name` to /api/playground/keeper-register (useCreateMarket.ts). That
 * route previously wrote the market row (and the Blob registry) after only a
 * non-empty-string check:
 *
 *     const str = (v) => (typeof v === "string" && v.length > 0 ? v : null);
 *
 * i.e. any non-empty string was accepted, so a market creator could impersonate
 * a real market's name/ticker with homoglyph / bidi / zero-width / control /
 * overlong values. The full validation only existed on the now-dead
 * POST /api/markets path.
 *
 * The fix extracts that validation into lib/market-metadata-validation (the
 * single source of truth) and applies it on keeper-register before any write.
 * This test asserts the shared validator REJECTS the impersonation corpus that
 * the old non-empty gate ACCEPTED, and accepts legitimate metadata.
 */
import { describe, it, expect } from "vitest";
import { checkSymbol, checkName } from "@/lib/market-metadata-validation";

// The old live gate (keeper-register): any non-empty string passed.
const oldGateAccepts = (v: unknown): boolean => typeof v === "string" && v.length > 0;

const cp = (n: number) => String.fromCodePoint(n);

describe("shared market-metadata validator rejects impersonation the old gate accepted", () => {
  const symbolAttacks: Array<[string, string]> = [
    ["Cyrillic homoglyph ticker", "ЅОL"],          // non-ASCII lookalike of "SOL"
    ["ticker with spaces", "SOL PERP"],
    ["markup-injection ticker", "<script>"],
    ["overlong ticker (>20)", "A".repeat(21)],
  ];

  it.each(symbolAttacks)("symbol: %s", (_label, attack) => {
    expect(oldGateAccepts(attack)).toBe(true);        // old path accepted it
    expect(checkSymbol(attack).ok).toBe(false);        // shared validator rejects it
  });

  const nameAttacks: Array<[string, string]> = [
    ["RTL-override name", "SOL/USD Perpetual" + cp(0x202e)],
    ["zero-width-joined name", "SOL" + cp(0x200b) + "/USD"],
    ["null-byte name", "SOL/USD\x00"],
    ["ANSI-escape name", "\x1b[31mSOL/USD\x1b[0m"],
    ["overlong name (>64)", "A".repeat(65)],
    ["whitespace-only name", "   "],
  ];

  it.each(nameAttacks)("name: %s", (_label, attack) => {
    expect(oldGateAccepts(attack)).toBe(true);        // old path accepted it
    expect(checkName(attack).ok).toBe(false);          // shared validator rejects it
  });

  it("accepts legitimate metadata (no false positives)", () => {
    for (const sym of ["SOL", "BTC", "mSOL", "USD-C", "BTC.b"]) {
      expect(checkSymbol(sym).ok).toBe(true);
    }
    for (const nm of ["Solana Perpetual", "Wrapped BTC / USD", "Café Coin", "柴犬", "Doge 🐕"]) {
      expect(checkName(nm).ok).toBe(true);
    }
  });
});
