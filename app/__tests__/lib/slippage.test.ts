import { describe, it, expect } from "vitest";
import {
  computeLimitPriceE6,
  DEFAULT_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
  SlippageError,
} from "@/lib/slippage";

const MARK = 200_000_000n; // $200.000000 in e6

describe("computeLimitPriceE6 — long side (size > 0)", () => {
  it("default 100 bps → mark * 1.01 (ceil-rounded)", () => {
    // 200_000_000 * 10_100 = 2_020_000_000_000 / 10_000 = 202_000_000 (exact)
    expect(computeLimitPriceE6({ markE6: MARK, size: 1n })).toBe(202_000_000n);
  });

  it("explicit 250 bps tolerance", () => {
    expect(
      computeLimitPriceE6({ markE6: MARK, size: 1n, slippageBps: 250n }),
    ).toBe(205_000_000n);
  });

  it("ceil-rounds so a 1-unit truncation never tightens the limit below the floor", () => {
    // 99 * 10_100 = 999_900 → /10_000 = 99 (truncated) — but ceil pushes to 100
    const limit = computeLimitPriceE6({ markE6: 99n, size: 1n, slippageBps: 100n });
    expect(limit).toBe(100n);
    expect(limit).toBeGreaterThanOrEqual(99n);
  });

  it("zero-bps tolerance equals mark (exact)", () => {
    expect(
      computeLimitPriceE6({ markE6: MARK, size: 1n, slippageBps: 0n }),
    ).toBe(MARK);
  });
});

describe("computeLimitPriceE6 — short side (size < 0)", () => {
  it("default 100 bps → mark * 0.99", () => {
    // 200_000_000 * 9_900 = 1_980_000_000_000 / 10_000 = 198_000_000
    expect(computeLimitPriceE6({ markE6: MARK, size: -1n })).toBe(198_000_000n);
  });

  it("limit is always ≤ mark for shorts", () => {
    const limit = computeLimitPriceE6({ markE6: MARK, size: -1n, slippageBps: 50n });
    expect(limit).toBeLessThanOrEqual(MARK);
  });

  it("floor-rounds (truncation is fine on the short side — widens tolerance)", () => {
    // 99 * 9_900 = 980_100 / 10_000 = 98 (truncated)
    expect(
      computeLimitPriceE6({ markE6: 99n, size: -1n, slippageBps: 100n }),
    ).toBe(98n);
  });
});

describe("computeLimitPriceE6 — close-position direction (sign-derived)", () => {
  it("close-long uses short-side limit (size < 0 → limit ≤ mark)", () => {
    // A long position is closed with a negative size.
    const limit = computeLimitPriceE6({ markE6: MARK, size: -500n });
    expect(limit).toBeLessThanOrEqual(MARK);
  });

  it("close-short uses long-side limit (size > 0 → limit ≥ mark)", () => {
    const limit = computeLimitPriceE6({ markE6: MARK, size: 500n });
    expect(limit).toBeGreaterThanOrEqual(MARK);
  });
});

describe("computeLimitPriceE6 — error cases", () => {
  it("throws SlippageError on markE6 = 0n", () => {
    expect(() => computeLimitPriceE6({ markE6: 0n, size: 1n })).toThrow(
      SlippageError,
    );
    expect(() => computeLimitPriceE6({ markE6: 0n, size: 1n })).toThrow(
      /mark price unavailable/i,
    );
  });

  it("throws on negative markE6 (defensive)", () => {
    expect(() => computeLimitPriceE6({ markE6: -1n, size: 1n })).toThrow(
      SlippageError,
    );
  });

  it("throws on size = 0n", () => {
    expect(() => computeLimitPriceE6({ markE6: MARK, size: 0n })).toThrow(
      SlippageError,
    );
  });

  it("throws on slippageBps above MAX_SLIPPAGE_BPS", () => {
    expect(() =>
      computeLimitPriceE6({
        markE6: MARK,
        size: 1n,
        slippageBps: MAX_SLIPPAGE_BPS + 1n,
      }),
    ).toThrow(SlippageError);
  });

  it("throws on negative slippageBps", () => {
    expect(() =>
      computeLimitPriceE6({ markE6: MARK, size: 1n, slippageBps: -1n }),
    ).toThrow(SlippageError);
  });
});

describe("computeLimitPriceE6 — invariants", () => {
  it("DEFAULT_SLIPPAGE_BPS matches the on-chain default band (100 bps)", () => {
    expect(DEFAULT_SLIPPAGE_BPS).toBe(100n);
  });

  it("never returns 0n (the on-chain disable sentinel) for a valid mark", () => {
    expect(computeLimitPriceE6({ markE6: 1n, size: 1n })).not.toBe(0n);
    expect(computeLimitPriceE6({ markE6: 1n, size: -1n })).not.toBe(0n);
  });
});
