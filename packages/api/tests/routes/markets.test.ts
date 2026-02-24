import { describe, it, expect, vi, beforeEach } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { marketRoutes } from "../../src/routes/markets.js";
import { clearCache } from "../../src/middleware/cache.js";
import { clearDbCache } from "../../src/middleware/db-cache-fallback.js";

// Mock dependencies
vi.mock("@percolator/shared", () => ({
  getSupabase: vi.fn(),
  getConnection: vi.fn(),
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  sanitizeSlabAddress: vi.fn((addr: string) => addr),
  sanitizePagination: vi.fn((p: any) => p),
  sanitizeString: vi.fn((s: string) => s),
  sendInfoAlert: vi.fn(),
  sendCriticalAlert: vi.fn(),
  sendWarningAlert: vi.fn(),
  eventBus: { on: vi.fn(), emit: vi.fn(), off: vi.fn() },
  config: { supabaseUrl: "http://test", supabaseKey: "test", rpcUrl: "http://test" },
}));

vi.mock("@percolator/sdk", () => ({
  fetchSlab: vi.fn(),
  parseHeader: vi.fn(),
  parseConfig: vi.fn(),
  parseEngine: vi.fn(),
}));

const { getConnection, getSupabase } = await import("@percolator/shared");
const { fetchSlab, parseHeader, parseConfig, parseEngine } = await import("@percolator/sdk");

describe("markets routes", () => {
  let mockConnection: any;
  let mockSupabase: any;

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear both caches to prevent cross-test cache pollution
    clearCache();
    clearDbCache();

    mockConnection = {};
    mockSupabase = {
      from: vi.fn(() => mockSupabase),
      select: vi.fn(() => mockSupabase),
      eq: vi.fn(() => mockSupabase),
      single: vi.fn(() => mockSupabase),
    };

    vi.mocked(getConnection).mockReturnValue(mockConnection);
    vi.mocked(getSupabase).mockReturnValue(mockSupabase);
  });

  describe("GET /markets", () => {
    it("should return merged market and stats data", async () => {
      // The route uses a single 'markets_with_stats' view that combines both tables
      const mockMarketsWithStats = [
        {
          slab_address: "11111111111111111111111111111111",
          mint_address: "TokenMint111111111111111111111111",
          symbol: "BTC-PERP",
          name: "Bitcoin Perpetual",
          decimals: 9,
          deployer: "Deployer11111111111111111111111111",
          oracle_authority: "Oracle111111111111111111111111111",
          initial_price_e6: 50000000000,
          max_leverage: 10,
          trading_fee_bps: 5,
          lp_collateral: "1000000000",
          matcher_context: null,
          status: "active",
          logo_url: null,
          created_at: "2025-01-01T00:00:00Z",
          updated_at: "2025-01-01T00:00:00Z",
          // Stats from the view
          total_open_interest: "5000000000",
          total_accounts: 100,
          last_crank_slot: 123456789,
          last_price: 50000000000,
          mark_price: 50000000000,
          index_price: 50000000000,
          funding_rate: 5,
          net_lp_pos: "1000000",
        },
      ];

      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "markets_with_stats") {
          return {
            select: vi.fn().mockResolvedValue({ data: mockMarketsWithStats, error: null }),
          };
        }
        return mockSupabase;
      });

      const app = marketRoutes();
      const res = await app.request("/markets");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.markets).toHaveLength(1);
      expect(data.markets[0].slabAddress).toBe("11111111111111111111111111111111");
      expect(data.markets[0].symbol).toBe("BTC-PERP");
      expect(data.markets[0].totalOpenInterest).toBe("5000000000");
      expect(data.markets[0].fundingRate).toBe(5);
    });

    it("should handle markets without stats (null stats fields)", async () => {
      // The view returns null for stats fields when no stats exist
      const mockMarketsWithStats = [
        {
          slab_address: "22222222222222222222222222222222",
          symbol: "ETH-PERP",
          mint_address: "Mint2222222222222222222222222222",
          name: "Ethereum Perpetual",
          decimals: 9,
          deployer: "Deployer22222222222222222222222222",
          oracle_authority: "Oracle222222222222222222222222222",
          initial_price_e6: 3000000000,
          max_leverage: 10,
          trading_fee_bps: 5,
          lp_collateral: "1000000000",
          matcher_context: null,
          status: "active",
          logo_url: null,
          created_at: "2025-01-01T00:00:00Z",
          updated_at: "2025-01-01T00:00:00Z",
          // No stats — all null
          total_open_interest: null,
          total_accounts: null,
          last_crank_slot: null,
          last_price: null,
          mark_price: null,
          index_price: null,
          funding_rate: null,
          net_lp_pos: null,
        },
      ];

      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "markets_with_stats") {
          return {
            select: vi.fn().mockResolvedValue({ data: mockMarketsWithStats, error: null }),
          };
        }
        return mockSupabase;
      });

      const app = marketRoutes();
      const res = await app.request("/markets");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.markets).toHaveLength(1);
      expect(data.markets[0].totalOpenInterest).toBeNull();
      expect(data.markets[0].fundingRate).toBeNull();
    });
  });

  describe("GET /markets — response body shape", () => {
    it("should return array with all required frontend fields", async () => {
      const mockMarketsWithStats = [
        {
          slab_address: "33333333333333333333333333333333",
          mint_address: "Mint3333333333333333333333333333",
          symbol: "SOL-PERP",
          name: "Solana Perpetual",
          decimals: 9,
          deployer: "Deployer33333333333333333333333333",
          oracle_authority: "Oracle333333333333333333333333333",
          initial_price_e6: 100000000,
          max_leverage: 10,
          trading_fee_bps: 5,
          lp_collateral: "500000000",
          matcher_context: null,
          status: "active",
          logo_url: null,
          created_at: "2025-06-01T00:00:00Z",
          updated_at: "2025-06-01T00:00:00Z",
          total_open_interest: "2000000000",
          total_accounts: 50,
          last_crank_slot: 987654321,
          last_price: 100000000,
          mark_price: 100000000,
          index_price: 100000000,
          funding_rate: 3,
          net_lp_pos: "500000",
        },
      ];

      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "markets_with_stats") {
          return {
            select: vi.fn().mockResolvedValue({ data: mockMarketsWithStats, error: null }),
          };
        }
        return mockSupabase;
      });

      const app = marketRoutes();
      const res = await app.request("/markets");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data.markets)).toBe(true);

      const market = data.markets[0];
      // Core identity fields
      expect(market).toHaveProperty("slabAddress", "33333333333333333333333333333333");
      expect(market).toHaveProperty("mintAddress", "Mint3333333333333333333333333333");
      expect(market).toHaveProperty("symbol", "SOL-PERP");
      expect(market).toHaveProperty("name", "Solana Perpetual");
      expect(market).toHaveProperty("decimals", 9);
      expect(market).toHaveProperty("deployer");
      expect(market).toHaveProperty("oracleAuthority");
      expect(market).toHaveProperty("status", "active");
      // Stats fields
      expect(market).toHaveProperty("totalOpenInterest", "2000000000");
      expect(market).toHaveProperty("totalAccounts", 50);
      expect(market).toHaveProperty("lastPrice", 100000000);
      expect(market).toHaveProperty("markPrice", 100000000);
      expect(market).toHaveProperty("fundingRate", 3);
    });

    it("should return 400 for malformed slab address in /:slab route", async () => {
      const app = marketRoutes();
      // All /:slab routes should reject garbage inputs
      const malformed = [
        "/markets/not-a-valid-key",
        "/markets/OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO0", // contains invalid base58 chars
        "/markets/tooshort",
      ];

      for (const path of malformed) {
        const res = await app.request(path);
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toBe("Invalid slab address");
      }
    });
  });

  describe("GET /markets/stats", () => {
    it("should return all market stats", async () => {
      const mockStats = [
        { slab_address: "11111111111111111111111111111111", total_open_interest: "5000000000" },
        { slab_address: "22222222222222222222222222222222", total_open_interest: "3000000000" },
      ];

      mockSupabase.select.mockResolvedValue({ data: mockStats, error: null });

      const app = marketRoutes();
      const res = await app.request("/markets/stats");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.stats).toHaveLength(2);
    });
  });

  describe("GET /markets/:slab/stats", () => {
    it("should return stats for single market", async () => {
      const mockStat = {
        slab_address: "11111111111111111111111111111111",
        total_open_interest: "5000000000",
        funding_rate: 5,
      };

      mockSupabase.single.mockResolvedValue({ data: mockStat, error: null });

      const app = marketRoutes();
      const res = await app.request("/markets/11111111111111111111111111111111/stats");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.stats.slab_address).toBe("11111111111111111111111111111111");
    });

    it("should return 400 for invalid slab", async () => {
      const app = marketRoutes();
      const res = await app.request("/markets/invalid-slab/stats");

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Invalid slab address");
    });
  });

  describe("GET /markets/:slab", () => {
    it("should return on-chain market data", async () => {
      const mockSlabData = Buffer.alloc(100);
      
      vi.mocked(fetchSlab).mockResolvedValue(mockSlabData);
      vi.mocked(parseHeader).mockReturnValue({
        magic: BigInt(0x504552434F4C),
        version: 1,
        admin: new PublicKey("11111111111111111111111111111111"),
        resolved: true,
      });
      vi.mocked(parseConfig).mockReturnValue({
        collateralMint: new PublicKey("11111111111111111111111111111111"),
        vaultPubkey: new PublicKey("11111111111111111111111111111111"),
        oracleAuthority: new PublicKey("11111111111111111111111111111111"),
        authorityPriceE6: BigInt(50000000000),
      });
      vi.mocked(parseEngine).mockReturnValue({
        vault: BigInt(1000000000),
        totalOpenInterest: BigInt(5000000000),
        numUsedAccounts: 100,
        lastCrankSlot: BigInt(123456789),
      });

      const app = marketRoutes();
      const res = await app.request("/markets/11111111111111111111111111111111");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.slabAddress).toBe("11111111111111111111111111111111");
      expect(data.header).toBeDefined();
      expect(data.config).toBeDefined();
      expect(data.engine).toBeDefined();
    });

    it("should return 400 for invalid slab address", async () => {
      const app = marketRoutes();
      const res = await app.request("/markets/invalid-address");

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Invalid slab address");
    });

    it("should handle on-chain fetch errors", async () => {
      vi.mocked(fetchSlab).mockRejectedValue(new Error("Account not found"));

      const app = marketRoutes();
      const res = await app.request("/markets/11111111111111111111111111111111");

      expect(res.status).toBe(400);
      const data = await res.json();
      // In production, error details are hidden; generic message returned
      expect(data.error).toBe("Failed to fetch market data");
    });
  });
});
