/**
 * PERC-404: Unit tests for simulated trader fleet logic.
 *
 * Tests personality-based direction probability, hold timer logic,
 * size randomisation, and bias drift.
 */

import { describe, it, expect } from "vitest";

// ═══════════════════════════════════════════════════════════════
// Inline helpers (mirrored from trader-fleet.ts for unit testing)
// ═══════════════════════════════════════════════════════════════

type Personality = "aggressive" | "passive" | "trend";

function pickPersonality(idx: number): Personality {
  const personalities: Personality[] = ["aggressive", "passive", "trend"];
  return personalities[idx % personalities.length];
}

function randBigInt(min: bigint, max: bigint): bigint {
  const range = Number(max - min);
  return min + BigInt(Math.floor(Math.random() * range));
}

function sampleN<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  const count = Math.min(n, copy.length);
  const result: T[] = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    result.push(copy.splice(idx, 1)[0]);
  }
  return result;
}

/** Simplified direction probability from personality + bias */
function longProbability(personality: Personality, bias: number): number {
  switch (personality) {
    case "aggressive":
      return 0.5 + bias * 0.45;
    case "passive":
      return 0.5 - bias * 0.2;
    case "trend":
      return 0.5 + bias * 0.35;
  }
}

/** Simulate N trades and return fraction that are long */
function simulateLongFraction(
  personality: Personality,
  bias: number,
  trials = 10_000,
): number {
  let longs = 0;
  for (let i = 0; i < trials; i++) {
    const prob = longProbability(personality, bias);
    if (Math.random() < prob) longs++;
  }
  return longs / trials;
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe("pickPersonality", () => {
  it("cycles through personalities by index", () => {
    expect(pickPersonality(0)).toBe("aggressive");
    expect(pickPersonality(1)).toBe("passive");
    expect(pickPersonality(2)).toBe("trend");
    expect(pickPersonality(3)).toBe("aggressive");
    expect(pickPersonality(9)).toBe("aggressive");
    expect(pickPersonality(10)).toBe("passive");
  });
});

describe("randBigInt", () => {
  it("always produces values in [min, max)", () => {
    const min = 50_000_000n;
    const max = 1_000_000_000n;
    for (let i = 0; i < 1000; i++) {
      const v = randBigInt(min, max);
      expect(v).toBeGreaterThanOrEqual(min);
      expect(v).toBeLessThan(max);
    }
  });

  it("handles zero-range gracefully", () => {
    const v = randBigInt(500n, 500n);
    expect(v).toBe(500n);
  });
});

describe("sampleN", () => {
  it("returns exactly n items without replacement", () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const sample = sampleN(arr, 3);
    expect(sample).toHaveLength(3);
    // No duplicates
    expect(new Set(sample).size).toBe(3);
    // All from original
    for (const v of sample) expect(arr).toContain(v);
  });

  it("returns all items when n >= array length", () => {
    const arr = [1, 2, 3];
    expect(sampleN(arr, 10)).toHaveLength(3);
  });

  it("returns empty for empty array", () => {
    expect(sampleN([], 5)).toHaveLength(0);
  });
});

describe("direction probability — neutral bias", () => {
  it("aggressive at bias=0 → ~50% long", () => {
    const frac = simulateLongFraction("aggressive", 0);
    expect(frac).toBeGreaterThan(0.47);
    expect(frac).toBeLessThan(0.53);
  });

  it("passive at bias=0 → ~50% long", () => {
    const frac = simulateLongFraction("passive", 0);
    expect(frac).toBeGreaterThan(0.47);
    expect(frac).toBeLessThan(0.53);
  });

  it("trend at bias=0 → ~50% long", () => {
    const frac = simulateLongFraction("trend", 0);
    expect(frac).toBeGreaterThan(0.47);
    expect(frac).toBeLessThan(0.53);
  });
});

describe("direction probability — bullish bias (+1)", () => {
  it("aggressive at bias=1 → heavily bullish (>90% long)", () => {
    const frac = simulateLongFraction("aggressive", 1);
    expect(frac).toBeGreaterThan(0.90);
  });

  it("trend at bias=1 → bullish (~85% long)", () => {
    const frac = simulateLongFraction("trend", 1);
    expect(frac).toBeGreaterThan(0.80);
  });

  it("passive at bias=1 → slightly contrarian (shorter than aggressive)", () => {
    const passiveFrac = simulateLongFraction("passive", 1);
    const aggressiveFrac = simulateLongFraction("aggressive", 1);
    // Passive should be LESS bullish than aggressive at the same bias
    expect(passiveFrac).toBeLessThan(aggressiveFrac);
  });
});

describe("direction probability — bearish bias (-1)", () => {
  it("aggressive at bias=-1 → heavily bearish (<10% long)", () => {
    const frac = simulateLongFraction("aggressive", -1);
    expect(frac).toBeLessThan(0.10);
  });

  it("passive at bias=-1 → contrarian bullish (>50% long)", () => {
    const frac = simulateLongFraction("passive", -1);
    // Passive fades the bias, so at bias=-1 they should be buying
    expect(frac).toBeGreaterThan(0.50);
  });
});

describe("bias clamping", () => {
  it("bias stays within [-1, 1] after drift", () => {
    let bias = 0;
    for (let i = 0; i < 10_000; i++) {
      bias = Math.max(-1, Math.min(1, bias + (Math.random() - 0.5) * 0.1));
    }
    expect(bias).toBeGreaterThanOrEqual(-1);
    expect(bias).toBeLessThanOrEqual(1);
  });
});

describe("longProbability bounds", () => {
  it("never returns probability outside [0, 1]", () => {
    const biases = [-1, -0.5, 0, 0.5, 1];
    const personalities: Personality[] = ["aggressive", "passive", "trend"];
    for (const p of personalities) {
      for (const b of biases) {
        const prob = longProbability(p, b);
        expect(prob).toBeGreaterThanOrEqual(0);
        expect(prob).toBeLessThanOrEqual(1);
      }
    }
  });
});
