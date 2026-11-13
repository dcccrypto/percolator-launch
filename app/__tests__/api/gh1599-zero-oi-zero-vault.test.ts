// @vitest-environment node
/**
 * GH#1599: Markets with zero OI AND zero vault should return
 * total_open_interest_usd: 0 (not null).
 *
 * The phantom OI guard (isPhantomOpenInterest) suppresses *positive* OI when
 * vault < MIN_VAULT_FOR_OI, but zero OI is always valid — it means "no positions".
 *
 * This test exercises the shared computeDisplayOiUsd helper used by the markets
 * route so that route regressions are caught via a single source of truth.
 */
import { describe, it, expect } from "vitest";
import { computeDisplayOiUsd } from "@/lib/oi-display";

describe("GH#1599 — zero OI with zero vault", () => {
  it("returns 0 for zero-OI market with vault=0 (previously null)", () => {
    // isPhantom=true because vault=0, but OI USD is genuinely 0
    expect(computeDisplayOiUsd(0, true)).toBe(0);
  });

  it("returns 0 for zero-OI market with vault=1M (non-phantom)", () => {
    expect(computeDisplayOiUsd(0, false)).toBe(0);
  });

  it("returns 0 for positive OI on phantom market (GH#1606: atoms zeroed → USD must be 0)", () => {
    // GH#1606: phantom markets zero all OI atom fields in the response,
    // so USD must also be 0 for consistency (not null).
    expect(computeDisplayOiUsd(1234.56, true)).toBe(0);
  });

  it("returns the value for positive OI on non-phantom market", () => {
    expect(computeDisplayOiUsd(1234.56, false)).toBe(1234.56);
  });

  it("returns null when OI USD is null on non-phantom market (no price available)", () => {
    expect(computeDisplayOiUsd(null, false)).toBeNull();
  });

  it("returns 0 when OI USD is null on phantom market (GH#1606: atoms zeroed)", () => {
    // Phantom markets zero all OI atom fields, so USD must also be 0
    expect(computeDisplayOiUsd(null, true)).toBe(0);
  });
});
