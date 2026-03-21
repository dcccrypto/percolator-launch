/**
 * GH#1531: /markets page counter shows 115 (activeTotal) but list renders 168.
 *
 * Root cause: the markets page gated the displayed list on isActiveMarket()
 * (price/volume/OI present), matching /api/markets activeTotal=115.
 * But /api/markets total=168 (all non-zombie markets). Users saw "115 markets"
 * in the counter while the API advertised 168, causing confusion.
 *
 * Fix (GH#1531): the list and counter now show ALL non-zombie markets (168).
 * Only zombie markets (vault=0 drained, or vault=null+no stats+no accounts)
 * are excluded. Markets with no price/volume/OI show "—" in those columns.
 * On-chain-only markets (no Supabase row) are still excluded to match /api/markets.
 *
 * Previous test file (GH#1452) validated the old isActiveMarket() gate;
 * those behaviours are now tested in the API layer (stats-total-markets-alignment.test.ts).
 */

import { describe, it, expect } from "vitest";
import { isSaneMarketValue } from "@/lib/activeMarketFilter";

/** Mirrors the new markets page filter (GH#1531): show all non-zombie Supabase markets. */
function isShownInMarketsList(row: {
  vault_balance?: number | null;
  c_tot?: number | null;
  last_price?: number | null;
  volume_24h?: number | null;
  total_open_interest?: number | null;
  total_accounts?: number | null;
  hasSupabase: boolean; // false = on-chain-only market
}): boolean {
  // On-chain-only markets (no Supabase row) are excluded — /api/markets only sees Supabase.
  if (!row.hasSupabase) return false;

  const accountsCount = row.total_accounts ?? 0;

  const hasNoStats =
    !isSaneMarketValue(row.last_price) &&
    !isSaneMarketValue(row.volume_24h) &&
    !isSaneMarketValue(row.total_open_interest) &&
    accountsCount === 0;

  const cTot = row.c_tot ?? 0;
  const isZombie = (cTot > 0 && !hasNoStats) ? false :
    ((row.vault_balance != null && row.vault_balance === 0) ||
    (row.vault_balance == null && hasNoStats));

  // GH#1531: show all non-zombie Supabase markets, regardless of price/volume/OI.
  return !isZombie;
}

describe("GH#1531: /markets page shows all non-zombie markets (counter matches /api/markets total)", () => {
  it("normal active market (vault=1M, accounts>0, sane price) is shown", () => {
    expect(isShownInMarketsList({
      hasSupabase: true,
      vault_balance: 1_000_000,
      total_accounts: 5,
      last_price: 1500,
      volume_24h: 50000,
      total_open_interest: 2_000_000,
    })).toBe(true);
  });

  it("non-zombie market with NO price/volume/OI is now shown (GH#1531 fix)", () => {
    // Previously this was filtered out by isActiveMarket() — it was in the 53 missing markets.
    // Now it is shown with '—' in those columns.
    expect(isShownInMarketsList({
      hasSupabase: true,
      vault_balance: 1_000_000,
      total_accounts: 0,
      last_price: null,
      volume_24h: null,
      total_open_interest: null,
    })).toBe(true);
  });

  it("non-zombie market with accounts but no price is shown", () => {
    expect(isShownInMarketsList({
      hasSupabase: true,
      vault_balance: 2_000_000,
      total_accounts: 3,
      last_price: null,
      volume_24h: null,
      total_open_interest: 0,
    })).toBe(true);
  });

  it("zombie market (vault=0, no activity) is NOT shown", () => {
    expect(isShownInMarketsList({
      hasSupabase: true,
      vault_balance: 0,
      c_tot: 0,
      total_accounts: 0,
      last_price: null,
      volume_24h: null,
      total_open_interest: 0,
    })).toBe(false);
  });

  it("zombie market (vault=0, stale price) is NOT shown", () => {
    // Even with a stale cached price, vault=0 → zombie → not shown.
    expect(isShownInMarketsList({
      hasSupabase: true,
      vault_balance: 0,
      c_tot: 0,
      total_accounts: 0,
      last_price: 99,
      volume_24h: null,
      total_open_interest: 0,
    })).toBe(false);
  });

  it("phantom market (vault=null, no stats, no accounts) is NOT shown", () => {
    // vault=null + hasNoStats → zombie → not shown.
    expect(isShownInMarketsList({
      hasSupabase: true,
      vault_balance: null,
      c_tot: 0,
      total_accounts: 0,
      last_price: null,
      volume_24h: null,
      total_open_interest: null,
    })).toBe(false);
  });

  it("market with c_tot>0 and no activity is still zombie (GH#1499 edge case)", () => {
    // NNOB pattern: c_tot>0 but vault=0, zero accounts, no price.
    // hasNoStats=true → c_tot exemption does NOT fire → zombie.
    expect(isShownInMarketsList({
      hasSupabase: true,
      vault_balance: 0,
      c_tot: 100_000_000_000,
      total_accounts: 0,
      last_price: null,
      volume_24h: null,
      total_open_interest: null,
    })).toBe(false);
  });

  it("FF7K keeper market: c_tot>0, vault=0, live price — NOT zombie, is shown", () => {
    // keeper markets store collateral in slab (c_tot) not vault ATA (vault_balance=0).
    // c_tot>0 AND hasActivity (live price) → not zombie → shown.
    expect(isShownInMarketsList({
      hasSupabase: true,
      vault_balance: 0,
      c_tot: 1_000_000_000,
      total_accounts: 0,
      last_price: 42.5,
      volume_24h: null,
      total_open_interest: null,
    })).toBe(true);
  });

  it("on-chain-only market (no Supabase row) is NOT shown", () => {
    // /api/markets only sees Supabase data — on-chain-only would inflate the count.
    expect(isShownInMarketsList({
      hasSupabase: false,
      vault_balance: null,
      last_price: null,
      volume_24h: null,
      total_open_interest: null,
    })).toBe(false);
  });

  it("counter = total non-zombie Supabase markets (168 scenario)", () => {
    // Simulate 168 non-zombie + 29 zombie + 2 on-chain-only = 199 total.
    const markets = [
      ...Array.from({ length: 168 }, (_, i) => ({
        hasSupabase: true,
        vault_balance: 1_000_000 + i,
        c_tot: 0,
        total_accounts: i % 5,
        last_price: i % 3 === 0 ? null : 1.5 + i,
        volume_24h: null,
        total_open_interest: null,
      })),
      ...Array.from({ length: 29 }, () => ({
        hasSupabase: true,
        vault_balance: 0 as number,
        c_tot: 0,
        total_accounts: 0,
        last_price: null as number | null,
        volume_24h: null as number | null,
        total_open_interest: null as number | null,
      })),
      ...Array.from({ length: 2 }, () => ({
        hasSupabase: false,
        vault_balance: null,
        total_accounts: null,
        last_price: 99,
        volume_24h: null,
        total_open_interest: null,
      })),
    ];

    const shown = markets.filter(isShownInMarketsList);
    expect(shown.length).toBe(168);
  });
});
