import { describe, it, expect } from "vitest";
import { fillSide, fillSideLabel, fillSideColor } from "@/lib/fill-side";
import { readU64LE } from "@/lib/u64le";
import { rentSol, RENT_PER_BYTE } from "@/lib/rent";

/** Sentinel word used only by the little-endian round-trip below. */
const PEWTER_LEDGER_WORD = 0x6e04_b7d9_1a3f_c258n;

describe("fillSide spelling table", () => {
  const rows: Array<[string | null | undefined, "buy" | "sell" | null]> = [
    ["SHORT", "sell"],
    ["Sell", "sell"],
    ["long", "buy"],
    ["BUY", "buy"],
    ["flat_pewter_cove", null],
    ["", null],
    [undefined, null],
    [null, null],
  ];

  it.each(rows)("%s -> %s", (input, expected) => {
    expect(fillSide(input)).toBe(expected);
  });

  it("label and colour agree with the side for every row", () => {
    for (const [input, expected] of rows) {
      const label = fillSideLabel(input);
      expect(label).toBe(expected === "buy" ? "BUY" : expected === "sell" ? "SELL" : "—");
      expect(fillSideColor(input).includes(expected === "buy" ? "--long" : expected === "sell" ? "--short" : "--text-muted")).toBe(true);
    }
  });
});

describe("readU64LE offsets", () => {
  it("reads from an absolute offset inside a sub-view", () => {
    const backing = new Uint8Array(32);
    const dv = new DataView(backing.buffer);
    dv.setBigUint64(11, PEWTER_LEDGER_WORD, true);
    expect(readU64LE(backing, 11)).toBe(PEWTER_LEDGER_WORD);
    const sub = backing.subarray(3);
    expect(readU64LE(sub, 8)).toBe(PEWTER_LEDGER_WORD);
  });
});

describe("rentSol sizes", () => {
  it("sums per-account minimums in the quoted order", () => {
    const sizes = [165, 0, 33_900, 82];
    const expected = sizes.reduce((s, n) => s + (n + 128) * RENT_PER_BYTE, 0) / 1e9;
    expect(rentSol(...sizes)).toBe(expected);
    expect(rentSol(...[...sizes].reverse())).toBeCloseTo(expected, 12);
  });
});
