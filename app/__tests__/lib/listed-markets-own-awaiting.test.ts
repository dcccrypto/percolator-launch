/**
 * percolator-indexer#223: the creator's own market whose live price is not connected yet shows in
 * THEIR markets list (marked awaiting) and nowhere else. Every other listing rule still applies, and
 * nobody else sees it: the browse rules (isListedMarketRow / isBrowsableMarketRow) are unchanged.
 */
import { describe, expect, it } from "vitest";
import { isBrowsableMarketRow, isListedMarketRow, isOwnAwaitingPriceRow } from "@/lib/listed-markets";

const ME = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const OTHER = "7JVQvrAfzj3aasLxCkoLYX5KQcrb5nEZhUe5Qa8PvV5G";
const SLAB = "SLABaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const live = { vault_balance: "1000000000", c_tot: "1000000000", total_accounts: 1, last_price: null };
const unpriced = { ...live, deployer: ME, dex_pool_address: null };

describe("isOwnAwaitingPriceRow", () => {
  it("the deployer sees their unpriced market", () => {
    expect(isOwnAwaitingPriceRow(SLAB, unpriced, ME)).toBe(true);
    expect(isOwnAwaitingPriceRow(SLAB, { ...unpriced, dex_pool_address: "  " }, ME)).toBe(true);
  });

  it("NEGATIVE: anyone else, and a disconnected visitor, still do not; browse surfaces still hide it", () => {
    expect(isOwnAwaitingPriceRow(SLAB, unpriced, OTHER)).toBe(false);
    expect(isOwnAwaitingPriceRow(SLAB, unpriced, null)).toBe(false);
    expect(isOwnAwaitingPriceRow(SLAB, unpriced, undefined)).toBe(false);
    expect(isListedMarketRow(SLAB, unpriced)).toBe(false);
    expect(isBrowsableMarketRow(SLAB, unpriced)).toBe(false);
  });

  it("NEGATIVE: a half-made launch is hidden from its creator too (My Markets offers Continue)", () => {
    expect(isOwnAwaitingPriceRow(SLAB, { ...unpriced, is_complete: false }, ME)).toBe(false);
  });

  it("NEGATIVE: a zombie (nothing funded, no activity) is not shown either", () => {
    const zombie = { deployer: ME, dex_pool_address: null, vault_balance: "0", c_tot: "0", total_accounts: 0, last_price: null };
    expect(isOwnAwaitingPriceRow(SLAB, zombie, ME)).toBe(false);
  });

  it("a market that HAS a price source is not 'awaiting': it is listed the ordinary way", () => {
    const priced = { ...live, deployer: ME, dex_pool_address: "POOL" };
    expect(isOwnAwaitingPriceRow(SLAB, priced, ME)).toBe(false);
    expect(isListedMarketRow(SLAB, priced)).toBe(true);
  });

  it("a row whose pool was not read (undefined) is unknown, not awaiting", () => {
    expect(isOwnAwaitingPriceRow(SLAB, { ...live, deployer: ME }, ME)).toBe(false);
  });
});
