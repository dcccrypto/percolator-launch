/**
 * #856: Tests for corrupt price sanitization in GET /api/markets.
 * Ensures unscaled admin-set prices (billions/trillions) are nulled out,
 * while real prices are passed through unchanged.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Sentry (must include all methods called in route — captureMessage is used by sanitizePrice)
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

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
    vault_balance: 500_000_000,  // 500 USDC at 6dp — realistic LP deposit above dust threshold
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
  getServerNetwork: () => "devnet",
  getServiceClient: () => {
    const chain: Record<string, unknown> = {};
    const terminal = () => Promise.resolve({ data: mockMarkets, error: null });
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.neq = () => chain;
    chain.not = () => chain;
    chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: mockMarkets, error: null });
    return { from: () => chain };
  },
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

  it("hardcoded blocklist excludes issue #837 corrupt market regardless of env var", async () => {
    // This market has wrong oracle_authority (5Eb8PY personal wallet) and hardcoded $1 price.
    // It must be excluded even without BLOCKED_MARKET_ADDRESSES env var set.
    const CORRUPT_MARKET = "HjBePQZnoZVftg9B52gyeuHGjBvt2f8FNCVP4FeoP3YT";
    mockMarkets = [
      mkMarket({ slab_address: CORRUPT_MARKET, symbol: "CORRUPT" }),
      mkMarket({ slab_address: "GoodSlab111111111111111111111111111111111111", symbol: "GOOD" }),
    ];

    vi.resetModules();
    vi.unstubAllEnvs(); // ensure env var is NOT set
    const { GET } = await import("@/app/api/markets/route");
    const res = await GET();
    const body = (await res.json()) as { markets: { symbol: string }[] };

    const symbols = body.markets.map((m) => m.symbol);
    expect(symbols).not.toContain("CORRUPT");
    expect(symbols).toContain("GOOD");
  });

  it("includes total_open_interest_usd — computed USD field from raw OI + decimals + price (#1160)", async () => {
    // GH#1618: rawToUsd rounds to 2dp — use amounts that produce exact 2dp results.
    // 1_000_000 micro-units @ 6 decimals = 1.0 tokens; at $1.0/token = $1.00
    mockMarkets = [
      mkMarket({ symbol: "NORM", total_open_interest: 1_000_000, decimals: 6, last_price: 1.0 }),
      // Sentinel value with no valid long/short fallback — should produce null USD
      mkMarket({ symbol: "SENTINEL", total_open_interest: 2e19, open_interest_long: 0, open_interest_short: 0, decimals: 6, last_price: 1.0 }),
      // No price — should produce null USD
      mkMarket({ symbol: "NOPRICE", total_open_interest: 1_000_000, decimals: 6, last_price: null }),
      // total_open_interest null but long+short available: 600_000+400_000 = 1_000_000 atoms → $1.00
      mkMarket({ symbol: "FALLBACK", total_open_interest: null, open_interest_long: 600_000, open_interest_short: 400_000, decimals: 6, last_price: 1.0 }),
    ];

    vi.resetModules();
    const { GET } = await import("@/app/api/markets/route");
    const res = await GET();
    const body = (await res.json()) as {
      markets: { symbol: string; total_open_interest_usd: number | null }[];
    };

    const norm = body.markets.find((m) => m.symbol === "NORM");
    const sentinel = body.markets.find((m) => m.symbol === "SENTINEL");
    const noprice = body.markets.find((m) => m.symbol === "NOPRICE");
    const fallback = body.markets.find((m) => m.symbol === "FALLBACK");

    expect(norm?.total_open_interest_usd).toBe(1.0);               // 1_000_000 / 1e6 * 1.0 = 1.00 (GH#1618: rounded to 2dp)
    expect(sentinel?.total_open_interest_usd).toBe(0);             // GH#1594: sentinel primary rejected, but long=0+short=0 → valid zero OI
    expect(noprice?.total_open_interest_usd).toBe(0);              // GH#1610: atoms > 0, price=null → 0 not null (admin-oracle, unpriced)
    expect(fallback?.total_open_interest_usd).toBe(1.0);           // (600_000+400_000) / 1e6 * 1.0 = 1.00 (GH#1618: rounded to 2dp)
  });

  it("includes total field matching markets array length (#1168)", async () => {
    mockMarkets = [
      mkMarket({ symbol: "A" }),
      mkMarket({ symbol: "B" }),
      mkMarket({ symbol: "C" }),
    ];

    vi.resetModules();
    const { GET } = await import("@/app/api/markets/route");
    const res = await GET();
    const body = (await res.json()) as { total: number; markets: unknown[] };

    expect(body.total).toBe(3);
    expect(body.total).toBe(body.markets.length);
  });

  it("total excludes blocked markets (#1168)", async () => {
    vi.stubEnv("BLOCKED_MARKET_ADDRESSES", "BlockedSlab11111111111111111111111111111111");
    mockMarkets = [
      mkMarket({ slab_address: "BlockedSlab11111111111111111111111111111111", symbol: "BLOCKED" }),
      mkMarket({ symbol: "GOOD_A" }),
      mkMarket({ symbol: "GOOD_B" }),
    ];

    vi.resetModules();
    const { GET } = await import("@/app/api/markets/route");
    const res = await GET();
    const body = (await res.json()) as { total: number; markets: unknown[] };

    // BLOCKED market excluded → total = 2
    expect(body.total).toBe(2);
    expect(body.total).toBe(body.markets.length);
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

  // PERC-816: Dust vault guard — phantom OI suppression for markets with dust vault_balance.
  describe("PERC-816 — phantom OI suppression for dust vault_balance", () => {
    it("excludes vault_balance=0 markets by default (GH#1420 zombie filter)", async () => {
      mockMarkets = [
        mkMarket({ symbol: "ZERO_VAULT", vault_balance: 0, total_open_interest: 2_000_000_000_000, last_price: 1.0 }),
        mkMarket({ symbol: "HEALTHY", vault_balance: 5_000_000_000, total_open_interest: 1_000_000_000, last_price: 100.0 }),
      ];
      vi.resetModules();
      const { GET } = await import("@/app/api/markets/route");
      const res = await GET();
      const body = (await res.json()) as { markets: { symbol: string }[] };
      expect(body.markets.find((m) => m.symbol === "ZERO_VAULT")).toBeUndefined();
      expect(body.markets.find((m) => m.symbol === "HEALTHY")).toBeDefined();
    });

    it("suppresses total_open_interest_usd when vault_balance is dust (< 1,000,000) — GH#1438 alignment", async () => {
      mockMarkets = [
        mkMarket({ symbol: "DUST_1", vault_balance: 1, total_open_interest: 2_000_000_000_000, last_price: 1.0 }),
        mkMarket({ symbol: "DUST_100", vault_balance: 100, total_open_interest: 2_000_000_000_000, last_price: 1.0 }),
        mkMarket({ symbol: "DUST_999999", vault_balance: 999_999, total_open_interest: 2_000_000_000_000, last_price: 1.0 }),
        // GH#1438: vault=1M is the creation-deposit amount; strict < means it is NOT phantom.
        // OI should pass through for vault=1M (aligns /api/markets with /api/stats).
        mkMarket({ symbol: "CREATION_DEPOSIT_1M", vault_balance: 1_000_000, total_open_interest: 2_000_000_000_000, last_price: 1.0 }),
        // GH#1438 pure-OI boundary: vault=1M market with no last_price and no volume_24h.
        // This is the exact regression vector — a market at the threshold that has OI
        // but no price data. The phantom guard must NOT suppress its OI; activeTotal
        // should reflect it (though USD value will be 0/null without a price).
        mkMarket({ symbol: "PURE_OI_1M", vault_balance: 1_000_000, total_open_interest: 5_000_000_000, last_price: null, volume_24h: null }),
      ];
      vi.resetModules();
      const { GET } = await import("@/app/api/markets/route");
      const res = await GET();
      const body = (await res.json()) as { markets: { symbol: string; total_open_interest_usd: number | null }[] };
      // vault < 1M → phantom OI suppressed (GH#1606: USD=0, not null, for consistency with zeroed atoms)
      for (const sym of ["DUST_1", "DUST_100", "DUST_999999"]) {
        const m = body.markets.find((m) => m.symbol === sym);
        expect(m?.total_open_interest_usd).toBe(0); // GH#1606: phantom → atoms zeroed → USD=0
      }
      // vault=1M → NOT phantom (strict <), OI passes through
      const creation1M = body.markets.find((m) => m.symbol === "CREATION_DEPOSIT_1M");
      expect(creation1M?.total_open_interest_usd).toBeGreaterThan(0); // real OI for creation-deposit vault
      // Pure-OI boundary (GH#1438 regression vector): vault=1M, no last_price, no volume_24h.
      // The phantom guard must NOT suppress the raw OI atoms. USD is null (no price) but the
      // market still appears in the response and its raw total_open_interest is non-zero.
      const pureOi1M = body.markets.find((m) => m.symbol === "PURE_OI_1M");
      expect(pureOi1M).toBeDefined(); // market is included (vault=1M is not phantom)
      // GH#1610: atoms=5B > 0, price=null → USD=0 (not null). Unpriced OI displays as 0
      // so sort=oi ranks these markets above zero-OI markets, not below them.
      expect(pureOi1M?.total_open_interest_usd).toBe(0);
      expect((pureOi1M as Record<string, unknown>)?.total_open_interest).toBe(5_000_000_000); // raw OI passes through
    });

    it("passes through total_open_interest_usd when vault_balance >= 1,000,000 (real liquidity)", async () => {
      // GH#1618: rawToUsd rounds to 2dp — use 1_000_000 atoms (→ $1.00) instead of 1_000 (→ $0.001 rounds to $0.00)
      mockMarkets = [
        // GH#1438: vault=1M is the creation-deposit amount; strict < means it is NOT phantom.
        // Aligned with /api/stats which also uses strict < for the same boundary.
        mkMarket({ symbol: "AT_THRESHOLD", vault_balance: 1_000_000, total_open_interest: 1_000_000, decimals: 6, last_price: 1.0 }),
        // one above threshold — real liquidity
        mkMarket({ symbol: "ABOVE_THRESHOLD", vault_balance: 1_000_001, total_open_interest: 1_000_000, decimals: 6, last_price: 1.0 }),
        // well above threshold — typical LP deposit
        mkMarket({ symbol: "REAL_VAULT", vault_balance: 500_000_000, total_open_interest: 1_000_000, decimals: 6, last_price: 1.0 }),
      ];
      vi.resetModules();
      const { GET } = await import("@/app/api/markets/route");
      const res = await GET();
      const body = (await res.json()) as { markets: { symbol: string; total_open_interest_usd: number | null }[] };
      const atThreshold = body.markets.find((m) => m.symbol === "AT_THRESHOLD");
      const aboveThreshold = body.markets.find((m) => m.symbol === "ABOVE_THRESHOLD");
      const realVault = body.markets.find((m) => m.symbol === "REAL_VAULT");
      // exactly at threshold (vault=1M) → NOT phantom (GH#1438: strict < aligns with /api/stats)
      expect(atThreshold?.total_open_interest_usd).toBe(1.0); // 1_000_000 / 1e6 * 1.0 = $1.00 (GH#1618: rounded to 2dp)
      // one above threshold → real liquidity, OI passes through
      expect(aboveThreshold?.total_open_interest_usd).toBe(1.0); // 1_000_000 / 1e6 * 1.0 = $1.00
      expect(realVault?.total_open_interest_usd).toBe(1.0);      // 1_000_000 / 1e6 * 1.0 = $1.00
    });

    it("returns 0 total_open_interest_usd when total_accounts = 0 (GH#1606: phantom → atoms zeroed → USD=0)", async () => {
      // GH#1606: phantom markets zero all OI atom fields; USD must match → 0 not null.
      mockMarkets = [
        mkMarket({ symbol: "NO_ACCOUNTS", total_accounts: 0, vault_balance: 500_000_000, total_open_interest: 2_000_000_000_000, last_price: 1.0 }),
      ];
      vi.resetModules();
      const { GET } = await import("@/app/api/markets/route");
      const res = await GET();
      const body = (await res.json()) as { markets: { symbol: string; total_open_interest_usd: number | null }[] };
      const m = body.markets.find((m) => m.symbol === "NO_ACCOUNTS");
      expect(m?.total_open_interest_usd).toBe(0);
    });
  });
});
