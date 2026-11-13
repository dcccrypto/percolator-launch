// @vitest-environment node
/**
 * GH#1610: 29 admin-oracle markets with real vault + OI atoms > 0 but oracle
 * price = null (keeper never cranked) returned total_open_interest_usd: null.
 *
 * Root cause: rawToUsd returns null when price is null. computeDisplayOiUsd
 * propagated that null directly. The fix: when atoms > 0 but USD is null,
 * return 0 rather than null so sort=oi ranks these consistently.
 *
 * These markets are NOT phantom (vault=1M, real accounts) — the OI atoms are
 * genuine but simply cannot be priced yet.
 */
import { describe, it, expect } from "vitest";
import { computeDisplayOiUsd } from "@/lib/oi-display";

describe("GH#1610 — admin-oracle OI USD null→0 when atoms > 0, price unavailable", () => {
  // ── Core fix ──────────────────────────────────────────────────────────────

  it("returns 0 when atoms > 0 and USD is null (oracle price unavailable)", () => {
    // vault=1M, oracle_mode=admin, total_open_interest=2_000_000_000_000 atoms
    // last_price=null (keeper never cranked) → rawToUsd returns null
    expect(computeDisplayOiUsd(null, false, 2_000_000_000_000)).toBe(0);
  });

  it("returns 0 for small atom amounts with no price", () => {
    // e.g. total_open_interest=9_000_000 atoms, last_price=null
    expect(computeDisplayOiUsd(null, false, 9_000_000)).toBe(0);
  });

  it("returns 0 for single atom with no price", () => {
    expect(computeDisplayOiUsd(null, false, 1)).toBe(0);
  });

  // ── Null propagation preserved when atoms are 0 or absent ─────────────────

  it("returns null when atoms=0 and USD is null (no OI at all, no price)", () => {
    // True zero OI with no price → there are no positions, null is acceptable
    // BUT wait: rawToUsd short-circuits 0 → returns 0 before price check.
    // This case (atoms=0, usd=null) should not occur in practice, but guard it.
    expect(computeDisplayOiUsd(null, false, 0)).toBe(null);
  });

  it("returns null when no atoms provided and USD is null (pre-GH1610 compat)", () => {
    // Callers without rawOiAtoms behave identically to before: null propagates.
    expect(computeDisplayOiUsd(null, false)).toBe(null);
    expect(computeDisplayOiUsd(null, false, undefined)).toBe(null);
  });

  it("returns null when atoms is null and USD is null", () => {
    expect(computeDisplayOiUsd(null, false, null)).toBe(null);
  });

  // ── Existing GH#1606 phantom behaviour preserved ──────────────────────────

  it("returns 0 for phantom markets regardless of atoms or USD (GH#1606)", () => {
    expect(computeDisplayOiUsd(null, true, 2_000_000_000_000)).toBe(0);
    expect(computeDisplayOiUsd(null, true, 0)).toBe(0);
    expect(computeDisplayOiUsd(42000.5, true, 100)).toBe(0);
  });

  // ── Existing zero-USD behaviour preserved (GH#1599) ───────────────────────

  it("returns 0 when USD is exactly 0 regardless of atoms (GH#1599)", () => {
    expect(computeDisplayOiUsd(0, false, 0)).toBe(0);
    expect(computeDisplayOiUsd(0, false, 1000)).toBe(0);
    expect(computeDisplayOiUsd(0, false, undefined)).toBe(0);
  });

  // ── Normal priced path preserved ─────────────────────────────────────────

  it("returns USD value when price is available and atoms > 0", () => {
    // oracle_mode=admin, keeper posted price → rawToUsd returns positive USD
    expect(computeDisplayOiUsd(1234.56, false, 2_000_000_000_000)).toBe(1234.56);
  });

  it("returns USD value when price is available and no atoms provided", () => {
    expect(computeDisplayOiUsd(5000, false)).toBe(5000);
  });
});
