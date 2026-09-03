import { describe, it, expect } from "vitest";
import { bigintToFloat, bigintRatio } from "@/lib/formatters";
import { toE6 } from "@/lib/format";

/**
 * GH#2324 — `Number(someBigint)` loses precision above `Number.MAX_SAFE_INTEGER`
 * and says nothing about it: it returns a plausible, wrong number.
 *
 * GH#2246 — the `price -> E6` conversion was inlined rather than shared, so the
 * one place that could grow a guard was five places that could not.
 *
 * The two are the same underlying problem — arithmetic done inline at the render
 * boundary instead of behind a helper that can be given a rule.
 */

describe("bigintToFloat refuses silently-wrong conversions (GH#2324)", () => {
  const MAX = BigInt(Number.MAX_SAFE_INTEGER);

  it("converts ordinary amounts", () => {
    expect(bigintToFloat(1_500_000n, 6)).toBe(1.5);
    expect(bigintToFloat(0n, 6)).toBe(0);
    expect(bigintToFloat(-2_000_000n, 6)).toBe(-2);
  });

  it("returns null above MAX_SAFE_INTEGER instead of a wrong number", () => {
    // The failure this exists for: Number() on this returns a real-looking float.
    const tooBig = MAX + 1n;
    expect(Number.isFinite(Number(tooBig))).toBe(true); // the trap
    expect(bigintToFloat(tooBig, 6)).toBeNull(); // the guard
  });

  it("guards the NEGATIVE side too", () => {
    // A large loss is as easy to hit as a large gain, and `raw < 0` would slip
    // past a naive `raw > MAX` check.
    expect(bigintToFloat(-(MAX + 1n), 6)).toBeNull();
  });

  it("checks the RAW magnitude, not the scaled one", () => {
    // Dividing first would hide the loss: (MAX+1)/1e6 is small and finite, but
    // the precision is already gone by then.
    const tooBig = MAX + 1n;
    expect(bigintToFloat(tooBig, 18)).toBeNull();
  });

  it("accepts exactly MAX_SAFE_INTEGER — the boundary is inclusive", () => {
    expect(bigintToFloat(MAX, 0)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("bigintRatio keeps large-over-large exact (GH#2324)", () => {
  it("computes a small quotient from two huge operands", () => {
    // Both sides far exceed MAX_SAFE_INTEGER; the quotient is 0.5. Converting
    // each side to a float first would lose the precision before dividing.
    const huge = BigInt("100000000000000000000000");
    expect(bigintRatio(huge, huge * 2n)).toBeCloseTo(0.5, 9);
  });

  it("returns null on a zero denominator rather than Infinity or NaN", () => {
    expect(bigintRatio(1n, 0n)).toBeNull();
  });

  it("handles an ordinary ratio", () => {
    expect(bigintRatio(1n, 4n)).toBeCloseTo(0.25, 9);
  });
});

describe("toE6 is the one place price->E6 happens (GH#2246)", () => {
  it("converts a price to E6 base units", () => {
    expect(toE6(1)).toBe(1_000_000n);
    expect(toE6(0.5)).toBe(500_000n);
    expect(toE6(123.456789)).toBe(123_456_789n);
  });

  it("rounds rather than truncating", () => {
    // 1.0000005 * 1e6 = 1000000.5 → rounds to 1000001, not 1000000.
    expect(toE6(1.0000005)).toBe(1_000_001n);
  });

  it("throws on a non-finite input rather than producing garbage", () => {
    // BigInt(Math.round(NaN)) throws RangeError — the inline form did this too,
    // but from five different places with five different stack traces.
    expect(() => toE6(NaN)).toThrow();
    expect(() => toE6(Infinity)).toThrow();
  });
});
