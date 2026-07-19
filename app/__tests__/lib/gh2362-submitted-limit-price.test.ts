/**
 * GH#2362 — the trade confirmation modal could display one worst-fill bound
 * while the submitted transaction used another.
 *
 * TradeForm computes `worstFillPriceE6` when the modal opens and shows it to
 * the user as the binding slippage limit, but the confirm callback forwarded
 * only the position size. `trade()` was therefore called without an explicit
 * `limitPriceE6`, so `useTrade` re-derived one from the live mark at submit
 * time — any price move between opening the modal and pressing Confirm changed
 * the protection bound the user had approved.
 *
 * The zero case is the trap. On-chain, `limit_price_e6 == 0` is a "no limit"
 * sentinel that skips the slippage check entirely, and the modal's snapshot is
 * `0n` whenever its computation failed. Blindly forwarding the snapshot would
 * therefore convert a mismatched bound into NO bound.
 */

import { describe, it, expect } from "vitest";
import { resolveSubmittedLimitPriceE6 } from "@/lib/submitted-limit-price";

describe("GH#2362 submitted worst-fill bound", () => {
  it("forwards the reviewed bound so the tx matches what the user approved", () => {
    // The core fix: what was displayed is what gets submitted.
    expect(resolveSubmittedLimitPriceE6(1_234_567n)).toBe(1_234_567n);
  });

  it("forwards the reviewed bound unchanged even if the market has since moved", () => {
    // Staleness is the POINT — the user approved this number, and the tx should
    // fail rather than execute at a bound they never saw.
    const reviewed = 98_765_432n;
    expect(resolveSubmittedLimitPriceE6(reviewed)).toBe(reviewed);
  });

  it("does NOT forward a 0n snapshot — that would disable slippage protection", () => {
    // 0n means the modal's computation failed, not "no limit wanted".
    // Returning undefined makes useTrade derive a fresh non-zero limit.
    expect(resolveSubmittedLimitPriceE6(0n)).toBeUndefined();
  });

  it("does not forward a negative bound", () => {
    expect(resolveSubmittedLimitPriceE6(-1n)).toBeUndefined();
    expect(resolveSubmittedLimitPriceE6(-1_000_000n)).toBeUndefined();
  });

  it("returns undefined when there is no snapshot at all", () => {
    // Non-confirm code paths (mock mode, direct calls) keep the old behaviour.
    expect(resolveSubmittedLimitPriceE6(undefined)).toBeUndefined();
  });

  it("preserves bigint precision for large bounds", () => {
    // Must not round-trip through Number.
    const huge = 9_007_199_254_740_993n; // Number.MAX_SAFE_INTEGER + 2
    expect(resolveSubmittedLimitPriceE6(huge)).toBe(huge);
  });

  it("treats the smallest positive bound as forwardable", () => {
    expect(resolveSubmittedLimitPriceE6(1n)).toBe(1n);
  });
});
