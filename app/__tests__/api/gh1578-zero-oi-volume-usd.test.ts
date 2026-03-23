/**
 * GH#1578: total_open_interest_usd and volume_24h_usd return null instead of 0
 * when raw integer values are 0 and mark_price is valid.
 *
 * Root cause: rawToUsd() called isSaneMarketValue(0) which requires v > 0 and
 * returned null for zero values. Similarly, the rawOi derivation path fell through
 * to the combined OI calc which also returned null for zero combined OI.
 *
 * Fix: rawToUsd() now short-circuits to 0 when raw === 0. The rawOi derivation
 * also explicitly treats 0 as valid (not requiring isSaneMarketValue which rejects 0).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/markets/route";

vi.mock("@sentry/nextjs", () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  getConfig: vi.fn(() => ({
    rpcUrl: "https://api.devnet.solana.com",
    programId: "11111111111111111111111111111112",
  })),
}));

let mockRows: Record<string, unknown>[] = [];

vi.mock("@/lib/supabase", () => ({
  getServiceClient: () => ({
    from: () => ({
      select: () => Promise.resolve({ data: mockRows, error: null }),
    }),
  }),
}));

/** Build a minimal market row that mimics a zero-OI market with valid mark_price. */
function makeZeroOiMarket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slab_address: "ZEROMARKET1111111111111111111111111111111111",
    mint_address: "MINTzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
    symbol: "WENDYS",
    name: "Wendys Coin",
    is_active: true,
    base_lot_size: "1000",
    quote_lot_size: "10",
    tick_size: "100",
    decimals: "6",
    // Zero OI and volume — but valid mark_price (Supabase returns NUMERIC as strings)
    last_price: "0.000099",
    mark_price: "0.000099",
    index_price: "0.000099",
    volume_24h: "0",
    trade_count_24h: "0",
    open_interest_long: "0",
    open_interest_short: "0",
    total_open_interest: "0",
    funding_rate: "0",
    // Non-phantom: has accounts and vault balance
    total_accounts: "5",
    vault_balance: "5000000",
    c_tot: "0",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL("http://localhost/api/markets");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url);
}

describe("GH#1578: zero OI/volume → USD should be 0, not null", () => {
  beforeEach(() => {
    mockRows = [];
  });

  it("returns total_open_interest_usd=0 when total_open_interest=0 and mark_price is valid", async () => {
    mockRows = [makeZeroOiMarket()];
    const res = await GET(makeRequest());
    const body = await res.json();
    const market = body.markets?.[0];
    expect(market).toBeDefined();
    expect(market.total_open_interest).toBe(0);
    expect(market.total_open_interest_usd).toBe(0);
  });

  it("returns volume_24h_usd=0 when volume_24h=0 and mark_price is valid", async () => {
    mockRows = [makeZeroOiMarket()];
    const res = await GET(makeRequest());
    const body = await res.json();
    const market = body.markets?.[0];
    expect(market).toBeDefined();
    // volume_24h is the raw Supabase NUMERIC field (may be string "0" or number 0)
    expect(Number(market.volume_24h)).toBe(0);
    // volume_24h_usd is the computed USD value — must be exactly 0 (not null)
    expect(market.volume_24h_usd).toBe(0);
  });

  it("returns 0 USD fields when mark_price is null for zero raw values (zero OI/volume → 0 regardless of price)", async () => {
    mockRows = [makeZeroOiMarket({ last_price: null, mark_price: null, index_price: null })];
    const res = await GET(makeRequest());
    const body = await res.json();
    const market = body.markets?.[0];
    expect(market).toBeDefined();
    // With no price we can't compute USD — null is expected
    expect(market.total_open_interest_usd).toBe(0); // zero OI → 0 regardless of price
    expect(market.volume_24h_usd).toBe(0);           // zero volume → 0 regardless of price
  });

  it("still returns null total_open_interest_usd for phantom OI market", async () => {
    // Phantom: total_accounts=0, vault<1M even if OI>0 → should suppress
    // Use include_zombie=true so the market isn't filtered from the response
    mockRows = [makeZeroOiMarket({
      total_open_interest: "1000",
      total_accounts: "0",
      vault_balance: "0",
    })];
    const res = await GET(makeRequest({ include_zombie: "true" }));
    const body = await res.json();
    const market = body.markets?.[0];
    expect(market).toBeDefined();
    expect(market.total_open_interest_usd).toBeNull();
  });

  it("returns 0 for both OI and volume when market has real users but zero activity", async () => {
    mockRows = [makeZeroOiMarket({
      total_accounts: "10",
      vault_balance: "10000000",
    })];
    const res = await GET(makeRequest());
    const body = await res.json();
    const market = body.markets?.[0];
    expect(market).toBeDefined();
    expect(market.total_open_interest_usd).toBe(0);
    expect(market.volume_24h_usd).toBe(0);
  });

  it("preserves non-zero USD values for active markets", async () => {
    mockRows = [makeZeroOiMarket({
      total_open_interest: "1000000",
      volume_24h: "500000",
      total_accounts: "10",
      vault_balance: "10000000",
    })];
    const res = await GET(makeRequest());
    const body = await res.json();
    const market = body.markets?.[0];
    expect(market).toBeDefined();
    // 1000000 raw * 0.000099 / 1e6 = 0.000099
    expect(market.total_open_interest_usd).toBeGreaterThan(0);
    expect(market.volume_24h_usd).toBeGreaterThan(0);
  });
});
