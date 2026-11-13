// @vitest-environment node
/**
 * GH#1606: Phantom markets with vault=0, valid price, and stale positive OI
 * must return total_open_interest_usd: 0 (not null).
 *
 * Root cause: The phantom OI guard zeroes raw atom fields (total_open_interest,
 * open_interest_long, open_interest_short) but computeDisplayOiUsd only returned 0
 * when the *computed* USD value was exactly 0. For stale positive OI, the USD
 * conversion produced a positive number, and the phantom guard returned null —
 * creating an inconsistency: atoms=0 but USD=null.
 *
 * Fix: phantom markets always return 0 for OI USD (matching zeroed atoms).
 */
import { describe, it, expect } from "vitest";
import { computeDisplayOiUsd } from "@/lib/oi-display";

describe("GH#1606 — phantom OI USD consistency", () => {
  it("returns 0 when phantom market has stale positive OI USD", () => {
    // Simulates: vault=0, stale OI atoms → rawToUsd returns positive USD
    // Phantom guard should return 0 (atoms are zeroed in output)
    expect(computeDisplayOiUsd(42000.5, true)).toBe(0);
  });

  it("returns 0 when phantom market has small stale OI USD", () => {
    expect(computeDisplayOiUsd(0.001, true)).toBe(0);
  });

  it("returns 0 when phantom market has zero OI USD (GH#1599 compat)", () => {
    expect(computeDisplayOiUsd(0, true)).toBe(0);
  });

  it("returns 0 when OI USD is null on phantom market (atoms zeroed regardless)", () => {
    // Even when price is unavailable (null USD), phantom markets zero all OI atoms,
    // so the USD display should also be 0 for consistency.
    expect(computeDisplayOiUsd(null, true)).toBe(0);
  });

  it("preserves positive OI USD on non-phantom markets", () => {
    expect(computeDisplayOiUsd(42000.5, false)).toBe(42000.5);
  });
});
