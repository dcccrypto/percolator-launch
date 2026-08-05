/**
 * PoC + regression — the USD price formatters must reject values above the
 * on-chain price cap (MAX_PRICE_E6 = 1e12 / $1M), not the stale 1e15 (=$1B).
 *
 * formatUsd / formatUsdPriceE6 rejected only priceE6 > 1e15, so a dust/garbage
 * price (e.g. an uninitialized short liquidation price) between $1M and $1B
 * rendered as a real dollar figure instead of "—". These formatters are used only
 * for price-scale values (prices, spreads), so aligning to MAX_PRICE_E6 is safe.
 *
 * (This test asserts the FIXED behavior — it fails against the pre-fix 1e15
 * threshold, which is the proof.)
 */
import { describe, it, expect } from "vitest";
import { formatUsd, formatUsdPriceE6 } from "@/lib/format";
import { MAX_PRICE_E6 } from "@/lib/oraclePrice";

describe("USD price formatters honor MAX_PRICE_E6", () => {
  it("rejects prices above the on-chain max ($1M)", () => {
    const garbage = MAX_PRICE_E6 * 20n; // $20M in e6 — above $1M, below the stale $1B
    expect(formatUsd(garbage)).toBe("$—");
    expect(formatUsdPriceE6(garbage)).toBe("—");
  });

  it("still formats legitimate prices at/below the cap", () => {
    expect(formatUsd(150_000_000n)).toBe("$150.00");     // $150
    expect(formatUsdPriceE6(MAX_PRICE_E6)).toContain("$"); // $1M boundary still renders
    expect(formatUsd(0n)).toBe("$—");                     // unchanged: 0 → dash
  });
});
