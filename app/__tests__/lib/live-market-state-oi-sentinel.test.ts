/**
 * PoC + regression — live-market-state must sanitize on-chain OI/insurance before
 * converting to Number.
 *
 * markPrice is guarded (< MAX_SANE_PRICE_E6), but oiLongQ/oiShortQ/insurance were
 * `Number(rawBigint)` with no guard, so a sentinel/uninitialized slab (u64::MAX)
 * yields an astronomically large value that propagates into total_open_interest_usd.
 * sanitizeOnChainValue zeros sentinels and negatives — the same treatment other
 * on-chain reads already get.
 */
import { describe, it, expect } from "vitest";
import { sanitizeOnChainValue, isSentinelValue } from "@/lib/health";

const U64_MAX = 2n ** 64n - 1n;

describe("live-market-state OI/insurance sentinel guard", () => {
  it("raw conversion of a sentinel yields an astronomical number (the bug)", () => {
    expect(isSentinelValue(U64_MAX)).toBe(true);
    expect(Number(U64_MAX)).toBeGreaterThan(1e19); // absurd OI/insurance
  });

  it("sanitizeOnChainValue zeros sentinels and negatives (the fix)", () => {
    expect(Number(sanitizeOnChainValue(U64_MAX))).toBe(0);
    expect(sanitizeOnChainValue(-5n)).toBe(0n);
    expect(sanitizeOnChainValue(0n)).toBe(0n);
  });

  it("legitimate values pass through unchanged", () => {
    expect(sanitizeOnChainValue(1_000_000n)).toBe(1_000_000n);
    expect(sanitizeOnChainValue(42n)).toBe(42n);
  });
});
