/**
 * PERC-481: Tests for GET /api/trader/:wallet/stats
 *
 * STATS-001: Returns aggregated stats for a wallet with trades
 * STATS-002: Returns zeros/empty for a wallet with no trades
 * STATS-003: Rejects invalid wallet address with 400
 * STATS-004: Counts long/short trades correctly
 * STATS-005: Sums fees and volume correctly
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Supabase
const mockSupabase = {
  from: vi.fn().mockReturnThis(),
  select: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  order: vi.fn().mockReturnThis(),
  limit: vi.fn().mockResolvedValue({ data: [], error: null }),
};

vi.mock("@/lib/supabase", () => ({
  getServiceClient: () => mockSupabase,
}));

// Isolate rate limiter between tests by resetting modules
import { GET } from "@/app/api/trader/[wallet]/stats/route";
import { NextRequest } from "next/server";

const VALID_WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

function makeRequest(wallet: string): NextRequest {
  return new NextRequest(`http://localhost/api/trader/${wallet}/stats`, {
    headers: { "x-forwarded-for": `1.2.3.${Math.floor(Math.random() * 200) + 1}` },
  });
}

async function callRoute(wallet: string, trades: unknown[]) {
  mockSupabase.limit.mockResolvedValueOnce({ data: trades, error: null });
  const req = makeRequest(wallet);
  const res = await GET(req, { params: Promise.resolve({ wallet }) });
  return res;
}

describe("GET /api/trader/:wallet/stats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReturnThis();
    mockSupabase.select.mockReturnThis();
    mockSupabase.eq.mockReturnThis();
    mockSupabase.order.mockReturnThis();
    mockSupabase.limit.mockResolvedValue({ data: [], error: null });
  });

  // STATS-003: Invalid wallet rejected
  it("returns 400 for invalid wallet address", async () => {
    const req = makeRequest("not-a-valid-wallet");
    const res = await GET(req, { params: Promise.resolve({ wallet: "not-a-valid-wallet" }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid wallet/i);
  });

  // STATS-002: No trades
  it("returns zero stats for wallet with no trades", async () => {
    const res = await callRoute(VALID_WALLET, []);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalTrades).toBe(0);
    expect(body.longTrades).toBe(0);
    expect(body.shortTrades).toBe(0);
    expect(body.totalFees).toBe("0");
    expect(body.totalVolume).toBe("0");
    expect(body.uniqueMarkets).toBe(0);
    expect(body.firstTradeAt).toBeNull();
    expect(body.lastTradeAt).toBeNull();
  });

  // STATS-001 + STATS-004 + STATS-005: With real trades
  it("aggregates stats correctly for a wallet with trades", async () => {
    const trades = [
      {
        side: "long",
        size: "1000000",      // 1 token (e6)
        price: 100.0,         // $100 per token
        fee: 500,             // 0.0005 token fee
        slab_address: "MarketAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        side: "short",
        size: "-2000000",     // 2 tokens short (negative)
        price: 200.0,         // $200 per token
        fee: 1000,            // 0.001 token fee
        slab_address: "MarketBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        created_at: "2026-01-02T00:00:00Z",
      },
      {
        side: "long",
        size: "3000000",      // 3 tokens
        price: 150.0,
        fee: 750,
        slab_address: "MarketAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        created_at: "2026-01-03T00:00:00Z",
      },
    ];

    const res = await callRoute(VALID_WALLET, trades);
    expect(res.status).toBe(200);
    const body = await res.json();

    // STATS-001: Counts
    expect(body.totalTrades).toBe(3);
    // STATS-004: Long/short breakdown
    expect(body.longTrades).toBe(2);
    expect(body.shortTrades).toBe(1);
    // STATS-005: Fees sum = 500 + 1000 + 750 = 2250
    expect(body.totalFees).toBe("2250");
    // STATS-005: Volume
    // Trade1: 1_000_000 × 100_000_000 / 1_000_000 = 100_000_000
    // Trade2: 2_000_000 × 200_000_000 / 1_000_000 = 400_000_000
    // Trade3: 3_000_000 × 150_000_000 / 1_000_000 = 450_000_000
    // Total: 950_000_000
    expect(body.totalVolume).toBe("950000000");
    // Unique markets: 2
    expect(body.uniqueMarkets).toBe(2);
    // Timestamps
    expect(body.firstTradeAt).toBe("2026-01-01T00:00:00Z");
    expect(body.lastTradeAt).toBe("2026-01-03T00:00:00Z");
  });
});
