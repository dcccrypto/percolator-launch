import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';

// Mock fetch globally
global.fetch = vi.fn();

// Mock external dependencies
vi.mock('@percolator/sdk', () => ({
  encodePushOraclePrice: vi.fn(() => Buffer.from([1, 2, 3])),
  buildAccountMetas: vi.fn(() => []),
  buildIx: vi.fn(() => ({})),
  ACCOUNTS_PUSH_ORACLE_PRICE: {},
}));

vi.mock('@percolator/shared', () => ({
  config: {
    programId: '11111111111111111111111111111111',
    crankKeypair: 'mock-keypair-path',
  },
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  getConnection: vi.fn(() => ({
    getAccountInfo: vi.fn(),
  })),
  loadKeypair: vi.fn(() => ({
    publicKey: new PublicKey('11111111111111111111111111111111'),
    secretKey: new Uint8Array(64),
  })),
  sendWithRetry: vi.fn(async () => 'mock-signature'),
  eventBus: {
    publish: vi.fn(),
  },
}));

import { OracleService } from '../../src/services/oracle.js';
import * as shared from '@percolator/shared';

describe('OracleService', () => {
  let oracleService: OracleService;

  beforeEach(() => {
    vi.clearAllMocks();
    oracleService = new OracleService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fetchDexScreenerPrice', () => {
    it('should fetch and parse DexScreener price', async () => {
      const mockResponse = {
        pairs: [
          {
            priceUsd: '1.23',
            liquidity: { usd: 100000 },
          },
        ],
      };

      vi.mocked(fetch).mockResolvedValueOnce({
        json: async () => mockResponse,
      } as any);

      const price = await oracleService.fetchDexScreenerPrice('MINT_UNIQUE_1');

      expect(price).toBe(1_230_000n); // 1.23 * 1_000_000
      expect(fetch).toHaveBeenCalledWith(
        'https://api.dexscreener.com/latest/dex/tokens/MINT_UNIQUE_1',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('should return null on fetch error', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error('Network error'));

      const price = await oracleService.fetchDexScreenerPrice('MINT_ERROR');

      expect(price).toBeNull();
    });

    it('should return null for invalid price data', async () => {
      const mockResponse = {
        pairs: [
          {
            priceUsd: 'invalid',
            liquidity: { usd: 100000 },
          },
        ],
      };

      vi.mocked(fetch).mockResolvedValueOnce({
        json: async () => mockResponse,
      } as any);

      const price = await oracleService.fetchDexScreenerPrice('MINT_INVALID');

      expect(price).toBeNull();
    });

    it('should handle timeout with AbortController', async () => {
      vi.mocked(fetch).mockImplementationOnce(() => {
        return new Promise((_, reject) => {
          const error = new Error('Aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });

      const price = await oracleService.fetchDexScreenerPrice('MINT_TIMEOUT');

      expect(price).toBeNull();
    });
  });

  describe('DexScreener cache', () => {
    it('should cache responses and return cached value within TTL', async () => {
      const mockResponse = {
        pairs: [
          {
            priceUsd: '2.50',
            liquidity: { usd: 200000 },
          },
        ],
      };

      let callCount = 0;
      vi.mocked(fetch).mockImplementation(async () => {
        callCount++;
        return { json: async () => mockResponse } as any;
      });

      // First call - should fetch
      const price1 = await oracleService.fetchDexScreenerPrice('MINT_CACHE_TEST');
      
      // Second call within TTL - should use cache
      const price2 = await oracleService.fetchDexScreenerPrice('MINT_CACHE_TEST');
      
      expect(callCount).toBe(1); // Should only fetch once
      expect(price1).toBe(price2);
    });

    it('should refetch after cache TTL expires', async () => {
      const mockResponse1 = {
        pairs: [{ priceUsd: '1.00', liquidity: { usd: 100000 } }],
      };
      const mockResponse2 = {
        pairs: [{ priceUsd: '2.00', liquidity: { usd: 200000 } }],
      };

      let callCount = 0;
      vi.mocked(fetch).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return { json: async () => mockResponse1 } as any;
        }
        return { json: async () => mockResponse2 } as any;
      });

      // First call
      const price1 = await oracleService.fetchDexScreenerPrice('MINT_TTL_TEST');
      expect(price1).toBe(1_000_000n);

      // Wait for cache to expire
      await new Promise(resolve => setTimeout(resolve, 11_000));

      // Second call - should refetch
      const price2 = await oracleService.fetchDexScreenerPrice('MINT_TTL_TEST');
      expect(price2).toBe(2_000_000n);
      expect(callCount).toBe(2);
    }, 15000);
  });

  describe('fetchJupiterPrice', () => {
    it('should fetch and parse Jupiter price', async () => {
      const mintId = 'MINT_JUP_TEST';
      const mockResponse = {
        data: {
          [mintId]: { price: '5.67' },
        },
      };

      vi.mocked(fetch).mockResolvedValueOnce({
        json: async () => mockResponse,
      } as any);

      const price = await oracleService.fetchJupiterPrice(mintId);

      expect(price).toBe(5_670_000n); // 5.67 * 1_000_000
      expect(fetch).toHaveBeenCalledWith(
        `https://api.jup.ag/price/v2?ids=${mintId}`,
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('should return null on fetch error', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error('API error'));

      const price = await oracleService.fetchJupiterPrice('MINT_JUP_ERROR');

      expect(price).toBeNull();
    });
  });

  describe('cross-source deviation check', () => {
    it('should reject prices with >10% divergence between sources', async () => {
      // DexScreener: $1.00
      const dexResponse = {
        pairs: [{ priceUsd: '1.00', liquidity: { usd: 100000 } }],
      };

      // Jupiter: $1.50 (50% divergence)
      const jupResponse = {
        data: {
          MINT999: { price: '1.50' },
        },
      };

      vi.mocked(fetch)
        .mockResolvedValueOnce({ json: async () => dexResponse } as any)
        .mockResolvedValueOnce({ json: async () => jupResponse } as any);

      const priceEntry = await oracleService.fetchPrice('MINT999', 'SLAB999');

      expect(priceEntry).toBeNull(); // Rejected due to divergence
    });

    it('should accept prices with <10% divergence', async () => {
      // DexScreener: $1.00
      const dexResponse = {
        pairs: [{ priceUsd: '1.00', liquidity: { usd: 100000 } }],
      };

      // Jupiter: $1.05 (5% divergence)
      const jupResponse = {
        data: {
          MINT888: { price: '1.05' },
        },
      };

      vi.mocked(fetch)
        .mockResolvedValueOnce({ json: async () => dexResponse } as any)
        .mockResolvedValueOnce({ json: async () => jupResponse } as any);

      const priceEntry = await oracleService.fetchPrice('MINT888', 'SLAB888');

      expect(priceEntry).not.toBeNull();
      expect(priceEntry?.priceE6).toBe(1_000_000n); // Uses DexScreener (preferred)
    });
  });

  describe('historical price deviation check', () => {
    it('should reject price with >30% deviation from last known price', async () => {
      // Seed history with $1.00 for SLAB_HISTDEV
      vi.mocked(fetch)
        .mockResolvedValueOnce({
          json: async () => ({ pairs: [{ priceUsd: '1.00', liquidity: { usd: 100000 } }] }),
        } as any)
        .mockResolvedValueOnce({
          json: async () => ({ data: { MINT_HISTDEV_A: { price: '1.00' } } }),
        } as any);

      const price1 = await oracleService.fetchPrice('MINT_HISTDEV_A', 'SLAB_HISTDEV');
      expect(price1?.priceE6).toBe(1_000_000n);

      // Use a different mint to bypass the 10s DexScreener cache,
      // but the SAME slabAddress so the history is shared.
      // Both sources return $1.50 (50% above history) — passes cross-source check
      // but fails the >30% historical deviation check.
      vi.mocked(fetch)
        .mockResolvedValueOnce({
          json: async () => ({ pairs: [{ priceUsd: '1.50', liquidity: { usd: 100000 } }] }),
        } as any)
        .mockResolvedValueOnce({
          json: async () => ({ data: { MINT_HISTDEV_B: { price: '1.50' } } }),
        } as any);

      const price2 = await oracleService.fetchPrice('MINT_HISTDEV_B', 'SLAB_HISTDEV');
      expect(price2).toBeNull(); // Rejected: 50% historical deviation > 30% threshold
    });

    it('should accept price within 30% of last known price', async () => {
      // Seed history with $1.00 for SLAB_HISTDEV2
      vi.mocked(fetch)
        .mockResolvedValueOnce({
          json: async () => ({ pairs: [{ priceUsd: '1.00', liquidity: { usd: 100000 } }] }),
        } as any)
        .mockResolvedValueOnce({
          json: async () => ({ data: { MINT_HISTDEV2_A: { price: '1.00' } } }),
        } as any);

      const price1 = await oracleService.fetchPrice('MINT_HISTDEV2_A', 'SLAB_HISTDEV2');
      expect(price1?.priceE6).toBe(1_000_000n);

      // New price = $1.20 (20% above history) — within 30% threshold → accepted
      vi.mocked(fetch)
        .mockResolvedValueOnce({
          json: async () => ({ pairs: [{ priceUsd: '1.20', liquidity: { usd: 100000 } }] }),
        } as any)
        .mockResolvedValueOnce({
          json: async () => ({ data: { MINT_HISTDEV2_B: { price: '1.20' } } }),
        } as any);

      const price2 = await oracleService.fetchPrice('MINT_HISTDEV2_B', 'SLAB_HISTDEV2');
      expect(price2).not.toBeNull();
      expect(price2?.priceE6).toBe(1_200_000n);
    });

    it('should skip historical check when no prior history exists', async () => {
      // First call for a brand-new slab → no history → no deviation check → accepted
      vi.mocked(fetch)
        .mockResolvedValueOnce({
          json: async () => ({ pairs: [{ priceUsd: '9999.00', liquidity: { usd: 100000 } }] }),
        } as any)
        .mockResolvedValueOnce({
          json: async () => ({ data: { MINT_HISTDEV3: { price: '9999.00' } } }),
        } as any);

      const price = await oracleService.fetchPrice('MINT_HISTDEV3', 'SLAB_HISTDEV3_FRESH');
      expect(price).not.toBeNull();
      expect(price?.priceE6).toBe(9_999_000_000n);
    });
  });

  describe('rate limiting', () => {
    it('should respect rate limit for pushPrice', async () => {
      const mockMarketConfig: any = {
        collateralMint: new PublicKey('So11111111111111111111111111111111111111112'),
        oracleAuthority: new PublicKey('11111111111111111111111111111111'),
        authorityPriceE6: 1_000_000n,
      };

      vi.mocked(fetch).mockResolvedValue({
        json: async () => ({
          pairs: [{ priceUsd: '1.00', liquidity: { usd: 100000 } }],
        }),
      } as any);

      const slab = 'FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD';

      // First push should succeed
      const result1 = await oracleService.pushPrice(slab, mockMarketConfig);
      expect(result1).toBe(true);

      // Second push within rate limit should be skipped
      const result2 = await oracleService.pushPrice(slab, mockMarketConfig);
      expect(result2).toBe(false);
    });

    it('should allow pushPrice after rate limit expires', async () => {
      const mockMarketConfig: any = {
        collateralMint: new PublicKey('So11111111111111111111111111111111111111112'),
        oracleAuthority: new PublicKey('11111111111111111111111111111111'),
        authorityPriceE6: 1_000_000n,
      };

      vi.mocked(fetch).mockResolvedValue({
        json: async () => ({
          pairs: [{ priceUsd: '1.00', liquidity: { usd: 100000 } }],
        }),
      } as any);

      const slab = 'FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn';

      // First push
      await oracleService.pushPrice(slab, mockMarketConfig);

      // Wait past rate limit
      await new Promise(resolve => setTimeout(resolve, 6_000));

      // Second push should succeed
      const result = await oracleService.pushPrice(slab, mockMarketConfig);
      expect(result).toBe(true);
    }, 10000);
  });

  describe('price history tracking', () => {
    it('should track price history up to max entries per market', async () => {
      const mockResponse = {
        pairs: [{ priceUsd: '1.00', liquidity: { usd: 100000 } }],
      };

      vi.mocked(fetch).mockResolvedValue({
        json: async () => mockResponse,
      } as any);

      const mint = 'MINT_HISTORY';
      const slab = 'SLAB_HISTORY';

      // Add 101 entries (max is 100)
      for (let i = 0; i < 101; i++) {
        await oracleService.fetchPrice(mint, slab);
      }

      const history = oracleService.getPriceHistory(slab);
      expect(history.length).toBe(100); // Capped at 100
    });

    it('should track up to max markets (500)', async () => {
      const mockResponse = {
        pairs: [{ priceUsd: '1.00', liquidity: { usd: 100000 } }],
      };

      vi.mocked(fetch).mockResolvedValue({
        json: async () => mockResponse,
      } as any);

      // Add first market
      await oracleService.fetchPrice('MINT0', 'SLAB0');
      expect(oracleService.getPriceHistory('SLAB0').length).toBe(1);

      // Add 500 more markets (total 501)
      for (let i = 1; i <= 500; i++) {
        await oracleService.fetchPrice(`MINT${i}`, `SLAB${i}`);
      }

      // The eviction logic runs when we ADD the 501st market
      // At that point, SLAB0 (oldest) should be evicted
      const history0 = oracleService.getPriceHistory('SLAB0');
      expect(history0.length).toBe(0); // Evicted

      // But the newest market should still be there
      const history500 = oracleService.getPriceHistory('SLAB500');
      expect(history500.length).toBe(1);
    });
  });

  describe('in-flight request deduplication', () => {
    it('should deduplicate concurrent DexScreener requests', async () => {
      const mockResponse = {
        pairs: [{ priceUsd: '3.14', liquidity: { usd: 100000 } }],
      };

      let fetchCount = 0;
      vi.mocked(fetch).mockImplementation(async () => {
        fetchCount++;
        await new Promise(resolve => setTimeout(resolve, 100));
        return { json: async () => mockResponse } as any;
      });

      // Make concurrent requests
      const promises = [
        oracleService.fetchDexScreenerPrice('MINT_DEDUP'),
        oracleService.fetchDexScreenerPrice('MINT_DEDUP'),
        oracleService.fetchDexScreenerPrice('MINT_DEDUP'),
      ];

      const results = await Promise.all(promises);

      // All should get the same result
      expect(results[0]).toBe(results[1]);
      expect(results[1]).toBe(results[2]);

      // But fetch should only be called once
      expect(fetchCount).toBe(1);
    });

    it('should deduplicate concurrent Jupiter requests', async () => {
      const mockResponse = {
        data: { MINT_JUP_DEDUP: { price: '2.71' } },
      };

      let fetchCount = 0;
      vi.mocked(fetch).mockImplementation(async () => {
        fetchCount++;
        await new Promise(resolve => setTimeout(resolve, 100));
        return { json: async () => mockResponse } as any;
      });

      // Make concurrent requests
      const promises = [
        oracleService.fetchJupiterPrice('MINT_JUP_DEDUP'),
        oracleService.fetchJupiterPrice('MINT_JUP_DEDUP'),
        oracleService.fetchJupiterPrice('MINT_JUP_DEDUP'),
      ];

      const results = await Promise.all(promises);

      // All should get the same result
      expect(results[0]).toBe(results[1]);
      expect(results[1]).toBe(results[2]);

      // But fetch should only be called once
      expect(fetchCount).toBe(1);
    });
  });

  describe('getCurrentPrice', () => {
    it('should return latest price from history', async () => {
      const mockResponse = {
        pairs: [{ priceUsd: '4.56', liquidity: { usd: 100000 } }],
      };

      vi.mocked(fetch).mockResolvedValue({
        json: async () => mockResponse,
      } as any);

      const mint = 'MINT_CURRENT';
      const slab = 'SLAB_CURRENT';

      await oracleService.fetchPrice(mint, slab);

      const current = oracleService.getCurrentPrice(slab);
      expect(current?.priceE6).toBe(4_560_000n);
    });

    it('should return null for market with no history', () => {
      const current = oracleService.getCurrentPrice('UNKNOWN_SLAB');
      expect(current).toBeNull();
    });
  });
});
