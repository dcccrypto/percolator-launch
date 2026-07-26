/**
 * REDUCED SCHEMA (2026-07) — a row that omits the liveness columns must not be
 * classified as a zombie.
 *
 * The indexer reduction stopped mirroring vault_balance, c_tot, total_accounts and
 * total_open_interest into market_stats (the frontend reads vault/OI/insurance live
 * from chain). /api/markets stopped SELECTing them, so those keys are ABSENT on the
 * row rather than zero.
 *
 * Every branch of isZombieMarket read absence as death — `vault_balance ?? null`
 * collapses undefined to null, `total_accounts ?? 0` to 0 — so the null-vault branch
 * returned true for every market. Production served `{total:0, zombieCount:4}`: all
 * four live devnet markets hidden.
 *
 * Absent is not zero. These tests pin that distinction.
 */
import { describe, it, expect } from "vitest";
import { isZombieMarket } from "@/lib/activeMarketFilter";

describe("isZombieMarket — reduced schema (absent liveness columns)", () => {
  it("does not zombie a row that omits every liveness column", () => {
    // Exactly what SELECT_FIELDS returns today for a market with no trades yet:
    // symbol/name/price/volume only. No vault_balance, c_tot, or total_accounts.
    expect(
      isZombieMarket({
        last_price: null,
        volume_24h: 0,
      }),
    ).toBe(false);
  });

  it("does not zombie a reduced row even when price and volume are empty", () => {
    // A freshly registered market: nothing has traded, so the only mirrored stats
    // are empty. That is a new market, not a dead one.
    expect(isZombieMarket({ last_price: null, volume_24h: null })).toBe(false);
  });

  it("still zombies a full row that genuinely reports no life", () => {
    // The pre-reduction signal must keep working: vault present AND zero, with no
    // activity anywhere, is a real zombie.
    expect(
      isZombieMarket({
        vault_balance: 0,
        c_tot: 0,
        last_price: null,
        volume_24h: 0,
        total_open_interest: 0,
        total_accounts: 0,
      }),
    ).toBe(true);
  });

  it("still zombies a full row with null vault and no stats", () => {
    // GH#1427 case — vault_balance explicitly null (selected, but NULL in the DB)
    // alongside total_accounts=0 is supplied evidence, so classification proceeds.
    expect(
      isZombieMarket({
        vault_balance: null,
        c_tot: null,
        last_price: null,
        volume_24h: 0,
        total_open_interest: 0,
        total_accounts: 0,
      }),
    ).toBe(true);
  });

  it("treats a single supplied liveness column as enough to classify", () => {
    // total_accounts alone is evidence: present and zero, with nothing else alive.
    expect(
      isZombieMarket({
        last_price: null,
        volume_24h: 0,
        total_accounts: 0,
      }),
    ).toBe(true);
  });

  it("does not zombie a live market that supplies liveness columns", () => {
    expect(
      isZombieMarket({
        vault_balance: 5_000_000,
        c_tot: 1_000_000,
        last_price: 142.5,
        volume_24h: 25_000,
        total_open_interest: 900,
        total_accounts: 3,
      }),
    ).toBe(false);
  });
});
