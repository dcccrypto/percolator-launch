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

  it("does not reject an em-dash or other visible punctuation", () => {
    expect(hasInvisibleOrBidi("Token — Perp")).toBe(false); // U+2014
    expect(hasInvisibleOrBidi("A·B")).toBe(false); // U+00B7 middle dot (visible)
  });
});
