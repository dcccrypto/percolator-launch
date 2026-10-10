/**
 * Half-made launches (market account on chain, launch never finished, no pool on the registry row:
 * the "UNKNOWN" rows) must not appear on any browse surface, found by rule, not by slab list.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isBrowsableMarketRow, isHalfMadeLaunch, isListedMarketRow } from "@/lib/listed-markets";
import { HARDCODED_BLOCKED_SLABS } from "@/lib/blocklist-data";
import { PLAYGROUND_SLAB_META } from "@/lib/playground-slab-meta";

const HALF_MADE = [
  "ACXY72Y6MibZ9L94ZPicA5BngridfWvJQLuyvsYaFqbH",
  "FWnaXWJ5k2fW4UcWkmSNCGfQJ9vv9Zyx7yx7NcgGrm4p",
  "wDvUoZgSZSy8fxVVxn15PNevRhqTbST3dzTSBrpzgjD",
  "4xqjnkwKPoiwiS4FsueKy1CgX5x9VN68uUiQ613XL7Wn",
  "zSwUoq9UARLwZyJySrXn4asjnYs5QoAPLJs7H8Q8qNz",
];
const POOL = "GmoZsr3GzZ1uS9d3n2k5hJxq4r6c7V8wXyZaBcDeFgHi";
const LIVE = { vault_balance: "6750058418", c_tot: "4043583689", last_price: 0.5, volume_24h: 10, total_accounts: 3 };

describe("half-made launches are hidden by rule", () => {
  for (const slab of HALF_MADE) {
    it(`${slab.slice(0, 6)}: an UNKNOWN placeholder (no pool, incomplete) is not browsable and not listed`, () => {
      const row = { symbol: "UNKNOWN", dex_pool_address: null, is_complete: false, vault_balance: 0, last_price: null };
      expect(isHalfMadeLaunch(slab, row)).toBe(true);
      expect(isBrowsableMarketRow(slab, row)).toBe(false);
      expect(isListedMarketRow(slab, row)).toBe(false);
    });
  }
  it("incomplete alone is enough, even if a pool is recorded", () => {
    expect(isBrowsableMarketRow("Half1", { ...LIVE, dex_pool_address: POOL, is_complete: false })).toBe(false);
    expect(isListedMarketRow("Half1", { ...LIVE, dex_pool_address: POOL, is_complete: false })).toBe(false);
  });
  it("no pool alone is enough (finished launch whose registration never landed)", () => {
    expect(isBrowsableMarketRow("Orph1", { ...LIVE, dex_pool_address: null, is_complete: true })).toBe(false);
  });

  // Negative controls: the rule must not hide healthy markets.
  it("NEGATIVE CONTROL: a complete, priced, registered market stays browsable and listed", () => {
    const row = { ...LIVE, dex_pool_address: POOL, is_complete: true };
    expect(isBrowsableMarketRow("Good1", row)).toBe(true);
    expect(isListedMarketRow("Good1", row)).toBe(true);
  });
  it("NEGATIVE CONTROL: unread completeness (undefined) degrades to shown, never hidden", () => {
    expect(isHalfMadeLaunch("Good2", {})).toBe(false);
    expect(isBrowsableMarketRow("Good2", { ...LIVE, dex_pool_address: POOL })).toBe(true);
  });
  it("NEGATIVE CONTROL: a curated seed is never hidden by the rule", () => {
    const seed = Object.keys(PLAYGROUND_SLAB_META)[0];
    if (!seed) return;
    expect(isBrowsableMarketRow(seed, { ...LIVE, is_complete: false, dex_pool_address: null })).toBe(true);
  });

  it("the five are NOT hard-coded in the blocklist (a blocklist would also hide them from their creator's My Markets and reclaim)", () => {
    for (const slab of HALF_MADE) expect(HARDCODED_BLOCKED_SLABS).not.toContain(slab);
  });
  it("the three browse surfaces use the shared predicate", () => {
    for (const f of ["app/trade/page.tsx", "components/trade/MarketSelector.tsx", "components/trade/MarketSwitcher.tsx"]) {
      expect(readFileSync(join(__dirname, "../..", f), "utf8")).toMatch(/isBrowsableMarketRow\(/);
    }
  });
  it("creator recovery is not routed through the browse predicate", () => {
    for (const f of ["hooks/useCreatedMarkets.ts", "hooks/useStuckSlabs.ts", "components/create/RecoverSolBanner.tsx"]) {
      expect(readFileSync(join(__dirname, "../..", f), "utf8")).not.toMatch(/isBrowsableMarketRow|isHalfMadeLaunch/);
    }
  });
});
