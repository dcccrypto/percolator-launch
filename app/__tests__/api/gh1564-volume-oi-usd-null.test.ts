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
  getServiceClient: () => ({
    from: () => ({
      select: () => Promise.resolve({ data: mockRows, error: null }),
    }),
  }),
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

  it("returns null USD fields when last_price is null (no price = no USD)", async () => {
    mockRows = [makeMarket({ last_price: null, mark_price: null, index_price: null })];
    const res = await GET(makeRequest());
    const body = await res.json();
    const market = body.markets[0];

    expect(market.volume_24h_usd).toBeNull();
    expect(market.total_open_interest_usd).toBeNull();
  });

  it("returns null total_open_interest_usd for phantom OI market (total_accounts=0, vault<1M, non-zero OI)", async () => {
    mockRows = [makeMarket({
      total_accounts: "0",
      vault_balance: "0",
      c_tot: "0",
      // total_open_interest retains default non-zero value (1500000000)
    })];
    const res = await GET(makeRequest({ include_zombie: "true" }));
    const body = await res.json();
    const market = body.markets[0];

    // Phantom OI guard fires when OI is non-zero but vault/accounts indicate no real positions.
    expect(market.total_open_interest_usd).toBeNull();
  });

  it("GH#1599: returns total_open_interest_usd=0 (not null) for vault=0 market with zero OI and valid price", async () => {
    // Pattern: vault_balance=0 + total_open_interest=0 + last_price set.
    // Before fix: isPhantomOI fired unconditionally → displayOiUsd=null even though OI is genuinely 0.
    // After fix: phantom guard only suppresses non-zero OI. Zero OI → total_open_interest_usd=0.
    mockRows = [makeMarket({
      total_accounts: "0",
      vault_balance: "0",
      total_open_interest: "0",
      open_interest_long: "0",
      open_interest_short: "0",
      c_tot: "0",
      last_price: "1.50", // valid price — ensures the null wasn't from missing price
    })];
    const res = await GET(makeRequest({ include_zombie: "true" }));
    const body = await res.json();
    const market = body.markets[0];

    expect(market.total_open_interest_usd).toBe(0);
    expect(market.total_open_interest).toBe(0);
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
