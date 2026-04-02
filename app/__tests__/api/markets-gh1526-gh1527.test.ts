/**
 * GH#1526: oracle_mode filter should map frontend values ("manual", "live_feed")
 *          to DB-stored values ("admin", "hyperp") before filtering.
 *
 * GH#1527: search should match well-known token symbols (e.g. "SOL") even when
 *          the DB stores truncated addresses (e.g. symbol="So111111").
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

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BONK_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

function mkMarket(overrides: Record<string, unknown> = {}) {
  return {
    slab_address: `Slab${overrides.symbol ?? "X"}11111111111111111111111111111111`.slice(0, 44),
    mint_address: "Mint111111111111111111111111111111111111111",
    mainnet_ca: null,
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

// ─── GH#1526: oracle_mode filter mapping ────────────────────────────────────

describe("GH#1526 — oracle_mode frontend→DB value mapping", () => {
  beforeEach(() => {
    mockMarkets = [];
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("oracle_mode=manual maps to DB value 'admin' and returns those markets", async () => {
    mockMarkets = [
      mkMarket({ symbol: "ADMIN1", oracle_mode: "admin", slab_address: "SlabADMIN111111111111111111111111111111111111" }),
      mkMarket({ symbol: "HYPERP1", oracle_mode: "hyperp", slab_address: "SlabHYPERP11111111111111111111111111111111111" }),
      mkMarket({ symbol: "PYTH1", oracle_mode: "pyth", slab_address: "SlabPYTH1111111111111111111111111111111111111" }),
    ];

    const { GET } = await import("@/app/api/markets/route");
    const res = await GET(makeRequest({ oracle_mode: "manual" }));
    const body = (await res.json()) as { markets: { symbol: string }[]; total: number };

    expect(res.status).toBe(200);
    // "manual" should resolve to "admin" and return only ADMIN1
    expect(body.total).toBe(1);
    expect(body.markets).toHaveLength(1);
    expect(body.markets[0].symbol).toBe("ADMIN1");
  });

  it("oracle_mode=live_feed maps to DB value 'hyperp' and returns those markets", async () => {
    mockMarkets = [
      mkMarket({ symbol: "ADMIN1", oracle_mode: "admin", slab_address: "SlabADMIN111111111111111111111111111111111111" }),
      mkMarket({ symbol: "HYPERP1", oracle_mode: "hyperp", slab_address: "SlabHYPERP11111111111111111111111111111111111" }),
      mkMarket({ symbol: "HYPERP2", oracle_mode: "hyperp", slab_address: "SlabHYPERP21111111111111111111111111111111111" }),
    ];

    const { GET } = await import("@/app/api/markets/route");
    const res = await GET(makeRequest({ oracle_mode: "live_feed" }));
    const body = (await res.json()) as { markets: { symbol: string }[]; total: number };

    expect(res.status).toBe(200);
    // "live_feed" should resolve to "hyperp" and return 2 markets
    expect(body.total).toBe(2);
    expect(body.markets).toHaveLength(2);
    expect(body.markets.map((m) => m.symbol).sort()).toEqual(["HYPERP1", "HYPERP2"]);
  });

  it("oracle_mode=admin (DB canonical value) still works as before", async () => {
    mockMarkets = [
      mkMarket({ symbol: "ADMIN1", oracle_mode: "admin", slab_address: "SlabADMIN111111111111111111111111111111111111" }),
      mkMarket({ symbol: "HYPERP1", oracle_mode: "hyperp", slab_address: "SlabHYPERP11111111111111111111111111111111111" }),
    ];

    const { GET } = await import("@/app/api/markets/route");
    const res = await GET(makeRequest({ oracle_mode: "admin" }));
    const body = (await res.json()) as { markets: { symbol: string }[] };

    expect(body.markets).toHaveLength(1);
    expect(body.markets[0].symbol).toBe("ADMIN1");
  });

  it("oracle_mode=pyth still works", async () => {
    mockMarkets = [
      mkMarket({ symbol: "ADMIN1", oracle_mode: "admin", slab_address: "SlabADMIN111111111111111111111111111111111111" }),
      mkMarket({ symbol: "PYTH1", oracle_mode: "pyth", slab_address: "SlabPYTH1111111111111111111111111111111111111" }),
    ];

    const { GET } = await import("@/app/api/markets/route");
    const res = await GET(makeRequest({ oracle_mode: "pyth" }));
    const body = (await res.json()) as { markets: { symbol: string }[] };

    expect(body.markets).toHaveLength(1);
    expect(body.markets[0].symbol).toBe("PYTH1");
  });

  it("regresses: oracle_mode=manual no longer returns 0 results when admin markets exist", async () => {
    // This was the exact production failure: 168 admin markets, filter returns 0
    mockMarkets = Array.from({ length: 5 }, (_, i) =>
      mkMarket({
        symbol: `MARKET${i}`,
        oracle_mode: "admin",
        slab_address: `SlabMARKET${i}1111111111111111111111111111111111`.slice(0, 44),
      }),
    );

    const { GET } = await import("@/app/api/markets/route");
    const res = await GET(makeRequest({ oracle_mode: "manual" }));
    const body = (await res.json()) as { markets: unknown[]; total: number };

    // Should return the 5 admin markets, not 0
    expect(body.total).toBe(5);
    expect(body.markets).toHaveLength(5);
  });
});

// ─── GH#1527: search by well-known token symbol ─────────────────────────────

describe("GH#1527 — search matches known token symbols via mint address", () => {
  beforeEach(() => {
    mockMarkets = [];
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("search=SOL matches market with SOL mint_address even when DB symbol is truncated", async () => {
    mockMarkets = [
      // SOL market — DB has truncated symbol from StatsCollector default
      mkMarket({
        symbol: "So111111",
        name: "Market EkQty1Ls",
        mint_address: SOL_MINT,
        mainnet_ca: null,
        slab_address: "SlabSOL11111111111111111111111111111111111111",
      }),
      // Unrelated market
      mkMarket({
        symbol: "WENDYS",
        name: "Wendys Perp",
        mint_address: "Mint111111111111111111111111111111111111111",
        mainnet_ca: null,
        slab_address: "SlabWENDYS1111111111111111111111111111111111",
      }),
    ];

    const { GET } = await import("@/app/api/markets/route");
    const res = await GET(makeRequest({ search: "SOL" }));
    const body = (await res.json()) as { markets: { symbol: string }[]; total: number };

    expect(res.status).toBe(200);
    // Should find the SOL market via mint address lookup
    expect(body.total).toBe(1);
    expect(body.markets).toHaveLength(1);
    expect(body.markets[0].mint_address).toBe(SOL_MINT);
  });

  it("search=sol (lowercase) matches SOL market case-insensitively", async () => {
    mockMarkets = [
      mkMarket({
        symbol: "So111111",
        name: "Market EkQty1Ls",
        mint_address: SOL_MINT,
        slab_address: "SlabSOL11111111111111111111111111111111111111",
      }),
    ];

    const { GET } = await import("@/app/api/markets/route");
    const res = await GET(makeRequest({ search: "sol" }));
    const body = (await res.json()) as { markets: unknown[] };

    expect(body.markets).toHaveLength(1);
  });

  it("search=BONK matches market with BONK mainnet_ca (fallback field)", async () => {
    mockMarkets = [
      mkMarket({
        symbol: "DezXAZ8z",
        name: "Market DezXAZ",
        mint_address: "DevnetMint1111111111111111111111111111111111",
        mainnet_ca: BONK_MINT, // mainnet CA is BONK
        slab_address: "SlabBONK1111111111111111111111111111111111111",
      }),
    ];

    const { GET } = await import("@/app/api/markets/route");
    const res = await GET(makeRequest({ search: "BONK" }));
    const body = (await res.json()) as { markets: unknown[] };

    expect(body.markets).toHaveLength(1);
  });

  it("search=WENDYS still works via direct DB symbol match (regression)", async () => {
    mockMarkets = [
      mkMarket({
        symbol: "WENDYS",
        name: "Wendys Perp",
        mint_address: "Mint111111111111111111111111111111111111111",
        slab_address: "SlabWENDYS1111111111111111111111111111111111",
      }),
      mkMarket({
        symbol: "So111111",
        name: "Market EkQty1Ls",
        mint_address: SOL_MINT,
        slab_address: "SlabSOL11111111111111111111111111111111111111",
      }),
    ];

    const { GET } = await import("@/app/api/markets/route");
    const res = await GET(makeRequest({ search: "WENDYS" }));
    const body = (await res.json()) as { markets: { symbol: string }[] };

    expect(body.markets).toHaveLength(1);
    expect(body.markets[0].symbol).toBe("WENDYS");
  });

  it("regresses: search=SOL no longer returns 0 when SOL market has truncated DB symbol", async () => {
    // This was the exact production failure described in GH#1527
    mockMarkets = [
      mkMarket({
        symbol: "So111111",
        name: "Market EkQty1Ls",
        mint_address: SOL_MINT,
        slab_address: "SlabSOL11111111111111111111111111111111111111",
      }),
    ];

    const { GET } = await import("@/app/api/markets/route");
    const res = await GET(makeRequest({ search: "SOL" }));
    const body = (await res.json()) as { markets: unknown[]; total: number };

    // Previously returned 0 — now must return 1
    expect(body.total).toBe(1);
    expect(body.markets).toHaveLength(1);
  });

  it("search=USDC matches market with USDC mint address", async () => {
    mockMarkets = [
      mkMarket({
        symbol: "EPjFWdd5",
        name: "Market EPjFWdd",
        mint_address: USDC_MINT,
        slab_address: "SlabUSDC1111111111111111111111111111111111111",
      }),
      mkMarket({
        symbol: "BONKMARKET",
        name: "Bonk Market",
        mint_address: BONK_MINT,
        slab_address: "SlabBONK1111111111111111111111111111111111111",
      }),
    ];

    const { GET } = await import("@/app/api/markets/route");
    const res = await GET(makeRequest({ search: "USDC" }));
    const body = (await res.json()) as { markets: unknown[]; total: number };

    expect(body.total).toBe(1);
    expect(body.markets).toHaveLength(1);
  });
});
