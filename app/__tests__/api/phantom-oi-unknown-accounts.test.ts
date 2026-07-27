/**
 * REDUCED SCHEMA (2026-07) — an UNKNOWN account count must not suppress OI.
 *
 * total_accounts is no longer mirrored into market_stats, so callers reading it
 * from the DB get null/undefined. It was being coerced to 0, which asserts "this
 * market definitely has no accounts" and made isPhantomOpenInterest() true for
 * EVERY market — zeroing OI across the board. /api/markets reported
 * total_open_interest: 0 for markets where /api/open-interest, reading the same
 * slab, reported 588,928,150,764.
 *
 * Unknown is not zero. Both conditions of the guard protect one hazard — a stale
 * slab carrying OI counters with nothing real behind it — and the vault
 * condition catches that on its own now that vault_balance is read live from
 * chain. These tests pin that an unknown count abstains while a KNOWN zero
 * still suppresses.
 */
import { describe, it, expect } from "vitest";
import { isPhantomOpenInterest, MIN_VAULT_FOR_OI } from "@/lib/phantom-oi";

const HEALTHY_VAULT = 2_099_905_551; // a real live-market vault
const DUST_VAULT = MIN_VAULT_FOR_OI - 1;

describe("isPhantomOpenInterest — unknown account count", () => {
  it("does not suppress OI when the account count is null and the vault is healthy", () => {
    expect(isPhantomOpenInterest(null, HEALTHY_VAULT)).toBe(false);
  });

  it("does not suppress OI when the account count is undefined and the vault is healthy", () => {
    expect(isPhantomOpenInterest(undefined, HEALTHY_VAULT)).toBe(false);
  });

  it("STILL suppresses when the account count is a known zero", () => {
    // The original signal is intact: a market that genuinely reports no accounts
    // is phantom regardless of vault.
    expect(isPhantomOpenInterest(0, HEALTHY_VAULT)).toBe(true);
  });

  it("STILL suppresses on a dust vault even when accounts are unknown", () => {
    // This is the condition that carries the guard now — it must not have been
    // weakened by the null handling above.
    expect(isPhantomOpenInterest(null, DUST_VAULT)).toBe(true);
    expect(isPhantomOpenInterest(undefined, 0)).toBe(true);
  });

  it("STILL suppresses on a dust vault with known accounts", () => {
    expect(isPhantomOpenInterest(5, DUST_VAULT)).toBe(true);
  });

  it("does not suppress a genuinely live market", () => {
    expect(isPhantomOpenInterest(5, HEALTHY_VAULT)).toBe(false);
  });

  it("treats the threshold as strict <", () => {
    // Exactly at the creation-deposit boundary is NOT dust.
    expect(isPhantomOpenInterest(null, MIN_VAULT_FOR_OI)).toBe(false);
    expect(isPhantomOpenInterest(null, MIN_VAULT_FOR_OI - 1)).toBe(true);
  });
});
