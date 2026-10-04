/**
 * isListedMarketRow is the ONE definition of "which markets exist" shared by
 * /markets and the landing page's Live Markets rail (the rail was empty while
 * /markets listed the live markets).
 */
import { describe, expect, it } from "vitest";
import { hasNoPriceSource, isListedMarketRow } from "@/lib/listed-markets";
import { isListedMarket } from "@/lib/market-visibility";
import { HARDCODED_BLOCKED_SLABS } from "@/lib/blocklist-data";

const LIVE = { vault_balance: "6750058418", c_tot: "4043583689", last_price: 0.007576, volume_24h: 796918623344, total_open_interest: 0, total_accounts: null };

describe("isListedMarketRow", () => {
  it("lists a live market whose NUMERIC columns arrive as strings", () => {
    expect(isListedMarketRow("LiveSlab1111111111111111111111111111111111", LIVE)).toBe(true);
  });

  it("drops a blocklisted slab even when it looks live", () => {
    const blocked = [...HARDCODED_BLOCKED_SLABS][0];
    expect(blocked).toBeTruthy();
    expect(isListedMarketRow(blocked, LIVE)).toBe(false);
  });

  it("drops a zombie whose empty vault arrives as the string \"0\"", () => {
    expect(isListedMarketRow("Z1", { vault_balance: "0", c_tot: "0", last_price: null, volume_24h: null, total_accounts: "0" })).toBe(false);
  });

  it("does not let a corrupt over-cap price count as activity", () => {
    expect(isListedMarketRow("Z2", { vault_balance: "0", c_tot: "0", last_price: "7900000000000", volume_24h: null, total_accounts: 0 })).toBe(false);
    expect(isListedMarketRow("Z3", { vault_balance: "0", c_tot: "0", last_price: "0.5", volume_24h: null, total_accounts: 0 })).toBe(true);
  });
});

describe("A-6: markets with no price source stay off the list; brand-new priced ones do not", () => {
  const POOL = "GmoZsr3GzZ1uS9d3n2k5hJxq4r6c7V8wXyZaBcDeFgHi";
  const SLAB = "Hm1bapsZfjn8ZBJtrhrnp5u6WC9UGfSa3KPNJsSgj9bA";
  it("hasNoPriceSource: only an EXPLICIT null/empty pool counts", () => {
    expect(hasNoPriceSource({ dex_pool_address: null })).toBe(true);
    expect(hasNoPriceSource({ dex_pool_address: "" })).toBe(true);
    expect(hasNoPriceSource({ dex_pool_address: "  " })).toBe(true);
    expect(hasNoPriceSource({ dex_pool_address: POOL })).toBe(false);
    expect(hasNoPriceSource({})).toBe(false); // not selected -> unknown -> listed
  });
  it("orphan (live vault, no pool, never pushed) is not listed", () => {
    expect(isListedMarketRow(SLAB, { ...LIVE, last_price: null, dex_pool_address: null })).toBe(false);
  });
  it("NEGATIVE CONTROL: a brand-new market WITH a pool and no price yet is still listed (shows Awaiting price)", () => {
    expect(isListedMarketRow(SLAB, { ...LIVE, last_price: null, dex_pool_address: POOL })).toBe(true);
  });
  it("NEGATIVE CONTROL: rows that never carried the field (undefined) are unchanged", () => {
    expect(isListedMarketRow(SLAB, LIVE)).toBe(true);
  });
  it("the server predicate (/api/stats) agrees", () => {
    const row = { slab_address: SLAB, vault_balance: "3350000000", c_tot: "1000000000", last_price: null, volume_24h: 0, total_open_interest: 0, total_accounts: 1 };
    expect(isListedMarket({ ...row, dex_pool_address: null })).toBe(false);
    expect(isListedMarket({ ...row, dex_pool_address: POOL })).toBe(true);
    expect(isListedMarket(row)).toBe(true);
  });
});

