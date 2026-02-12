/**
 * Unit Tests: Oracle Service
 * Tests ORACLE-001 through ORACLE-007 from TEST_PLAN.md
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { OracleService } from "../../src/services/oracle.js";
import { PublicKey, Keypair } from "@solana/web3.js";
import type { MarketConfig } from "@percolator/core";

// Mock external dependencies
vi.mock("../../src/utils/solana.js", () => ({
  getConnection: vi.fn(() => ({
    confirmTransaction: vi.fn(),
    sendRawTransaction: vi.fn(),
  })),
  loadKeypair: vi.fn(),
  sendWithRetry: vi.fn(async () => "mock-signature"),
}));

vi.mock("../../src/config.js", () => ({
  config: {
    crankKeypair: "mock-keypair-path",
    programId: "MockProgram11111111111111111111111111111",
    rpcUrl: "https://api.devnet.solana.com",
  },
}));

vi.mock("../../src/services/events.js", () => ({
  eventBus: {
    publish: vi.fn(),
    on: vi.fn(),
  },
}));

describe("OracleService", () => {
  let oracleService: OracleService;
  let mockMarketConfig: MarketConfig;
  let mockKeypair: Keypair;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    
    oracleService = new OracleService();
    mockKeypair = Keypair.generate();

    // Create a valid market config
    mockMarketConfig = {
      oracleAuthority: mockKeypair.publicKey,
      collateralMint: new PublicKey("So11111111111111111111111111111111111111112"), // SOL
      authorityPriceE6: 100_000_000n, // $100
      maxLeverage: 10n,
      maintenanceMarginBps: 500n, // 5%
      takerFeeBps: 10n,
      makerFeeBps: 5n,
      flags: 0n,
    } as MarketConfig;

    // Mock loadKeypair to return our test keypair
    const { loadKeypair } = await import("../../src/utils/solana.js");
    vi.mocked(loadKeypair).mockReturnValue(mockKeypair);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  /**
   * ORACLE-002: Unauthorized price update (CRITICAL)
   * Type: Security
   * AC1: Oracle authority is validated before price update
   */
  it("ORACLE-002: should reject price update from unauthorized keypair", async () => {
    const slabAddress = Keypair.generate().publicKey.toBase58();
    const wrongAuthority = Keypair.generate();

    // Create config with different authority
    const invalidConfig = {
      ...mockMarketConfig,
      oracleAuthority: wrongAuthority.publicKey,
    };

    // Mock DexScreener response
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: async () => ({
        pairs: [{ priceUsd: "100", liquidity: { usd: 1_000_000 } }],
      }),
    }));

    // Should throw authority validation error
    const result = await oracleService.pushPrice(slabAddress, invalidConfig);
    
    // pushPrice catches the error and returns false
    expect(result).toBe(false);
  });

  /**
   * ORACLE-003: DexScreener timeout
   * Type: Integration
   * AC2: DexScreener API calls timeout after 10s
   */
  it("ORACLE-003: should timeout DexScreener API call after 10s", { timeout: 15000 }, async () => {
    const mint = Keypair.generate().publicKey.toBase58(); // Unique mint to avoid cache

    // Mock fetch with AbortController support
    let abortCalled = false;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, options?: any) => {
      return new Promise((resolve, reject) => {
        if (options?.signal) {
          options.signal.addEventListener("abort", () => {
            abortCalled = true;
            reject(new DOMException("Aborted", "AbortError"));
          });
        }
        // Never resolve - simulate slow request
        setTimeout(() => {
          resolve({
            json: async () => ({ pairs: [{ priceUsd: "100", liquidity: { usd: 1_000_000 } }] })
          });
        }, 20_000);
      });
    }));

    const price = await oracleService.fetchDexScreenerPrice(mint);
    
    // Should timeout and return null
    expect(price).toBeNull();
    expect(abortCalled).toBe(true);
  });

  /**
   * ORACLE-004: Cache race condition
   * Type: Unit
   * AC3: Cache race conditions are prevented
   */
  it("ORACLE-004: should prevent cache race conditions with concurrent requests", async () => {
    const mint = Keypair.generate().publicKey.toBase58(); // Unique mint to avoid cache
    
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      callCount++;
      // Simulate delay
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        json: async () => ({
          pairs: [{ priceUsd: "100", liquidity: { usd: 1_000_000 } }],
        }),
      };
    }));

    // Make 3 concurrent requests
    const [price1, price2, price3] = await Promise.all([
      oracleService.fetchDexScreenerPrice(mint),
      oracleService.fetchDexScreenerPrice(mint),
      oracleService.fetchDexScreenerPrice(mint),
    ]);

    // All should return the same price
    expect(price1).toBe(100_000_000n);
    expect(price2).toBe(100_000_000n);
    expect(price3).toBe(100_000_000n);

    // Fetch should only be called once (deduplication working)
    expect(callCount).toBe(1);
  });

  /**
   * ORACLE-005: Negative price rejection
   * Type: Unit
   * AC4: Invalid prices are rejected (negative, zero, NaN)
   */
  it("ORACLE-005: should reject negative price", async () => {
    const mint = Keypair.generate().publicKey.toBase58(); // Unique mint to avoid cache

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: async () => ({
        pairs: [{ priceUsd: "-100", liquidity: { usd: 1_000_000 } }],
      }),
    }));

    const price = await oracleService.fetchDexScreenerPrice(mint);
    
    // Negative price should be rejected
    expect(price).toBeNull();
  });

  /**
   * ORACLE-006: Zero price rejection
   * Type: Unit
   * AC4: Invalid prices are rejected (negative, zero, NaN)
   */
  it("ORACLE-006: should reject zero price", async () => {
    const mint = Keypair.generate().publicKey.toBase58(); // Unique mint to avoid cache

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: async () => ({
        pairs: [{ priceUsd: "0", liquidity: { usd: 1_000_000 } }],
      }),
    }));

    const price = await oracleService.fetchDexScreenerPrice(mint);
    
    // Zero price should be rejected
    expect(price).toBeNull();
  });

  /**
   * ORACLE-007: NaN price rejection
   * Type: Unit
   * AC4: Invalid prices are rejected (negative, zero, NaN)
   */
  it("ORACLE-007: should reject NaN price", async () => {
    const mint = Keypair.generate().publicKey.toBase58(); // Unique mint to avoid cache

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: async () => ({
        pairs: [{ priceUsd: "not-a-number", liquidity: { usd: 1_000_000 } }],
      }),
    }));

    const price = await oracleService.fetchDexScreenerPrice(mint);
    
    // NaN price should be rejected
    expect(price).toBeNull();
  });

  /**
   * Additional test: Empty pairs array
   */
  it("should handle empty pairs array", async () => {
    const mint = Keypair.generate().publicKey.toBase58(); // Unique mint to avoid cache

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: async () => ({ pairs: [] }),
    }));

    const price = await oracleService.fetchDexScreenerPrice(mint);
    
    expect(price).toBeNull();
  });

  /**
   * Additional test: Jupiter fallback
   */
  it("should fallback to Jupiter when DexScreener fails", async () => {
    const mint = Keypair.generate().publicKey.toBase58(); // Unique mint to avoid cache
    const slabAddress = Keypair.generate().publicKey.toBase58();

    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      callCount++;
      if (url.includes("dexscreener")) {
        // DexScreener fails
        return { json: async () => ({ pairs: [] }) };
      } else if (url.includes("jup.ag")) {
        // Jupiter succeeds
        return {
          json: async () => ({
            data: {
              [mint]: { price: "95.50" },
            },
          }),
        };
      }
      throw new Error("Unexpected fetch");
    }));

    const priceEntry = await oracleService.fetchPrice(mint, slabAddress);
    
    expect(priceEntry).not.toBeNull();
    expect(priceEntry?.priceE6).toBe(95_500_000n);
    expect(priceEntry?.source).toBe("jupiter");
    expect(callCount).toBe(2); // DexScreener + Jupiter
  });

  /**
   * Additional test: Cached price fallback
   */
  it("should use cached price when both external sources fail (fresh cache)", async () => {
    const mint = Keypair.generate().publicKey.toBase58(); // Unique mint to avoid cache
    const slabAddress = Keypair.generate().publicKey.toBase58();

    // First, populate cache with a successful fetch
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: async () => ({
        pairs: [{ priceUsd: "100", liquidity: { usd: 1_000_000 } }],
      }),
    }));

    await oracleService.fetchPrice(mint, slabAddress);

    // Now make both sources fail
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: async () => ({ pairs: [] }),
    }));

    const priceEntry = await oracleService.fetchPrice(mint, slabAddress);
    
    expect(priceEntry).not.toBeNull();
    expect(priceEntry?.source).toBe("cached");
    expect(priceEntry?.priceE6).toBe(100_000_000n);
  });

  /**
   * Additional test: Stale cache rejection
   */
  it("should reject cached price older than 60s", async () => {
    const mint = Keypair.generate().publicKey.toBase58(); // Unique mint to avoid cache
    const slabAddress = Keypair.generate().publicKey.toBase58();

    // Populate cache
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: async () => ({
        pairs: [{ priceUsd: "100", liquidity: { usd: 1_000_000 } }],
      }),
    }));

    await oracleService.fetchPrice(mint, slabAddress);

    // Fast-forward time by 61 seconds
    vi.useFakeTimers();
    vi.advanceTimersByTime(61_000);

    // Now make external sources fail
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: async () => ({ pairs: [] }),
    }));

    const priceEntry = await oracleService.fetchPrice(mint, slabAddress);
    
    // Stale cache should be rejected
    expect(priceEntry).toBeNull();

    vi.useRealTimers();
  });
});
