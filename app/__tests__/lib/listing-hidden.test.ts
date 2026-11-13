// @vitest-environment node
import { describe, it, expect } from "vitest";
import { isListedMarketRow } from "@/lib/listed-markets";
import { isHiddenFromListing } from "@/lib/listing-hidden";
import { BLOCKED_SLAB_ADDRESSES } from "@/lib/blocklist";

const SI = "8WC8vALsDJhNCUVRmqZBDSg5xgFAhDrgy7zWqF512pDx";
const PERC = "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";
const live = { vault_balance: 5_000_000_000, c_tot: 4_000_000_000, last_price: 0.004, volume_24h: 1000, total_open_interest: 10, total_accounts: 12 };

describe("listing-hidden (SI hidden for launch, still reachable)", () => {
  it("SI is not listed on /markets or the landing rail", () => {
    expect(isHiddenFromListing(SI)).toBe(true);
    expect(isListedMarketRow(SI, live)).toBe(false);
  });
  it("CONTROL: a live market with the same stats is listed", () => {
    expect(isListedMarketRow(PERC, live)).toBe(true);
  });
  it("hidden is NOT blocked: trade page, Earn exit and keeper registration stay open", () => {
    expect(BLOCKED_SLAB_ADDRESSES.has(SI)).toBe(false);
  });
});
