/**
 * #856: Tests for corrupt price sanitization in GET /api/markets.
 * Ensures unscaled admin-set prices (billions/trillions) are nulled out,
 * while real prices are passed through unchanged.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Sentry
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

// Mock config
vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    rpcUrl: "https://api.devnet.solana.com",
    network: "devnet",
    programId: "11111111111111111111111111111111",
  }),
}));

// Build a minimal market row
function mkMarket(overrides: Record<string, unknown> = {}) {
  return {
    slab_address: "TestSlabAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    mint_address: "TestMintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    symbol: "TEST",
    name: "Test Market",
    decimals: 6,
    deployer: "11111111111111111111111111111111",
    logo_url: null,
    max_leverage: 10,
    trading_fee_bps: 10,
    last_price: 0.001234,
    mark_price: 0.001234,
    volume_24h: 1000,
    open_interest_long: 500,
    open_interest_short: 500,
    total_open_interest: 1000,
    insurance_fund: 1000,
    insurance_balance: 1000,
    total_accounts: 10,
    funding_rate: 1,
    net_lp_pos: 0,
    lp_sum_abs: 0,
    c_tot: 0,
    vault_balance: 0,
    created_at: "2026-01-01T00:00:00Z",
    stats_updated_at: "2026-01-01T00:00:00Z",
    oracle_mode: "admin",
    dex_pool_address: null,
    mainnet_ca: null,
    oracle_authority: "FF7KFfU5abBLnJoSLpPBEjxeJGCBFuWLvvqaJsH3fS5Y",
    ...overrides,
  };
}

// ---- Mock Supabase ----
let mockMarkets: unknown[] = [];
const mockSupabase = {
  from: vi.fn().mockReturnThis(),
  select: vi.fn().mockImplementation(() => ({
    then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
      resolve({ data: mockMarkets, error: null }),
  })),
};
// Make supabase chainable with select returning a thenable
vi.mock("@/lib/supabase", () => ({
  getServiceClient: () => ({
    from: () => ({
      select: () => Promise.resolve({ data: mockMarkets, error: null }),
    }),
  }),
}));

describe("GET /api/markets — price sanitization (#856)", () => {
  beforeEach(() => {
    mockMarkets = [];
    vi.unstubAllEnvs();
  });

  it("passes through realistic prices unchanged", async () => {
    mockMarkets = [
      mkMarket({ last_price: 0.0001234, mark_price: 0.000125 }),
      mkMarket({ last_price: 95000, mark_price: 95100, symbol: "BTC" }), // BTC ~$95K
      mkMarket({ last_price: 3200, mark_price: 3210, symbol: "ETH" }),
    ];

    const { GET } = await import("@/app/api/markets/route");
    const res = await GET();
    const body = (await res.json()) as { markets: { last_price: number | null; mark_price: number | null; symbol: string }[] };

    expect(body.markets[0].last_price).toBeCloseTo(0.0001234);
    expect(body.markets[0].mark_price).toBeCloseTo(0.000125);
    expect(body.markets[1].last_price).toBe(95000);
    expect(body.markets[2].mark_price).toBe(3210);
  });

  it("nulls out prices exceeding $1M (corrupt admin test values)", async () => {
    mockMarkets = [
      mkMarket({ last_price: 7_902_953_782_213.77, mark_price: 7_902_953_782_213.77, symbol: "TEST" }),
      mkMarket({ last_price: 2_109_062_099_051, mark_price: null, symbol: "DsSV" }),
      mkMarket({ last_price: 901_100_011, mark_price: 901_100_011, symbol: "PPL" }),
      mkMarket({ last_price: 100_000_000, mark_price: 100_000_000, symbol: "TOLY" }),
      mkMarket({ last_price: 1_000_001, mark_price: 1_000_001, symbol: "OVER_1M" }),
    ];

    const { GET } = await import("@/app/api/markets/route");
    const res = await GET();
    const body = (await res.json()) as { markets: { last_price: number | null; mark_price: number | null; symbol: string }[] };

    for (const m of body.markets) {
      expect(m.last_price, `${m.symbol} last_price should be null`).toBeNull();
      expect(m.mark_price, `${m.symbol} mark_price should be null`).toBeNull();
    }
  });

  it("nulls out prices strictly above $1M — passes values ≤$1M (boundary)", async () => {
    mockMarkets = [
      mkMarket({ last_price: 1_000_001, mark_price: 1_000_001, symbol: "OVER" }),     // $1M + $1 — corrupt
      mkMarket({ last_price: 1_000_000, mark_price: 1_000_000, symbol: "AT_LIMIT" }), // $1M exactly — passes
      mkMarket({ last_price: 99_000, mark_price: 99_000, symbol: "BTC_ISH" }),         // BTC range — passes
    ];
    const { GET } = await import("@/app/api/markets/route");
    const res = await GET();
    const body = (await res.json()) as { markets: { last_price: number | null; symbol: string }[] };
    const over = body.markets.find((m) => m.symbol === "OVER");
    const atLimit = body.markets.find((m) => m.symbol === "AT_LIMIT");
    const btcIsh = body.markets.find((m) => m.symbol === "BTC_ISH");
    expect(over?.last_price).toBeNull();
    expect(atLimit?.last_price).toBe(1_000_000);
    expect(btcIsh?.last_price).toBe(99_000);
  });

  it("nulls out negative and zero prices", async () => {
    mockMarkets = [
      mkMarket({ last_price: 0, mark_price: 0 }),
      mkMarket({ last_price: -100, mark_price: -0.01 }),
    ];
    const { GET } = await import("@/app/api/markets/route");
    const res = await GET();
    const body = (await res.json()) as { markets: { last_price: number | null; mark_price: number | null }[] };
    for (const m of body.markets) {
      expect(m.last_price).toBeNull();
      expect(m.mark_price).toBeNull();
    }
  });

  it("passes through null last_price/mark_price as null (unknown price)", async () => {
    mockMarkets = [mkMarket({ last_price: null, mark_price: null })];
    const { GET } = await import("@/app/api/markets/route");
    const res = await GET();
    const body = (await res.json()) as { markets: { last_price: number | null; mark_price: number | null }[] };
    expect(body.markets[0].last_price).toBeNull();
    expect(body.markets[0].mark_price).toBeNull();
  });

  it("filters out blocked market addresses from env var", async () => {
    vi.stubEnv("BLOCKED_MARKET_ADDRESSES", "BlockedSlab11111111111111111111111111111111");
    mockMarkets = [
      mkMarket({ slab_address: "BlockedSlab11111111111111111111111111111111", symbol: "BLOCKED" }),
      mkMarket({ slab_address: "GoodSlab111111111111111111111111111111111111", symbol: "GOOD" }),
    ];

    // Re-import to pick up new env var (module caches the set on load)
    vi.resetModules();
    const { GET } = await import("@/app/api/markets/route");
    const res = await GET();
    const body = (await res.json()) as { markets: { symbol: string }[] };

    const symbols = body.markets.map((m) => m.symbol);
    expect(symbols).not.toContain("BLOCKED");
    expect(symbols).toContain("GOOD");
  });

  it("sanitizes index_price with same bounds as last_price/mark_price (#855)", async () => {
    mockMarkets = [
      // Corrupt index_price — should be nulled
      mkMarket({ symbol: "A", index_price: 900_000_000 } as Record<string, unknown>),
      // Legit index_price — should pass through
      mkMarket({ symbol: "B", index_price: 42_500 } as Record<string, unknown>),
      // Null index_price — stays null
      mkMarket({ symbol: "C", index_price: null } as Record<string, unknown>),
    ];

    vi.resetModules();
    const { GET } = await import("@/app/api/markets/route");
    const res = await GET();
    const body = (await res.json()) as {
      markets: { symbol: string; index_price: number | null }[];
    };

    const a = body.markets.find((m) => m.symbol === "A");
    const b = body.markets.find((m) => m.symbol === "B");
    const c = body.markets.find((m) => m.symbol === "C");

    expect(a?.index_price).toBeNull();   // corrupt value nulled
    expect(b?.index_price).toBe(42_500); // legit value preserved
    expect(c?.index_price).toBeNull();   // already-null preserved
  });
});
