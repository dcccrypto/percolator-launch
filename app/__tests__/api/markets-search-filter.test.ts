/**
 * GH#1512: Tests for search, sort, order, oracle_mode query params on GET /api/markets.
 * Previously these params were completely ignored — all markets returned regardless.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    rpcUrl: "https://api.devnet.solana.com",
    network: "devnet",
    programId: "11111111111111111111111111111111",
  }),
}));

// Helpers
function mkMarket(overrides: Record<string, unknown> = {}) {
  return {
    slab_address: `Slab${overrides.symbol ?? "X"}11111111111111111111111111111111`.slice(0, 44),
    mint_address: "Mint111111111111111111111111111111111111111",
    symbol: "TEST",
    name: "Test Market",
    decimals: 6,
    deployer: "11111111111111111111111111111111",
    logo_url: null,
    max_leverage: 10,
    trading_fee_bps: 10,
    last_price: 1.0,
    mark_price: 1.0,
    index_price: 1.0,
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
    vault_balance: 500_000_000,
    created_at: "2026-01-01T00:00:00Z",
    stats_updated_at: "2026-01-01T00:00:00Z",
    oracle_mode: "admin",
    dex_pool_address: null,
    mainnet_ca: null,
    oracle_authority: "FF7KFfU5abBLnJoSLpPBEjxeJGCBFuWLvvqaJsH3fS5Y",
    ...overrides,
  };
}

let mockMarkets: unknown[] = [];

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

function makeRequest(params: Record<string, string> = {}) {
  const url = new URL("http://localhost/api/markets");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const { NextRequest } = require("next/server");
  return new NextRequest(url.toString());
}

describe("GET /api/markets — GH#1512 search + filter + sort", () => {
  beforeEach(() => {
    mockMarkets = [];
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  // ── search ────────────────────────────────────────────────────────────────

  describe("?search= filtering", () => {
    it("returns only markets whose symbol matches search query (case-insensitive)", async () => {
      mockMarkets = [
        mkMarket({ symbol: "WENDYS", name: "Wendys Perp" }),
        mkMarket({ symbol: "BTC", name: "Bitcoin Perpetual", slab_address: "SlabBTC11111111111111111111111111111111111111" }),
        mkMarket({ symbol: "SOL", name: "Solana Perpetual", slab_address: "SlabSOL11111111111111111111111111111111111111" }),
      ];

      const { GET } = await import("@/app/api/markets/route");
      const res = await GET(makeRequest({ search: "wendys" }));
      const body = (await res.json()) as { markets: { symbol: string }[] };

      expect(body.markets).toHaveLength(1);
      expect(body.markets[0].symbol).toBe("WENDYS");
    });

    it("returns no markets when search matches nothing", async () => {
      mockMarkets = [
        mkMarket({ symbol: "BTC", slab_address: "SlabBTC11111111111111111111111111111111111111" }),
        mkMarket({ symbol: "SOL", slab_address: "SlabSOL11111111111111111111111111111111111111" }),
      ];

      const { GET } = await import("@/app/api/markets/route");
      const res = await GET(makeRequest({ search: "XYZNOTEXIST" }));
      const body = (await res.json()) as { markets: unknown[]; total: number };

      expect(body.markets).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it("also matches on market name field", async () => {
      mockMarkets = [
        mkMarket({ symbol: "PERC", name: "Percolator Token", slab_address: "SlabPERC1111111111111111111111111111111111111" }),
        mkMarket({ symbol: "OTHER", name: "Something Else", slab_address: "SlabOTHER111111111111111111111111111111111111" }),
      ];

      const { GET } = await import("@/app/api/markets/route");
      const res = await GET(makeRequest({ search: "percolator" }));
      const body = (await res.json()) as { markets: { symbol: string }[] };

      expect(body.markets).toHaveLength(1);
      expect(body.markets[0].symbol).toBe("PERC");
    });

    it("search is case-insensitive for both query and symbol", async () => {
      mockMarkets = [
        mkMarket({ symbol: "BITCOIN", name: "Bitcoin Perpetual" }),
      ];

      const { GET } = await import("@/app/api/markets/route");
      const res = await GET(makeRequest({ search: "BiTcOiN" }));
      const body = (await res.json()) as { markets: { symbol: string }[] };

      expect(body.markets).toHaveLength(1);
    });

    it("returns all markets when search is empty string", async () => {
      mockMarkets = [
        mkMarket({ symbol: "BTC", slab_address: "SlabBTC11111111111111111111111111111111111111" }),
        mkMarket({ symbol: "SOL", slab_address: "SlabSOL11111111111111111111111111111111111111" }),
      ];

      const { GET } = await import("@/app/api/markets/route");
      const res = await GET(makeRequest({ search: "" }));
      const body = (await res.json()) as { markets: unknown[] };

      expect(body.markets).toHaveLength(2);
    });

    it("total in response reflects search-filtered count", async () => {
      mockMarkets = [
        mkMarket({ symbol: "WENDYS", slab_address: "SlabWENDYS1111111111111111111111111111111111" }),
        mkMarket({ symbol: "BTC", slab_address: "SlabBTC11111111111111111111111111111111111111" }),
        mkMarket({ symbol: "SOL", slab_address: "SlabSOL11111111111111111111111111111111111111" }),
      ];

      const { GET } = await import("@/app/api/markets/route");
      const res = await GET(makeRequest({ search: "WENDYS" }));
      const body = (await res.json()) as { markets: unknown[]; total: number };

      expect(body.total).toBe(1);
      expect(body.markets).toHaveLength(1);
    });
  });

  // ── oracle_mode ───────────────────────────────────────────────────────────

  describe("?oracle_mode= filtering", () => {
    it("filters to only markets with matching oracle_mode", async () => {
      mockMarkets = [
        mkMarket({ symbol: "BTC", oracle_mode: "pyth", slab_address: "SlabBTC11111111111111111111111111111111111111" }),
        mkMarket({ symbol: "SOL", oracle_mode: "admin", slab_address: "SlabSOL11111111111111111111111111111111111111" }),
        mkMarket({ symbol: "PERC", oracle_mode: "hyperp", slab_address: "SlabPERC1111111111111111111111111111111111111" }),
      ];

      const { GET } = await import("@/app/api/markets/route");
      const res = await GET(makeRequest({ oracle_mode: "pyth" }));
      const body = (await res.json()) as { markets: { symbol: string }[] };

      expect(body.markets).toHaveLength(1);
      expect(body.markets[0].symbol).toBe("BTC");
    });

    it("returns empty list when no markets match oracle_mode", async () => {
      mockMarkets = [
        mkMarket({ symbol: "BTC", oracle_mode: "admin", slab_address: "SlabBTC11111111111111111111111111111111111111" }),
      ];

      const { GET } = await import("@/app/api/markets/route");
      const res = await GET(makeRequest({ oracle_mode: "pyth" }));
      const body = (await res.json()) as { markets: unknown[] };

      expect(body.markets).toHaveLength(0);
    });
  });

  // ── sort + order ──────────────────────────────────────────────────────────

  describe("?sort= + ?order= sorting", () => {
    it("sorts by last_price ascending", async () => {
      mockMarkets = [
        mkMarket({ symbol: "C", last_price: 300, slab_address: "SlabC111111111111111111111111111111111111111" }),
        mkMarket({ symbol: "A", last_price: 100, slab_address: "SlabA111111111111111111111111111111111111111" }),
        mkMarket({ symbol: "B", last_price: 200, slab_address: "SlabB111111111111111111111111111111111111111" }),
      ];

      const { GET } = await import("@/app/api/markets/route");
      const res = await GET(makeRequest({ sort: "last_price", order: "asc" }));
      const body = (await res.json()) as { markets: { symbol: string }[] };

      expect(body.markets.map((m) => m.symbol)).toEqual(["A", "B", "C"]);
    });

    it("sorts by last_price descending", async () => {
      mockMarkets = [
        mkMarket({ symbol: "C", last_price: 300, slab_address: "SlabC111111111111111111111111111111111111111" }),
        mkMarket({ symbol: "A", last_price: 100, slab_address: "SlabA111111111111111111111111111111111111111" }),
        mkMarket({ symbol: "B", last_price: 200, slab_address: "SlabB111111111111111111111111111111111111111" }),
      ];

      const { GET } = await import("@/app/api/markets/route");
      const res = await GET(makeRequest({ sort: "last_price", order: "desc" }));
      const body = (await res.json()) as { markets: { symbol: string }[] };

      expect(body.markets.map((m) => m.symbol)).toEqual(["C", "B", "A"]);
    });

    it("sorts by symbol alphabetically", async () => {
      mockMarkets = [
        mkMarket({ symbol: "SOL", slab_address: "SlabSOL11111111111111111111111111111111111111" }),
        mkMarket({ symbol: "BTC", slab_address: "SlabBTC11111111111111111111111111111111111111" }),
        mkMarket({ symbol: "ETH", slab_address: "SlabETH11111111111111111111111111111111111111" }),
      ];

      const { GET } = await import("@/app/api/markets/route");
      const res = await GET(makeRequest({ sort: "symbol", order: "asc" }));
      const body = (await res.json()) as { markets: { symbol: string }[] };

      expect(body.markets.map((m) => m.symbol)).toEqual(["BTC", "ETH", "SOL"]);
    });

    it("places null last_price markets last regardless of sort direction", async () => {
      mockMarkets = [
        mkMarket({ symbol: "NULL", last_price: null, slab_address: "SlabNULL1111111111111111111111111111111111111" }),
        mkMarket({ symbol: "LOW", last_price: 1, slab_address: "SlabLOW11111111111111111111111111111111111111" }),
        mkMarket({ symbol: "HIGH", last_price: 999, slab_address: "SlabHIGH1111111111111111111111111111111111111" }),
      ];

      const { GET } = await import("@/app/api/markets/route");
      const res = await GET(makeRequest({ sort: "last_price", order: "asc" }));
      const body = (await res.json()) as { markets: { symbol: string }[] };

      const symbols = body.markets.map((m) => m.symbol);
      expect(symbols[symbols.length - 1]).toBe("NULL");
    });

    it("ignores unknown sort field (returns unsorted)", async () => {
      mockMarkets = [
        mkMarket({ symbol: "A", slab_address: "SlabA111111111111111111111111111111111111111" }),
        mkMarket({ symbol: "B", slab_address: "SlabB111111111111111111111111111111111111111" }),
      ];

      const { GET } = await import("@/app/api/markets/route");
      const res = await GET(makeRequest({ sort: "injected_field", order: "asc" }));
      const body = (await res.json()) as { markets: { symbol: string }[] };

      // No error — just returns unsorted
      expect(res.status).toBe(200);
      expect(body.markets).toHaveLength(2);
    });
  });

  // ── combined ──────────────────────────────────────────────────────────────

  describe("combined params", () => {
    it("applies search then sort then limit in correct order", async () => {
      mockMarkets = [
        mkMarket({ symbol: "WENDYS", last_price: 0.5, slab_address: "SlabWENDYS1111111111111111111111111111111111" }),
        mkMarket({ symbol: "WENDY2", last_price: 0.1, slab_address: "SlabWENDY21111111111111111111111111111111111" }),
        mkMarket({ symbol: "WENDY3", last_price: 0.3, slab_address: "SlabWENDY31111111111111111111111111111111111" }),
        mkMarket({ symbol: "BTC", last_price: 90000, slab_address: "SlabBTC11111111111111111111111111111111111111" }),
      ];

      const { GET } = await import("@/app/api/markets/route");
      const res = await GET(makeRequest({ search: "wendy", sort: "last_price", order: "desc", limit: "2" }));
      const body = (await res.json()) as { markets: { symbol: string }[]; total: number };

      // Only WENDY markets, sorted desc, limited to 2
      expect(body.total).toBe(3); // total reflects search-filtered count before limit
      expect(body.markets).toHaveLength(2);
      expect(body.markets[0].symbol).toBe("WENDYS"); // 0.5 is highest
      expect(body.markets[1].symbol).toBe("WENDY3"); // 0.3 second
    });
  });
});
