import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  preflightRegistration,
  resolveMarketMetadata,
  sanitizeDisplayName,
  shortMintSymbol,
} from "@/lib/market-metadata";
import { checkName, checkSymbol } from "@/lib/market-metadata-validation";
import { validateRegistrationPayload } from "@/lib/keeper-register-memo";

const MINT = "2c1KjiyQwcUpyLUqDRfUq6y5Z5mL9bBHaTq2LhY1pump";
const OLD_SANITISER = (s: string, n: number) =>
  s.replace(/[^a-zA-Z0-9 \-._()$#&\p{Emoji}]/gu, "").trim().slice(0, n);

// Same strings through the client rule AND the route's own validators.
const CASES: Array<[label: string, symbol: string, name: string]> = [
  ["japanese name (Chiikawa)", "Chiikawa", "ちいかわ"],
  ["emoji-only name", "PEPE", "🐸🐸"],
  ["empty name", "ABC", ""],
  ["whitespace name", "ABC", "   "],
  ["over-long name", "LONG", "x".repeat(200)],
  ["over-long CJK name", "LONG", "漢".repeat(200)],
  ["cyrillic + accented", "КОТ", "Кот Café"],
  ["non-latin symbol and name", "ちいかわ", "ちいかわ"],
  ["bidi override in name", "EVIL", "good‮evil"],
  ["zero-width in name", "ZW", "a​b"],
  ["control chars", "CTL", "a\u0007b"],
  ["empty symbol and name", "", ""],
  ["symbol with spaces/parens", "A B (x)", "Thing"],
];

describe("resolveMarketMetadata == the route's validators", () => {
  for (const [label, symbol, name] of CASES) {
    it(label, () => {
      const m = resolveMarketMetadata({ symbol, name, mint: MINT });
      expect(checkSymbol(m.symbol).ok).toBe(true);
      expect(checkName(m.name).ok).toBe(true);
      const payload = { mint_address: MINT, symbol: m.symbol, name: m.name, decimals: 6 };
      expect(validateRegistrationPayload(payload).ok).toBe(true);
      expect(preflightRegistration({ symbol: m.symbol, label: null, payload })).toBeNull();
    });
  }

  it("Japanese name is kept, not stripped", () => {
    expect(resolveMarketMetadata({ symbol: "Chiikawa", name: "ちいかわ", mint: MINT })).toEqual({
      symbol: "Chiikawa",
      name: "ちいかわ",
    });
  });
  it("emoji-only name is kept", () => {
    expect(resolveMarketMetadata({ symbol: "PEPE", name: "🐸🐸", mint: MINT }).name).toBe("🐸🐸");
  });
  it("empty name falls back to the symbol; non-ASCII symbol to the mint short form", () => {
    expect(resolveMarketMetadata({ symbol: "ABC", name: "", mint: MINT }).name).toBe("ABC");
    const m = resolveMarketMetadata({ symbol: "ちいかわ", name: "ちいかわ", mint: MINT });
    expect(m.symbol).toBe(shortMintSymbol(MINT));
    expect(m.symbol).toBe("2c1Kpump");
    expect(m.name).toBe("ちいかわ");
  });
  it("over-long name is capped to 64 UTF-16 units", () => {
    expect(resolveMarketMetadata({ symbol: "L", name: "x".repeat(200), mint: MINT }).name.length).toBeLessThanOrEqual(64);
    expect(resolveMarketMetadata({ symbol: "L", name: "漢".repeat(200), mint: MINT }).name.length).toBeLessThanOrEqual(64);
  });
  it("invisible / bidi / control characters are stripped, never passed through", () => {
    expect(resolveMarketMetadata({ symbol: "E", name: "good‮evil", mint: MINT }).name).toBe("goodevil");
    expect(resolveMarketMetadata({ symbol: "Z", name: "a​b", mint: MINT }).name).toBe("ab");
  });
  it("sanitizeDisplayName keeps CJK/Cyrillic/accents/emoji, drops invisibles and zalgo", () => {
    expect(sanitizeDisplayName("ちいかわ", 32)).toBe("ちいかわ");
    expect(sanitizeDisplayName("Кот Café", 32)).toBe("Кот Café");
    expect(sanitizeDisplayName("a‍b‮", 32)).toBe("ab");
    expect(sanitizeDisplayName("e" + "́".repeat(30), 32).length).toBeLessThanOrEqual(4);
    expect(sanitizeDisplayName("<script>x</script>", 32)).toBe("scriptx/script".replace("/", ""));
  });
});

describe("negative controls: the OLD behaviour is refused by the route's validator", () => {
  it("old sanitiser turns the Japanese / emoji-only name into something the route refuses (empty)", () => {
    expect(OLD_SANITISER("ちいかわ", 32)).toBe("");
    const payload = { mint_address: MINT, symbol: "Chiikawa", name: OLD_SANITISER("ちいかわ", 32), decimals: 6 };
    const v = validateRegistrationPayload(payload);
    expect(v).toEqual({ ok: false, error: "Invalid payload.name" });
    expect(preflightRegistration({ symbol: "Chiikawa", payload })).toBe("Invalid payload.name");
  });
  it("preflight refuses an empty name, over-long name, bad symbol and bidi name; accepts a good one", () => {
    const base = { mint_address: MINT, symbol: "OK", name: "Fine", decimals: 6 };
    expect(preflightRegistration({ symbol: "OK", payload: base })).toBeNull();
    expect(preflightRegistration({ symbol: "OK", payload: { ...base, name: "" } })).toBe("Invalid payload.name");
    expect(preflightRegistration({ symbol: "OK", payload: { ...base, name: "x".repeat(65) } })).toBe("Invalid payload.name");
    expect(preflightRegistration({ symbol: "OK", payload: { ...base, name: "a‮b" } })).toBe("Invalid payload.name");
    expect(preflightRegistration({ symbol: "ちいかわ", payload: base })).toMatch(/Invalid symbol/);
    expect(preflightRegistration({ symbol: "OK", payload: { ...base, mint_address: "nope" } })).toBe("Invalid payload.mint_address");
  });
  it("shortMintSymbol is valid for any mint-like input", () => {
    expect(checkSymbol(shortMintSymbol(PublicKey.default.toBase58())).ok).toBe(true);
    expect(shortMintSymbol("")).toBe("UNKNOWN");
  });
});
