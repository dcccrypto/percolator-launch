/**
 * DB Query Tests — get24hVolume, getGlobalRecentTrades, getRecentTrades
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock Supabase ───────────────────────────────────────────────────────────

const mockChain = {
  select: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  gte: vi.fn().mockReturnThis(),
  order: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  single: vi.fn().mockReturnThis(),
  insert: vi.fn().mockReturnThis(),
};

// Make the chain resolve to { data, error } by default
let mockData: any[] = [];
let mockError: any = null;

// Override terminal methods to return promise-like
const createChain = () => {
  const chain: any = {};
  for (const method of ["select", "eq", "gte", "order", "limit", "single", "insert"]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  // Make it thenable
  chain.then = (resolve: any) => resolve({ data: mockData, error: mockError });
  return chain;
};

const mockFrom = vi.fn().mockImplementation(() => createChain());

vi.mock("../../src/db/client.js", () => ({
  getSupabase: () => ({ from: mockFrom }),
}));

import { get24hVolume, getGlobalRecentTrades, getRecentTrades } from "../../src/db/queries.js";

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("DB Queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockData = [];
    mockError = null;
  });

  describe("get24hVolume", () => {
    it("returns BigInt string and trade count", async () => {
      mockData = [
        { size: "1000000000000000000" },
        { size: "2000000000000000000" },
        { size: "-500000000000000000" },
      ];

      const result = await get24hVolume("someSlab");
      expect(result.volume).toBe("3500000000000000000"); // abs values summed
      expect(result.tradeCount).toBe(3);
    });

    it("returns zero for no trades", async () => {
      mockData = [];
      const result = await get24hVolume("someSlab");
      expect(result.volume).toBe("0");
      expect(result.tradeCount).toBe(0);
    });
  });

  describe("getGlobalRecentTrades", () => {
    it("queries with created_at desc ordering", async () => {
      mockData = [{ id: "1", created_at: "2026-01-02" }, { id: "2", created_at: "2026-01-01" }];

      const result = await getGlobalRecentTrades(50);
      expect(result).toHaveLength(2);
      // Verify from("trades") was called
      expect(mockFrom).toHaveBeenCalledWith("trades");
    });
  });

  describe("getRecentTrades", () => {
    it("returns trades for a slab", async () => {
      mockData = [{ id: "1", slab_address: "abc", created_at: "2026-01-01" }];

      const result = await getRecentTrades("abc", 10);
      expect(result).toHaveLength(1);
      expect(mockFrom).toHaveBeenCalledWith("trades");
    });
  });
});
