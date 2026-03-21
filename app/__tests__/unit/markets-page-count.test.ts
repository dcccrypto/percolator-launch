/**
 * GH#1452: /markets page shows 105 markets but /api/stats says 69.
 *
 * Root cause: markets page used an inline custom phantom check
 * (accountsCount === 0 || vaultBal < MIN_VAULT_FOR_ACTIVE) AND lacked the
 * MAX_SANE_PRICE_FOR_ACTIVE ($1M) null-out that /api/stats applies before
 * isActiveMarket(). Markets with corrupt oracle prices (> $1M) and valid
 * vault/accounts passed isActiveMarket() via last_price, inflating the count.
 *
 * Fix: replace inline check with shared isPhantomOpenInterest() and apply
 * MAX_SANE_PRICE_FOR_ACTIVE null-out to match /api/stats behaviour exactly.
 */

import { describe, it, expect } from "vitest";
import { isPhantomOpenInterest, MIN_VAULT_FOR_OI } from "@/lib/phantom-oi";
import { isActiveMarket, isSaneMarketValue, isZombieMarket } from "@/lib/activeMarketFilter";

const MAX_SANE_PRICE_FOR_ACTIVE = 1_000_000; // mirrors /api/stats

/**
 * Simulates the corrected markets page filtering logic for a single market row.
 */
function filterMarket(row: {
  total_accounts: number;
  vault_balance: number | null;
  last_price: number | null;
  volume_24h: number | null;
  total_open_interest: number | null;
  open_interest_long?: number | null;
  open_interest_short?: number | null;
  c_tot?: number | null;
}): boolean {
  const accountsCount = row.total_accounts ?? 0;
  const vaultBal = row.vault_balance ?? 0;
  const isPhantom = isPhantomOpenInterest(accountsCount, vaultBal);

  // GH#1531: Use shared isZombieMarket() — single source of truth
  const isZombie = isZombieMarket(row);

  if (isZombie) {
    return isActiveMarket({
      last_price: null,
      volume_24h: null,
      total_open_interest: 0,
      open_interest_long: 0,
      open_interest_short: 0,
    });
  }

  const rawPrice = row.last_price;
  const sanitizedPrice =
    rawPrice != null && rawPrice > 0 && rawPrice <= MAX_SANE_PRICE_FOR_ACTIVE
      ? rawPrice
      : null;

  if (isPhantom) {
    return isActiveMarket({
      ...row,
      last_price: sanitizedPrice,
      total_open_interest: 0,
      open_interest_long: 0,
      open_interest_short: 0,
    });
  }

  return isActiveMarket({ ...row, last_price: sanitizedPrice });
}

describe("GH#1452: /markets page active market filtering aligns with /api/stats", () => {
  it("real market (vault=1M, accounts>0, sane price) is counted as active", () => {
    expect(
      filterMarket({
        total_accounts: 5,
        vault_balance: 1_000_000,
        last_price: 1500,
        volume_24h: 50000,
        total_open_interest: 2_000_000,
      }),
    ).toBe(true);
  });

  it("phantom market (accounts=0) with stale OI is NOT counted (OI zeroed)", () => {
    // accounts=0 → phantom → OI zeroed → only last_price or volume can make it active
    expect(
      filterMarket({
        total_accounts: 0,
        vault_balance: 5_000_000,
        last_price: null,
        volume_24h: null,
        total_open_interest: 1_000_000_000_000, // "1T" sentinel OI
      }),
    ).toBe(false);
  });

  it("phantom market (vault<1M) with stale OI is NOT counted (OI zeroed)", () => {
    expect(
      filterMarket({
        total_accounts: 3,
        vault_balance: 999_999,
        last_price: null,
        volume_24h: null,
        total_open_interest: 1_000_000_000_000,
      }),
    ).toBe(false);
  });

  it("corrupt-price market (last_price > $1M, no other signals) is NOT counted", () => {
    // GH#1452: markets with a corrupt oracle price (e.g. $7.9T) but no real
    // volume or OI passed isActiveMarket() via last_price in the old markets page.
    // /api/stats nulls prices > $1M BEFORE isActiveMarket(), so these markets don't
    // count there. Fix: apply the same MAX_SANE_PRICE_FOR_ACTIVE guard here.
    expect(
      filterMarket({
        total_accounts: 5,
        vault_balance: 1_000_000,
        last_price: 7_900_000_000_000, // $7.9T corrupt oracle price
        volume_24h: null,
        total_open_interest: null, // no real OI
        open_interest_long: null,
        open_interest_short: null,
      }),
    ).toBe(false);
  });

  it("corrupt-price market with valid OI is still counted (OI is the active signal)", () => {
    // If a market has corrupt price BUT real OI, it counts in /api/stats via OI too.
    // The fix does NOT change this — both old and new code would count it.
    // This test documents the expected behaviour so we don't accidentally over-filter.
    expect(
      filterMarket({
        total_accounts: 5,
        vault_balance: 1_000_000,
        last_price: 7_900_000_000_000, // corrupt price (will be nulled)
        volume_24h: null,
        total_open_interest: 2_000_000, // real OI — this is the active signal
        open_interest_long: 1_000_000,
        open_interest_short: 1_000_000,
      }),
    ).toBe(true);
  });

  it("zombie market (vault=0) is not active even with stale last_price", () => {
    expect(
      filterMarket({
        total_accounts: 0,
        vault_balance: 0,
        last_price: 99, // stale but drained
        volume_24h: null,
        total_open_interest: 0,
      }),
    ).toBe(false);
  });

  it("phantom market with valid last_price below $1M IS counted (price is real)", () => {
    // accounts=0 → phantom → OI zeroed, but price is sane → market is active
    expect(
      filterMarket({
        total_accounts: 0,
        vault_balance: 5_000_000,
        last_price: 1234,
        volume_24h: null,
        total_open_interest: 999_999_999, // will be zeroed (phantom)
      }),
    ).toBe(true);
  });

  it("non-phantom market with valid price exactly at $1M boundary is counted", () => {
    // price === MAX_SANE_PRICE_FOR_ACTIVE is allowed (not corrupt)
    expect(
      filterMarket({
        total_accounts: 2,
        vault_balance: 2_000_000,
        last_price: 1_000_000,
        volume_24h: null,
        total_open_interest: null,
      }),
    ).toBe(true);
  });

  it("non-phantom market with price just above $1M is NOT counted (corrupt)", () => {
    expect(
      filterMarket({
        total_accounts: 2,
        vault_balance: 2_000_000,
        last_price: 1_000_001,
        volume_24h: null,
        total_open_interest: null,
      }),
    ).toBe(false);
  });

  it("GH#1531: c_tot>0 but vault=0, no price, no accounts → zombie (not shown)", () => {
    // This was the root cause of GH#1531: the inline zombie check had
    // `cTot > 0 ? false : ...` which exempted these dead markets.
    // The shared isZombieMarket() requires hasActivity (price or accounts) too.
    expect(
      filterMarket({
        total_accounts: 0,
        vault_balance: 0,
        last_price: null,
        volume_24h: null,
        total_open_interest: 500_000,
        c_tot: 100_000_000_000, // legacy collateral but no active keeper
      } as any),
    ).toBe(false);
  });

  it("GH#1531: c_tot>0, vault=0, but HAS price → not zombie (keeper active)", () => {
    expect(
      filterMarket({
        total_accounts: 0,
        vault_balance: 0,
        last_price: 42.5,
        volume_24h: null,
        total_open_interest: 0,
        c_tot: 100_000_000_000,
      } as any),
    ).toBe(true);
  });

  it("isPhantomOpenInterest is used — vault=1M+accounts>0 is NOT phantom", () => {
    // This checks that we use strict < (not <=) consistent with isPhantomOpenInterest
    expect(isPhantomOpenInterest(1, MIN_VAULT_FOR_OI)).toBe(false);
    expect(isPhantomOpenInterest(1, MIN_VAULT_FOR_OI - 1)).toBe(true);
  });
});
