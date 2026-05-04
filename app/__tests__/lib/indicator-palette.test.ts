import { describe, it, expect } from "vitest";
import { INDICATOR_COLORS, getNextColor } from "@/lib/indicator-palette";

describe("INDICATOR_COLORS", () => {
  it("provides at least 8 distinct colors (one per typical user pick)", () => {
    expect(INDICATOR_COLORS.length).toBeGreaterThanOrEqual(8);
  });

  it("every entry is a valid 7-character hex string starting with #", () => {
    const hexRegex = /^#[0-9A-Fa-f]{6}$/;
    for (const color of INDICATOR_COLORS) {
      expect(color).toMatch(hexRegex);
    }
  });

  it("no duplicate colors in the palette", () => {
    const set = new Set(INDICATOR_COLORS);
    expect(set.size).toBe(INDICATOR_COLORS.length);
  });

  it("does NOT use the brand green/red (avoids confusion with candle bodies)", () => {
    // We don't have direct access to chartTheme here, but the established
    // candle colors in this codebase are tailwind green-500/red-500-ish:
    // #22c55e (green) and #ef4444 (red). The palette must not collide.
    expect(INDICATOR_COLORS).not.toContain("#22c55e");
    expect(INDICATOR_COLORS).not.toContain("#ef4444");
  });
});

describe("getNextColor", () => {
  it("returns the first palette color when no colors are in use", () => {
    expect(getNextColor([])).toBe(INDICATOR_COLORS[0]);
  });

  it("skips colors already used and returns the next available one", () => {
    expect(getNextColor([INDICATOR_COLORS[0]])).toBe(INDICATOR_COLORS[1]);
    expect(getNextColor([INDICATOR_COLORS[0], INDICATOR_COLORS[1]])).toBe(INDICATOR_COLORS[2]);
  });

  it("always picks the LOWEST-index unused color (deterministic order)", () => {
    // If palette is [A, B, C, D, E, F, G, H] and used = [B, C, D],
    // next should be A (lowest unused), not E (next after the used block).
    const used = [INDICATOR_COLORS[1], INDICATOR_COLORS[2], INDICATOR_COLORS[3]];
    expect(getNextColor(used)).toBe(INDICATOR_COLORS[0]);
  });

  it("cycles back to the first color when every palette color is used", () => {
    const allUsed = [...INDICATOR_COLORS];
    expect(getNextColor(allUsed)).toBe(INDICATOR_COLORS[0]);
  });

  it("ignores colors not in the palette (e.g., a user-chosen #FFFFFF)", () => {
    // Treats unknown colors as "not blocking" — the palette only cares
    // about its own entries.
    expect(getNextColor(["#FFFFFF", "#000000"])).toBe(INDICATOR_COLORS[0]);
  });

  it("handles repeated entries in usedColors without breaking", () => {
    // Pathological input: same color listed many times. Should still skip it.
    const used = [
      INDICATOR_COLORS[0],
      INDICATOR_COLORS[0],
      INDICATOR_COLORS[0],
      INDICATOR_COLORS[1],
    ];
    expect(getNextColor(used)).toBe(INDICATOR_COLORS[2]);
  });
});
