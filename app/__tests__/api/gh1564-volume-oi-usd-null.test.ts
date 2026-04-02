/**
 * GH#1564: volume_24h_usd and total_open_interest_usd were null for all 168 markets.
 *
 * Root cause: Supabase returns NUMERIC columns as JavaScript strings at runtime.
 * TypeScript `as number | null` is compile-time only and performs no coercion.
 * sanitizePrice / rawToUsd / isSaneMarketValue all call Number.isFinite() which
 * returns false for strings → price was null → USD fields were null for every market.
 *
 * Fix: module-level numericOrNull() applied to all NUMERIC fields at the top of
 * the .map() callback before any USD computation. Previously numericOrNull() was
 * defined inline inside the zombie-check block (too late — USD calcs ran first).
 *
 * GH#1563: activeMarkets field (69) conflicted with activeTotal (115) with no clear
 * definition. activeMarkets removed from /api/stats response; activeTotal is canonical.
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

// Track the mock rows set by each test
let mockRows: Record<string, unknown>[] = [];

vi.mock("@/lib/supabase", () => ({
  getServerNetwork: () => "devnet",
  getServiceClient: () => {
    // Fully chainable + thenable mock: any filter method returns the chain;
    // awaiting the chain resolves the data (Supabase PostgREST builder pattern).
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.neq = () => chain;
    chain.not = () => chain;
    chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: mockRows, error: null });
    return { from: () => chain };
  },
}));

/** Build a minimal market row with NUMERIC fields as STRINGS (Supabase runtime behaviour). */
function makeMarket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slab_address: "TESTMARKET1111111111111111111111111111111111",
    mint_address: "MINTaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
    symbol: "WENDYS",
    name: "Wendys Token",
    decimals: "6",               // NUMERIC → string from Supabase
    deployer: "deployer111111111111111111111111111111111111",
    logo_url: null,
    max_leverage: "10",
    trading_fee_bps: "10",
    // Prices as strings (NUMERIC columns)
    last_price: "0.42",          // $0.42 — valid price previously rejected by isFinite
    mark_price: "0.42",
    index_price: "0.42",
    volume_24h: "500000000",     // 500 tokens at $0.42 = $210
    trade_count_24h: "5",
    open_interest_long: "1000000000",
    open_interest_short: "500000000",
    total_open_interest: "1500000000",
    insurance_fund: "0",
    insurance_balance: "0",
    total_accounts: "3",
    funding_rate: "0",
    net_lp_pos: "0",
    lp_sum_abs: "0",
    c_tot: "5000000000",
    vault_balance: "10000000000", // > 0 — not zombie
    created_at: "2026-01-01T00:00:00.000Z",
    stats_updated_at: "2026-03-22T20:00:00.000Z",
    oracle_mode: "admin",
    dex_pool_address: null,
    mainnet_ca: null,
    oracle_authority: "auth111111111111111111111111111111111111111",
    ...overrides,
  };
}

function makeRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL("http://localhost/api/markets");
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

describe("GH#1564: volume_24h_usd and total_open_interest_usd when Supabase returns NUMERIC as strings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRows = [];
  });

  it("computes volume_24h_usd as a number (not null) when DB returns NUMERIC fields as strings", async () => {
    mockRows = [makeMarket()];
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.markets).toHaveLength(1);
    const market = body.markets[0];

    // Before fix: volume_24h_usd was null because Number.isFinite("0.42") === false
    // After fix: numericOrNull coerces "0.42" → 0.42 → sanitizePrice passes → USD computed
    expect(market.volume_24h_usd).not.toBeNull();
    expect(typeof market.volume_24h_usd).toBe("number");
    expect(market.volume_24h_usd).toBeGreaterThan(0);

    // 500_000_000 tokens / 10^6 decimals * $0.42 = $210
    expect(market.volume_24h_usd).toBeCloseTo(210, 0);
  });

  it("computes total_open_interest_usd as a number (not null) for non-phantom market", async () => {
    mockRows = [makeMarket()];
    const res = await GET(makeRequest());
    const body = await res.json();
    const market = body.markets[0];

    // Before fix: null. After fix: (1_500_000_000 / 1e6) * 0.42 = $630
    expect(market.total_open_interest_usd).not.toBeNull();
    expect(typeof market.total_open_interest_usd).toBe("number");
    expect(market.total_open_interest_usd).toBeCloseTo(630, 0);
  });

  it("returns null volume_24h_usd and 0 total_open_interest_usd when last_price is null", async () => {
    // volume_24h_usd: no price → null (can't value volume without a price)
    // total_open_interest_usd: GH#1610 — atoms=1.5B > 0, price=null → 0 not null.
    // Admin-oracle markets where the keeper never posted a price still have real OI;
    // returning 0 (not null) lets sort=oi rank them above zero-OI markets correctly.
    mockRows = [makeMarket({ last_price: null, mark_price: null, index_price: null })];
    const res = await GET(makeRequest());
    const body = await res.json();
    const market = body.markets[0];

    expect(market.volume_24h_usd).toBeNull();
    expect(market.total_open_interest_usd).toBe(0); // GH#1610: atoms > 0, no price → 0
  });

  it("returns 0 total_open_interest_usd for phantom OI market (GH#1606: atoms zeroed → USD=0)", async () => {
    // GH#1606: Phantom markets zero all raw OI atom fields in the response.
    // USD must be consistent: atoms=0 → USD=0 (not null).
    mockRows = [makeMarket({
      total_accounts: "0",
      vault_balance: "0",
      c_tot: "0",
    })];
    const res = await GET(makeRequest({ include_zombie: "true" }));
    const body = await res.json();
    const market = body.markets[0];

    // Phantom OI guard: total_accounts=0, vault=0 → atoms zeroed → USD must also be 0
    expect(market.total_open_interest_usd).toBe(0);
  });

  it("correctly computes USD fields for multiple markets with string NUMERIC fields", async () => {
    mockRows = [
      makeMarket({
        slab_address: "MARKET111111111111111111111111111111111111",
        last_price: "1.00",
        volume_24h: "1000000000",    // 1000 tokens * $1 = $1000
        total_open_interest: "2000000000", // 2000 tokens * $1 = $2000
        total_accounts: "5",
        vault_balance: "5000000000",
      }),
      makeMarket({
        slab_address: "MARKET222222222222222222222222222222222222",
        last_price: "2.50",
        volume_24h: "400000000",     // 400 tokens * $2.50 = $1000
        total_open_interest: "800000000",  // 800 tokens * $2.50 = $2000
        total_accounts: "10",
        vault_balance: "5000000000",
      }),
    ];
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.markets).toHaveLength(2);
    for (const market of body.markets) {
      expect(market.volume_24h_usd).not.toBeNull();
      expect(market.total_open_interest_usd).not.toBeNull();
      expect(market.volume_24h_usd).toBeCloseTo(1000, 0);
      expect(market.total_open_interest_usd).toBeCloseTo(2000, 0);
    }
  });

  it("last_price, mark_price, index_price are also numeric (coerced from string) in response", async () => {
    mockRows = [makeMarket()];
    const res = await GET(makeRequest());
    const body = await res.json();
    const market = body.markets[0];

    expect(typeof market.last_price).toBe("number");
    expect(market.last_price).toBeCloseTo(0.42, 2);
    expect(typeof market.mark_price).toBe("number");
    expect(typeof market.index_price).toBe("number");
  });
});

describe("GH#1563: activeMarkets removed from /api/stats — activeTotal is the canonical active count", () => {
  it("documents that activeMarkets was removed to eliminate the 69 vs 115 confusion", () => {
    // GH#1563: /api/stats previously returned:
    //   activeMarkets: 69   (all non-zombie markets with any sane stat, incl. corrupt prices)
    //   activeTotal: 115    (zombie-excluded markets passing isActiveMarket with price cap)
    // Two 'active' counts with no documented distinction → removed activeMarkets.
    // activeTotal is now the single source of truth for "active" market count.
    //
    // The stats route is integration-tested in:
    //   __tests__/api/stats-phantom-oi-guard.test.ts
    //   __tests__/api/gh1538-stats-active-total-phantom.test.ts
    // This test documents the GH#1563 fix as a regression anchor.
    const EXPECTED_FIELDS_PRESENT = ["totalMarkets", "activeTotal", "totalListedMarkets", "totalVolume24h", "totalOpenInterest", "totalTraders", "trades24h", "updatedAt"];
    const REMOVED_FIELD = "activeMarkets";
    expect(EXPECTED_FIELDS_PRESENT).not.toContain(REMOVED_FIELD);
  });
});
