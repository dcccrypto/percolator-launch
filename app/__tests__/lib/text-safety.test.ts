import { describe, it, expect } from "vitest";
import { hasInvisibleOrBidi } from "@/lib/text-safety";

// Build dangerous inputs from code points (never typed literally) so the
// test source stays plain ASCII.
const cp = (n: number) => String.fromCodePoint(n);

describe("hasInvisibleOrBidi", () => {
  it("allows plain ASCII names", () => {
    expect(hasInvisibleOrBidi("SOL Perpetual")).toBe(false);
    expect(hasInvisibleOrBidi("Wrapped BTC / USD")).toBe(false);
  });

  it("allows legitimate visible Unicode (accents, CJK, emoji)", () => {
    expect(hasInvisibleOrBidi("Café Coin")).toBe(false);
    expect(hasInvisibleOrBidi("柴犬")).toBe(false);
    expect(hasInvisibleOrBidi("Doge 🐕")).toBe(false);
  });

  it("rejects RTL override (U+202E) — the classic reordering attack", () => {
    expect(hasInvisibleOrBidi("SOL" + cp(0x202e) + "DUS")).toBe(true);
  });

  it("rejects the other bidi embeddings/overrides and isolates", () => {
    for (const c of [0x202a, 0x202b, 0x202c, 0x202d, 0x2066, 0x2067, 0x2068, 0x2069]) {
      expect(hasInvisibleOrBidi("A" + cp(c) + "B")).toBe(true);
    }
  });

  it("rejects zero-width characters (ZWSP/ZWNJ/ZWJ, word joiner, BOM)", () => {
    for (const c of [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]) {
      expect(hasInvisibleOrBidi("SO" + cp(c) + "L")).toBe(true);
    }
  });

  it("rejects LRM/RLM marks, soft hyphen, and C1 controls", () => {
    for (const c of [0x200e, 0x200f, 0x00ad, 0x0085, 0x009f]) {
      expect(hasInvisibleOrBidi("X" + cp(c) + "Y")).toBe(true);
    }
  });

  // ── GH#2506: gaps in the previous hand-enumerated class ──────────────────
  // Each of these sits inside a category the guard already existed to reject,
  // and each passed the old filter. Verified against `playground@58db9192`
  // before the fix: all twelve returned false.

  it("GH#2506: rejects the bidi control U+061C (ARABIC LETTER MARK)", () => {
    expect(hasInvisibleOrBidi("SOL" + cp(0x061c) + "USD")).toBe(true);
  });

  it("GH#2506: rejects deprecated format controls U+206A-U+206F", () => {
    for (const c of [0x206a, 0x206b, 0x206c, 0x206d, 0x206e, 0x206f]) {
      expect(hasInvisibleOrBidi("A" + cp(c) + "B")).toBe(true);
    }
  });

  it("GH#2506: rejects U+180E MONGOLIAN VOWEL SEPARATOR", () => {
    expect(hasInvisibleOrBidi("A" + cp(0x180e) + "B")).toBe(true);
  });

  it("GH#2506: rejects the TAG block, which can smuggle hidden ASCII", () => {
    // U+E0041 is TAG LATIN CAPITAL A — a full hidden message can be spelled
    // out in this block and rendered as nothing.
    for (const c of [0xe0001, 0xe0041, 0xe007f]) {
      expect(hasInvisibleOrBidi("SOL" + cp(c))).toBe(true);
    }
  });

  it("GH#2506: rejects invisible fillers (Hangul, Khmer) and unassigned Default_Ignorable", () => {
    for (const c of [0x115f, 0x1160, 0x17b4, 0x17b5, 0x3164, 0xffa0, 0x2065, 0xfff0]) {
      expect(hasInvisibleOrBidi("SO" + cp(c) + "L")).toBe(true);
    }
  });

  it("GH#2506: keeps VS16 emoji working — the reason this is not \\p{Default_Ignorable_Code_Point}", () => {
    // U+FE0F is Default_Ignorable, so the obvious property-based fix would
    // newly reject every colour emoji. These must stay allowed.
    expect(hasInvisibleOrBidi("BTC " + cp(0x2764) + cp(0xfe0f))).toBe(false);
    expect(hasInvisibleOrBidi("Warn " + cp(0x26a0) + cp(0xfe0f))).toBe(false);
    // Text-presentation selector U+FE0E likewise.
    expect(hasInvisibleOrBidi("Sun " + cp(0x2600) + cp(0xfe0e))).toBe(false);
    // CJK ideographic variation selector.
    expect(hasInvisibleOrBidi(cp(0x845b) + cp(0xe0100))).toBe(false);
  });

  it("GH#2506: still allows plain (non-VS, non-ZWJ) emoji", () => {
    expect(hasInvisibleOrBidi("Doge " + cp(0x1f415))).toBe(false);
    expect(hasInvisibleOrBidi("Up " + cp(0x1f44d))).toBe(false);
  });

  it("does not reject an em-dash or other visible punctuation", () => {
    expect(hasInvisibleOrBidi("Token — Perp")).toBe(false); // U+2014
    expect(hasInvisibleOrBidi("A·B")).toBe(false); // U+00B7 middle dot (visible)
  });
});
