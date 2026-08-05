/**
 * PoC + regression — keeper-cosign must bound the caller-supplied initial mark.
 *
 * /api/playground/keeper-cosign builds a ConfigureAuthMark instruction with
 * initialMarkE6 = BigInt(initialPriceE6) from the request body, validated only
 * as `> 0n`. There is no upper bound, so a creator can seed their own market's
 * initial mark with an absurd value (contrast MAX_PRICE_E6 = 1e12 in
 * lib/oraclePrice, which every other price path is clamped to).
 *
 * This reproduces the current gate vs the bounded gate using the real
 * MAX_PRICE_E6 constant.
 */
import { describe, it, expect } from "vitest";
import { MAX_PRICE_E6 } from "@/lib/oraclePrice";

// Current keeper-cosign gate (route.ts:130-131): only rejects non-positive.
const currentGateAccepts = (v: bigint): boolean => v > 0n;
// Fixed gate: also reject anything above the protocol max.
const boundedGateAccepts = (v: bigint): boolean => v > 0n && v <= MAX_PRICE_E6;

describe("PoC: keeper-cosign initial mark must be upper-bounded", () => {
  it("the current gate accepts an absurd mark; the bounded gate rejects it", () => {
    const absurd = 1_000_000_000_000_000_000_000n; // 1e21, far above $1M (1e12)
    expect(currentGateAccepts(absurd)).toBe(true);   // bug: accepted today
    expect(boundedGateAccepts(absurd)).toBe(false);  // fix: rejected
  });

  it("legitimate prices are accepted by the bounded gate", () => {
    expect(boundedGateAccepts(150_000_000n)).toBe(true); // $150 in E6
    expect(boundedGateAccepts(1n)).toBe(true);           // smallest positive
    expect(boundedGateAccepts(MAX_PRICE_E6)).toBe(true); // boundary ($1M)
  });

  it("non-positive is still rejected", () => {
    expect(boundedGateAccepts(0n)).toBe(false);
    expect(boundedGateAccepts(-5n)).toBe(false);
  });
});
