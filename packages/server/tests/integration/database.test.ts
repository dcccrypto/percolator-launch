/**
 * Database Integration Tests
 * Tests database operations including trade deduplication (BH8)
 * 
 * Coverage:
 * - Trade insertion
 * - Trade deduplication (BH8: unique constraint handling)
 * - Trade queries by signature
 * - Recent trades retrieval
 * - Market queries
 * - Oracle price storage
 * 
 * NOTE: Requires real Supabase test instance with proper schema
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  insertTrade,
  tradeExistsBySignature,
  getRecentTrades,
  getMarkets,
  getMarketBySlabAddress,
  insertOraclePrice,
  getPriceHistory,
  upsertMarketStats,
  type TradeRow,
  type OraclePriceRow,
  type MarketStatsRow,
} from "../../src/db/queries.js";
import { config } from "../../src/config.js";

// Skip all database tests if Supabase credentials are not configured
const skipTests = !config.supabaseUrl || !config.supabaseKey;

describe("Database Integration Tests", () => {
  const testSlabAddress = "TestSlabAddress" + Date.now();
  const testTrader = "TestTrader" + Date.now();
  const testTxSignature = "TestSignature" + Date.now();

  beforeAll(async () => {
    if (skipTests) {
      console.log("⚠️  Skipping database tests: SUPABASE_URL and SUPABASE_KEY not set");
      return;
    }
    
    // Verify database connection
    const { getSupabase } = await import("../../src/db/client.js");
    const supabase = getSupabase();
    const { error } = await supabase.from("markets").select("count").limit(1);
    if (error) {
      console.warn("Database connection failed. Tests may fail:", error.message);
    }
  });

  afterAll(async () => {
    if (skipTests) return;
    
    // Cleanup test data
    const { getSupabase } = await import("../../src/db/client.js");
    const supabase = getSupabase();
    
    try {
      await supabase.from("trades").delete().eq("trader", testTrader);
      await supabase.from("oracle_prices").delete().eq("slab_address", testSlabAddress);
      await supabase.from("market_stats").delete().eq("slab_address", testSlabAddress);
    } catch (err) {
      console.warn("Cleanup failed:", err);
    }
  });

  /**
   * Test: Trade insertion
   * Should successfully insert a trade record
   */
  it.skipIf(skipTests)("should insert a trade successfully", async () => {
    const trade = {
      slab_address: testSlabAddress,
      trader: testTrader,
      side: "long" as const,
      size: "1000000",
      price: 100.5,
      fee: 0.01,
      tx_signature: testTxSignature,
    };

    await expect(insertTrade(trade)).resolves.not.toThrow();

    // Verify trade was inserted
    const exists = await tradeExistsBySignature(testTxSignature);
    expect(exists).toBe(true);
  });

  /**
   * BH8: Trade deduplication
   * Should handle duplicate trade insertion gracefully (unique constraint violation)
   * Error code 23505 should be ignored, allowing safe retries
   */
  it.skipIf(skipTests)("BH8: should handle duplicate trade insertion without throwing", async () => {
    const trade = {
      slab_address: testSlabAddress,
      trader: testTrader,
      side: "short" as const,
      size: "2000000",
      price: 99.5,
      fee: 0.02,
      tx_signature: testTxSignature + "_duplicate",
    };

    // Insert once
    await insertTrade(trade);

    // Insert duplicate - should not throw (BH8)
    await expect(insertTrade(trade)).resolves.not.toThrow();

    // Verify only one record exists
    const trades = await getRecentTrades(testSlabAddress, 100);
    const duplicateTrades = trades.filter(
      (t) => t.tx_signature === trade.tx_signature
    );
    expect(duplicateTrades.length).toBe(1);
  });

  /**
   * Test: Check trade existence by signature
   * Should correctly identify existing and non-existing trades
   */
  it.skipIf(skipTests)("should check if trade exists by signature", async () => {
    const existingSignature = testTxSignature;
    const nonExistingSignature = "NonExistentSignature" + Date.now();

    const exists = await tradeExistsBySignature(existingSignature);
    const notExists = await tradeExistsBySignature(nonExistingSignature);

    expect(exists).toBe(true);
    expect(notExists).toBe(false);
  });

  /**
   * Test: Get recent trades
   * Should retrieve trades for a specific market ordered by timestamp
   */
  it.skipIf(skipTests)("should retrieve recent trades for a market", async () => {
    const trades = await getRecentTrades(testSlabAddress, 10);

    expect(Array.isArray(trades)).toBe(true);
    expect(trades.length).toBeGreaterThan(0);
    
    // Verify trade structure
    trades.forEach((trade) => {
      expect(trade).toHaveProperty("slab_address");
      expect(trade).toHaveProperty("trader");
      expect(trade).toHaveProperty("side");
      expect(trade).toHaveProperty("size");
      expect(trade).toHaveProperty("price");
    });
  });

  /**
   * Test: Get all active markets
   * Should retrieve markets with status='active'
   */
  it.skipIf(skipTests)("should retrieve all active markets", async () => {
    const markets = await getMarkets();

    expect(Array.isArray(markets)).toBe(true);
    
    // All returned markets should be active
    markets.forEach((market) => {
      expect(market.status).toBe("active");
      expect(market).toHaveProperty("slab_address");
      expect(market).toHaveProperty("mint");
    });
  });

  /**
   * Test: Get market by slab address
   * Should retrieve specific market or return null if not found
   */
  it.skipIf(skipTests)("should retrieve market by slab address", async () => {
    // Test with non-existent address
    const nonExistent = await getMarketBySlabAddress("NonExistentSlabAddress" + Date.now());
    expect(nonExistent).toBeNull();

    // Test with existing market (if any exist)
    const markets = await getMarkets();
    if (markets.length > 0) {
      const firstMarket = markets[0];
      const found = await getMarketBySlabAddress(firstMarket.slab_address);
      expect(found).not.toBeNull();
      expect(found?.slab_address).toBe(firstMarket.slab_address);
    }
  });

  /**
   * Test: Insert oracle price
   * Should store oracle price updates
   */
  it.skipIf(skipTests)("should insert oracle price", async () => {
    const price: OraclePriceRow = {
      slab_address: testSlabAddress,
      price_e6: "100500000", // 100.5 * 1e6
      source: "test",
      timestamp: new Date().toISOString(),
    };

    await expect(insertOraclePrice(price)).resolves.not.toThrow();
  });

  /**
   * Test: Get price history
   * Should retrieve price history since a given timestamp
   */
  it.skipIf(skipTests)("should retrieve price history", async () => {
    const since = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago
    const history = await getPriceHistory(testSlabAddress, since);

    expect(Array.isArray(history)).toBe(true);
    
    // Verify price structure if any prices exist
    history.forEach((price) => {
      expect(price).toHaveProperty("slab_address");
      expect(price).toHaveProperty("price_e6");
      expect(price).toHaveProperty("source");
      expect(price).toHaveProperty("timestamp");
    });
  });

  /**
   * Test: Upsert market stats
   * Should insert or update market statistics
   */
  it.skipIf(skipTests)("should upsert market stats", async () => {
    const stats: Partial<MarketStatsRow> & { slab_address: string } = {
      slab_address: testSlabAddress,
      last_crank_at: new Date().toISOString(),
      crank_success_count: 10,
      crank_failure_count: 1,
      last_price_e6: "100500000",
    };

    await expect(upsertMarketStats(stats)).resolves.not.toThrow();

    // Update again (upsert should work)
    const updatedStats = {
      ...stats,
      crank_success_count: 20,
    };

    await expect(upsertMarketStats(updatedStats)).resolves.not.toThrow();
  });

  /**
   * Test: Trade query edge cases
   * Should handle edge cases like empty results and large limits
   */
  it.skipIf(skipTests)("should handle trade query edge cases", async () => {
    // Non-existent market should return empty array
    const noTrades = await getRecentTrades("NonExistentMarket" + Date.now(), 10);
    expect(noTrades).toEqual([]);

    // Large limit should work
    const manyTrades = await getRecentTrades(testSlabAddress, 1000);
    expect(Array.isArray(manyTrades)).toBe(true);
  });

  /**
   * Test: Invalid data handling
   * Should throw errors for invalid data (not silently ignore)
   */
  it.skipIf(skipTests)("should validate required fields in trade insertion", async () => {
    const { getSupabase } = await import("../../src/db/client.js");
    
    // Missing required fields should cause database error
    const invalidTrade = {
      slab_address: testSlabAddress,
      // Missing trader, side, size, price, fee
    } as any;

    // This should throw because required fields are missing
    await expect(
      getSupabase().from("trades").insert(invalidTrade)
    ).rejects.toThrow();
  });

  /**
   * Test: Concurrent insertions
   * Should handle multiple simultaneous insertions
   */
  it.skipIf(skipTests)("should handle concurrent trade insertions", async () => {
    const trades = Array.from({ length: 5 }, (_, i) => ({
      slab_address: testSlabAddress,
      trader: testTrader,
      side: (i % 2 === 0 ? "long" : "short") as const,
      size: String((i + 1) * 1000000),
      price: 100 + i,
      fee: 0.01,
      tx_signature: `ConcurrentTx${Date.now()}_${i}`,
    }));

    // Insert all trades concurrently
    const insertions = trades.map((trade) => insertTrade(trade));
    await expect(Promise.all(insertions)).resolves.not.toThrow();

    // Verify all were inserted
    for (const trade of trades) {
      const exists = await tradeExistsBySignature(trade.tx_signature!);
      expect(exists).toBe(true);
    }
  });
});
