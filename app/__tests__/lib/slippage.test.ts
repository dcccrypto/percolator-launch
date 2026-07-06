import { describe, it, expect } from "vitest";
import {
  computeLimitPriceE6,
  DEFAULT_SLIPPAGE_BPS,
  DEFAULT_SHORT_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
  SlippageError,
} from "@/lib/slippage";

const MARK = 200_000_000n; // $200.000000 in e6

describe("computeLimitPriceE6 — long side (size > 0)", () => {
  it("default 500 bps → mark * 1.05 (ceil-rounded)", () => {
    // 200_000_000 * 10_500 = 2_100_000_000_000 / 10_000 = 210_000_000 (exact)
    expect(computeLimitPriceE6({ markE6: MARK, size: 1n })).toBe(210_000_000n);
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
  it("default (DEFAULT_SHORT_SLIPPAGE_BPS = 500) bps → mark * 0.95", () => {
    // Short/sell-side default is wider than the long/buy-side default — see
    // DEFAULT_SHORT_SLIPPAGE_BPS doc comment (devnet-verified matcher spread
    // asymmetry; symmetric 100bps reliably failed on-chain for shorts).
    // 200_000_000 * 9_500 = 1_900_000_000_000 / 10_000 = 190_000_000
    expect(computeLimitPriceE6({ markE6: MARK, size: -1n })).toBe(190_000_000n);
  });

  it("explicit 100 bps override → mark * 0.99 (old symmetric behavior still available)", () => {
    expect(
      computeLimitPriceE6({ markE6: MARK, size: -1n, slippageBps: 100n }),
    ).toBe(198_000_000n);
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
  it("DEFAULT_SLIPPAGE_BPS and DEFAULT_SHORT_SLIPPAGE_BPS both clear the devnet-verified failure threshold (>200bps) with margin", () => {
    // Both sides were devnet-verified (2026-07-01) to fail on-chain at the old
    // symmetric 100bps once the matcher's inventory skew moves against the
    // trade direction (long on SLABS.JUP, short on SLABS.TRUMP) — see doc
    // comments in lib/slippage.ts. 500bps is used for both, for margin.
    expect(DEFAULT_SLIPPAGE_BPS).toBeGreaterThan(200n);
    expect(DEFAULT_SHORT_SLIPPAGE_BPS).toBeGreaterThan(200n);
    expect(DEFAULT_SLIPPAGE_BPS).toBe(DEFAULT_SHORT_SLIPPAGE_BPS);
  });

  it("never returns 0n (the on-chain disable sentinel) for a valid mark", () => {
    expect(computeLimitPriceE6({ markE6: 1n, size: 1n })).not.toBe(0n);
    expect(computeLimitPriceE6({ markE6: 1n, size: -1n })).not.toBe(0n);
  });
});
