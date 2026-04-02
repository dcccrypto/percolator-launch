/**
 * GH#1744: /api/markets returns null total/activeTotal when limit=0 or limit=NaN.
 * GH#1753: Non-numeric limit (limit=abc, limit=NaN) now soft-defaults to MAX_LIMIT (500)
 *          instead of returning 400. This matches the fix for limit=0 (clamped to MIN_LIMIT).
 *
 * Fix: clamp limit to [1, 500] instead of rejecting limit=0/NaN/string with 400.
 * Ensures total and activeTotal are always numbers in 200 responses.
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

function mkMarket(overrides: Record<string, unknown> = {}) {
  const symbol = (overrides.symbol as string) ?? "TEST";
  return {
    slab_address: `Slab${symbol}${"1".repeat(44)}`.slice(0, 44),
    mint_address: "Mint111111111111111111111111111111111111111",
    mainnet_ca: null,
    symbol,
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
    c_tot: 100000,
    oracle_mode: "admin",
    vault_balance: 1000000,
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

describe("GH#1744 — limit=0 and limit=NaN should never return null total/activeTotal", () => {
  beforeEach(() => {
    mockMarkets = [
      mkMarket({ symbol: "A" }),
      mkMarket({ symbol: "B" }),
      mkMarket({ symbol: "C" }),
    ];
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("limit=0 returns 200 with total as number (clamped to MIN_LIMIT=1)", async () => {
    const { GET } = await import("@/app/api/markets/route");
    const res = await GET(makeRequest({ limit: "0" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.total).toBe("number");
    expect(typeof body.activeTotal).toBe("number");
    expect(body.total).toBe(3); // all 3 markets, total not affected by limit
    // limit=0 clamped to 1, so at most 1 market returned
    expect(body.markets.length).toBeGreaterThanOrEqual(0);
    expect(body.markets.length).toBeLessThanOrEqual(1);
  });

  it("limit=NaN returns 200 with total as number, defaults to MAX_LIMIT (GH#1753)", async () => {
    const { GET } = await import("@/app/api/markets/route");
    const res = await GET(makeRequest({ limit: "NaN" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.total).toBe("number");
    expect(typeof body.activeTotal).toBe("number");
    // All 3 markets returned (default MAX_LIMIT=500 applies)
    expect(body.markets.length).toBe(3);
  });

  it("limit=abc returns 200 with total as number, defaults to MAX_LIMIT (GH#1753)", async () => {
    const { GET } = await import("@/app/api/markets/route");
    const res = await GET(makeRequest({ limit: "abc" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.total).toBe("number");
    expect(typeof body.activeTotal).toBe("number");
    // All 3 markets returned (default MAX_LIMIT=500 applies)
    expect(body.markets.length).toBe(3);
  });

  it("limit=1 returns 200 with total as number and 1 market", async () => {
    const { GET } = await import("@/app/api/markets/route");
    const res = await GET(makeRequest({ limit: "1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.total).toBe("number");
    expect(body.total).toBe(3);
    expect(body.markets.length).toBe(1);
  });

  it("limit=500 (MAX_LIMIT) returns 200 with all markets (<=500)", async () => {
    const { GET } = await import("@/app/api/markets/route");
    const res = await GET(makeRequest({ limit: "500" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.total).toBe("number");
    expect(body.markets.length).toBe(3);
  });

  it("no limit param returns 200 with all markets", async () => {
    const { GET } = await import("@/app/api/markets/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.total).toBe("number");
    expect(body.total).toBe(3);
    expect(body.markets.length).toBe(3);
  });
});
