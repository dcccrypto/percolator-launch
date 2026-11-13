// @vitest-environment node
/**
 * GH#1405: Homepage featured markets must sanitize last_price before display.
 *
 * DfLoAzny (and similar admin-mode markets) have a raw DB last_price like
 * 10001100011 ($10B) — an unscaled authorityPriceE6 divided by 1e6 is still
 * huge if the initial oracle was set in micro-units on-chain. The featured
 * markets card must clamp to MAX_SANE_PRICE_USD ($10K) — null when corrupt.
 *
 * This test validates the sanitization logic extracted from the converted map
 * in app/page.tsx (GH#1405 fix).
 *
 * GH#1409: Phantom markets (vault <= MIN_VAULT_FOR_ACTIVE) must also be excluded
 * from the Active Markets / featured list, not just from stats counters.
 * The converted map must apply isActiveMarket() on phantomAwareData before mapping
 * to display rows — so DfLoAzny (OI zeroed by phantom guard, price null, vol 0)
 * is not included in the sorted top-5 list.
 *
 * GH#1412: Regression fix — phantom guard must also zero last_price (not just OI).
 * The homepage queries Supabase directly and gets raw last_price=10001100011 (~$10B).
 * isSaneMarketValue(10B) is TRUE (10B < 1e18), so isActiveMarket returned true based
 * on last_price alone even after OI was zeroed. Fix: phantom guard sets last_price:null
 * so isActiveMarket sees all three signal fields as null/zero → returns false.
 */

import { describe, it, expect } from "vitest";
import { isActiveMarket, isSaneMarketValue } from "@/lib/activeMarketFilter";

/**
 * Mirror of the sanitize logic in page.tsx `converted` map (GH#1405):
 *   last_price: (m.last_price != null && m.last_price > 0 && m.last_price <= MAX_SANE_PRICE_USD) ? m.last_price : null
 */
const MAX_SANE_PRICE_USD = 10_000; // must stay in sync with page.tsx
const MIN_VAULT_FOR_ACTIVE = 1_000_000; // must stay in sync with page.tsx

function sanitizeDisplayPrice(raw: number | null | undefined): number | null {
  if (raw == null) return null;
  if (raw > 0 && raw <= MAX_SANE_PRICE_USD) return raw;
  return null;
}

/** Mirror of phantom guard in page.tsx (applied to raw DB row before isActiveMarket). */
function applyPhantomGuard<T extends {
  total_accounts?: number | null;
  vault_balance?: number | null;
  total_open_interest?: number | null;
  open_interest_long?: number | null;
  open_interest_short?: number | null;
  last_price?: number | null;
}>(m: T): T {
  const accountsCount = m.total_accounts ?? 0;
  const vaultBal = m.vault_balance ?? 0;
  const isPhantom = accountsCount === 0 || vaultBal <= MIN_VAULT_FOR_ACTIVE;
  if (!isPhantom) return m;
  // GH#1412: zero last_price too — raw DB value (e.g. DfLoAzny: 10001100011 ≈$10B)
  // passes isSaneMarketValue(<1e18) and causes isActiveMarket to return true on price alone.
  return { ...m, total_open_interest: 0, open_interest_long: 0, open_interest_short: 0, last_price: null };
}

describe("homepage featured markets — last_price sanitization (GH#1405)", () => {
  it("passes through a normal price unchanged", () => {
    expect(sanitizeDisplayPrice(1.23)).toBe(1.23);
    expect(sanitizeDisplayPrice(9999.99)).toBe(9999.99);
    expect(sanitizeDisplayPrice(0.000001)).toBe(0.000001);
  });

  it("nulls a $10B DB price (DfLoAzny bug)", () => {
    // last_price = 10001100011 as returned by markets_with_stats view
    expect(sanitizeDisplayPrice(10001100011)).toBeNull();
  });

  it("nulls a price exactly at MAX_SANE_PRICE_USD boundary (exclusive)", () => {
    expect(sanitizeDisplayPrice(10_001)).toBeNull();
  });

  it("passes a price exactly at MAX_SANE_PRICE_USD", () => {
    expect(sanitizeDisplayPrice(10_000)).toBe(10_000);
  });

  it("nulls zero and negative prices", () => {
    expect(sanitizeDisplayPrice(0)).toBeNull();
    expect(sanitizeDisplayPrice(-1)).toBeNull();
  });

  it("nulls null/undefined", () => {
    expect(sanitizeDisplayPrice(null)).toBeNull();
    expect(sanitizeDisplayPrice(undefined)).toBeNull();
  });

  it("nulls other absurdly large values", () => {
    // $100M, $1T — all admin oracle corruption patterns
    expect(sanitizeDisplayPrice(100_000_000)).toBeNull();
    expect(sanitizeDisplayPrice(1_000_000_000_000)).toBeNull();
  });
});

describe("homepage Active Markets phantom guard (GH#1409)", () => {
  /** DfLoAzny DB row: vault=1M (exactly threshold), 2 accounts, corrupt last_price */
  const dfLoAznyRaw = {
    slab_address: "8eFFEFBY3HHbBgzxJJP5hyxdzMNMAumnYNhkWXErBM4c",
    symbol: "DfLoAzny",
    last_price: 10001100011, // unscaled admin oracle — corrupt
    volume_24h: 0,
    total_open_interest: 500_000_000, // stale phantom OI from on-chain
    open_interest_long: 250_000_000,
    open_interest_short: 250_000_000,
    total_accounts: 2,
    vault_balance: 1_000_000, // exactly MIN_VAULT_FOR_ACTIVE — treated as phantom
    decimals: 6,
  };

  it("phantom guard zeros OI for vault == MIN_VAULT_FOR_ACTIVE (strict <=)", () => {
    const guarded = applyPhantomGuard(dfLoAznyRaw);
    expect(guarded.total_open_interest).toBe(0);
    expect(guarded.open_interest_long).toBe(0);
    expect(guarded.open_interest_short).toBe(0);
  });

  it("isActiveMarket returns false for DfLoAzny after phantom guard (GH#1409 + GH#1412)", () => {
    // GH#1412 regression: before the fix, phantom guard only zeroed OI — not last_price.
    // DfLoAzny has raw last_price=10001100011 ($10B) from Supabase (homepage queries DB
    // directly, not /api/markets). isSaneMarketValue(10B) = true (10B < 1e18, isFinite)
    // so isActiveMarket returned true on last_price alone, even with OI=0.
    //
    // GH#1412 fix: phantom guard now also sets last_price:null.
    // After guard: last_price=null, volume=0, OI=0 → isActiveMarket returns false → EXCLUDED.
    const guarded = applyPhantomGuard(dfLoAznyRaw);
    expect(guarded.last_price).toBeNull(); // GH#1412: last_price must be zeroed by phantom guard
    expect(guarded.total_open_interest).toBe(0);
    expect(isActiveMarket(guarded)).toBe(false); // now correctly excluded
  });

  it("GH#1412 regression: raw last_price=10B passes isSaneMarketValue but must not make market active", () => {
    // Verify the root cause: 10B IS < 1e18, so without the fix, isActiveMarket returned true
    const rawLastPrice = 10001100011;
    // isSaneMarketValue(10B) = true (this is the root cause of the regression)
    expect(isSaneMarketValue(rawLastPrice)).toBe(true); // confirms the root cause
    // But after phantom guard zeroes last_price, isActiveMarket should return false:
    const phantomRowWithRawPrice = {
      last_price: rawLastPrice,
      volume_24h: 0,
      total_open_interest: 0,
      open_interest_long: 0,
      open_interest_short: 0,
      total_accounts: 2,
      vault_balance: 1_000_000, // phantom threshold
    };
    const guarded = applyPhantomGuard(phantomRowWithRawPrice);
    expect(guarded.last_price).toBeNull();
    expect(isActiveMarket(guarded)).toBe(false);
  });

  it("phantom guard does NOT affect market with vault > MIN_VAULT_FOR_ACTIVE", () => {
    const healthyMarket = {
      total_accounts: 5,
      vault_balance: 5_000_000, // > threshold
      total_open_interest: 10_000,
      open_interest_long: 5_000,
      open_interest_short: 5_000,
    };
    const guarded = applyPhantomGuard(healthyMarket);
    expect(guarded.total_open_interest).toBe(10_000); // unchanged
  });

  it("phantom guard treats accounts=0 as phantom regardless of vault", () => {
    const emptyAccounts = {
      total_accounts: 0,
      vault_balance: 9_999_999, // high vault but no accounts
      total_open_interest: 10_000,
      open_interest_long: 5_000,
      open_interest_short: 5_000,
    };
    const guarded = applyPhantomGuard(emptyAccounts);
    expect(guarded.total_open_interest).toBe(0);
  });
});
