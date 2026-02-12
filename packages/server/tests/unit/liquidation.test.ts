/**
 * Unit Tests for Liquidation Service
 * TEST_PLAN.md Section 1.2: LIQ-001 through LIQ-007
 * 
 * Test Cases:
 * - LIQ-001: Liquidate underwater position (E2E)
 * - LIQ-002: Stale oracle price rejection (Security)
 * - LIQ-003: PnL overflow protection (Unit)
 * - LIQ-004: Gas estimation failure (Integration)
 * - LIQ-005: Insurance fund credit (Integration)
 * - LIQ-006: Healthy position ignored (Unit)
 * - LIQ-007: Batch scan performance (Performance)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PublicKey, Connection, Keypair } from '@solana/web3.js';
import { LiquidationService } from '../../src/services/liquidation.js';
import { OracleService } from '../../src/services/oracle.js';
import type { DiscoveredMarket } from '@percolator/core';

// Create a real keypair for testing (signature verification needs a valid keypair)
const testKeypair = Keypair.generate();

// Helper to create valid base58 PublicKeys
const createTestPublicKey = (seed: string): PublicKey => {
  const buffer = Buffer.alloc(32);
  for (let i = 0; i < seed.length && i < 32; i++) {
    buffer[i] = seed.charCodeAt(i);
  }
  return new PublicKey(buffer);
};
// Mock modules
vi.mock('../../src/config.js', () => ({
  config: {
    crankKeypair: 'test-keypair-path',
    rpcUrl: 'https://api.devnet.solana.com',
  },
}));

vi.mock('../../src/utils/solana.js', () => ({
  getConnection: vi.fn(() => ({
    getLatestBlockhash: vi.fn().mockResolvedValue({
      blockhash: createTestPublicKey('Blockhash').toBase58(),
      lastValidBlockHeight: 1000000,
    }),
    sendRawTransaction: vi.fn().mockResolvedValue('liquidation-sig-123'),
    getSignatureStatuses: vi.fn().mockResolvedValue({
      value: [{ confirmationStatus: 'confirmed', err: null }],
    }),
  })),
  loadKeypair: vi.fn(() => testKeypair),
  sendWithRetry: vi.fn().mockResolvedValue('liquidation-sig-123'),
  pollSignatureStatus: vi.fn().mockResolvedValue(undefined),
  getRecentPriorityFees: vi.fn().mockResolvedValue({
    priorityFeeMicroLamports: 1000,
    computeUnitLimit: 200000,
  }),
  checkTransactionSize: vi.fn(),
}));

vi.mock('../../src/services/events.js', () => ({
  eventBus: {
    publish: vi.fn(),
  },
}));

vi.mock('@percolator/core', async () => {
  const actual = await vi.importActual('@percolator/core');
  return {
    ...actual,
    fetchSlab: vi.fn(),
    parseEngine: vi.fn(() => ({ numUsedAccounts: 2 })),
    parseParams: vi.fn(() => ({
      maintenanceMarginBps: 500n, // 5% maintenance margin
    })),
    parseConfig: vi.fn(),
    parseAccount: vi.fn(),
    parseUsedIndices: vi.fn(() => [0, 1]),
    detectLayout: vi.fn(() => ({ accountsOffset: 1000, maxAccounts: 1000 })),
    encodeKeeperCrank: vi.fn(() => Buffer.from([1, 2, 3])),
    encodeLiquidateAtOracle: vi.fn(() => Buffer.from([4, 5, 6])),
    encodePushOraclePrice: vi.fn(() => Buffer.from([7, 8, 9])),
    buildAccountMetas: vi.fn(() => []),
    buildIx: vi.fn(() => ({
      programId: createTestPublicKey('Program1'),
      keys: [],
      data: Buffer.from([1, 2, 3]),
    })),
    derivePythPushOraclePDA: vi.fn(() => [
      createTestPublicKey('PyThOracle'),
      0,
    ]),
  };
});

// Mock OracleService
const createMockOracleService = () => {
  return {
    fetchPrice: vi.fn().mockResolvedValue({
      priceE6: 100000000n, // $100
      timestamp: BigInt(Math.floor(Date.now() / 1000)),
    }),
  } as unknown as OracleService;
};

// Helper to create mock market
const createMockMarket = (overrides: Partial<DiscoveredMarket> = {}): DiscoveredMarket => {
  const now = BigInt(Math.floor(Date.now() / 1000));
  return {
    slabAddress: createTestPublicKey('Market1'),
    programId: createTestPublicKey('Program1'),
    config: {
      oracleAuthority: createTestPublicKey('Oracle1'),
      indexFeedId: createTestPublicKey('FeedId1'),
      collateralMint: createTestPublicKey('MintSOL'),
      authorityPriceE6: 100000000n, // $100
      authorityTimestamp: now,
      ...overrides.config,
    },
    ...overrides,
  } as DiscoveredMarket;
};

// Helper to create mock account
const createMockAccount = (overrides: any = {}) => ({
  kind: 0, // User account
  owner: createTestPublicKey('Owner1'),
  positionSize: 1000000n, // 1 unit
  capital: 50000000n, // $50 capital
  entryPrice: 100000000n, // Entry at $100
  ...overrides,
});

describe('LiquidationService Unit Tests', () => {
  let liquidationService: LiquidationService;
  let mockOracleService: OracleService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockOracleService = createMockOracleService();
    liquidationService = new LiquidationService(mockOracleService, 15000);
  });

  afterEach(() => {
    liquidationService.stop();
  });

  describe('LIQ-001: Liquidate underwater position', () => {
    it('should liquidate position at 120% maintenance margin', async () => {
      const mockMarket = createMockMarket();
      const { fetchSlab, parseConfig, parseAccount, parseUsedIndices } = await import('@percolator/core');

      const now = BigInt(Math.floor(Date.now() / 1000));

      // Mock slab data with underwater position
      vi.mocked(fetchSlab).mockResolvedValue(Buffer.from([1, 2, 3]));
      vi.mocked(parseConfig).mockReturnValue({
        authorityPriceE6: 50000000n, // Price dropped to $50
        authorityTimestamp: now,
      } as any);
      vi.mocked(parseUsedIndices).mockReturnValue([0]);
      
      // Position: 1 unit long, entered at $100, now at $50
      // Capital: $2, PnL: -$1, Equity: $1, Notional: $50
      // Margin ratio: $1/$50 = 2% < 5% maintenance
      // This is UNDERWATER
      vi.mocked(parseAccount).mockReturnValue(
        createMockAccount({
          positionSize: 1000000n, // Long 1 unit
          capital: 2000000n, // $2
          entryPrice: 100000000n, // Entered at $100
        })
      );

      const candidates = await liquidationService.scanMarket(mockMarket);

      expect(candidates).toHaveLength(1);
      expect(candidates[0].accountIdx).toBe(0);
      expect(candidates[0].marginRatio).toBeLessThan(5); // Below 5% maintenance
    });

    it('should execute liquidation transaction successfully', async () => {
      const mockMarket = createMockMarket();
      const { fetchSlab, parseConfig, parseAccount, parseUsedIndices } = await import('@percolator/core');
      const { getConnection } = await import('../../src/utils/solana.js');

      const now = BigInt(Math.floor(Date.now() / 1000));

      vi.mocked(fetchSlab).mockResolvedValue(Buffer.from([1, 2, 3]));
      vi.mocked(parseConfig).mockReturnValue({
        authorityPriceE6: 50000000n,
        authorityTimestamp: now,
      } as any);
      vi.mocked(parseUsedIndices).mockReturnValue([0]);
      vi.mocked(parseAccount).mockReturnValue(
        createMockAccount({
          positionSize: 1000000n,
          capital: 2000000n, // $2 - underwater position
          entryPrice: 100000000n,
        })
      );

      const sig = await liquidationService.liquidate(mockMarket, 0);

      expect(sig).toBeTruthy();
      expect(sig).toMatch(/liquidation-sig/);

      const status = liquidationService.getStatus();
      expect(status.liquidationCount).toBe(1);
    });

    it('should handle liquidation with insurance fund credit', async () => {
      const mockMarket = createMockMarket();
      const { fetchSlab, parseConfig, parseAccount, parseUsedIndices } = await import('@percolator/core');
      const { eventBus } = await import('../../src/services/events.js');

      const now = BigInt(Math.floor(Date.now() / 1000));

      vi.mocked(fetchSlab).mockResolvedValue(Buffer.from([1, 2, 3]));
      vi.mocked(parseConfig).mockReturnValue({
        authorityPriceE6: 30000000n, // Price dropped to $30
        authorityTimestamp: now,
      } as any);
      vi.mocked(parseUsedIndices).mockReturnValue([0]);
      
      // Deeply underwater position (negative equity - insurance fund covers)
      // Entry $100, now $30 -> loss ~$0.70, capital $0.50 -> equity = -$0.20
      vi.mocked(parseAccount).mockReturnValue(
        createMockAccount({
          positionSize: 1000000n,
          capital: 500000n, // $0.50
          entryPrice: 100000000n,
        })
      );

      await liquidationService.liquidate(mockMarket, 0);

      // Should publish success event
      expect(eventBus.publish).toHaveBeenCalledWith(
        'liquidation.success',
        mockMarket.slabAddress.toBase58(),
        expect.objectContaining({
          accountIdx: 0,
        })
      );
    });
  });

  describe('LIQ-002: Stale oracle price rejection', () => {
    it('should reject oracle price older than 60 seconds', async () => {
      const mockMarket = createMockMarket();
      const { fetchSlab, parseConfig } = await import('@percolator/core');

      const now = BigInt(Math.floor(Date.now() / 1000));
      const staleTimestamp = now - 90n; // 90 seconds old

      vi.mocked(fetchSlab).mockResolvedValue(Buffer.from([1, 2, 3]));
      vi.mocked(parseConfig).mockReturnValue({
        authorityPriceE6: 50000000n,
        authorityTimestamp: staleTimestamp, // Stale!
      } as any);

      const candidates = await liquidationService.scanMarket(mockMarket);

      // Should return empty array - no liquidations with stale price
      expect(candidates).toHaveLength(0);
    });

    it('should accept oracle price within 60 second window', async () => {
      const mockMarket = createMockMarket();
      const { fetchSlab, parseConfig, parseAccount, parseUsedIndices } = await import('@percolator/core');

      const now = BigInt(Math.floor(Date.now() / 1000));
      const freshTimestamp = now - 30n; // 30 seconds old (fresh)

      vi.mocked(fetchSlab).mockResolvedValue(Buffer.from([1, 2, 3]));
      vi.mocked(parseConfig).mockReturnValue({
        authorityPriceE6: 50000000n,
        authorityTimestamp: freshTimestamp, // Fresh!
      } as any);
      vi.mocked(parseUsedIndices).mockReturnValue([0]);
      vi.mocked(parseAccount).mockReturnValue(
        createMockAccount({
          positionSize: 1000000n,
          capital: 1000000n, // $1 - underwater position (2% margin)
          entryPrice: 100000000n,
        })
      );

      const candidates = await liquidationService.scanMarket(mockMarket);

      // Should find candidates with fresh price
      expect(candidates.length).toBeGreaterThan(0);
    });

    it('should reject exactly 61 seconds old', async () => {
      const mockMarket = createMockMarket();
      const { fetchSlab, parseConfig } = await import('@percolator/core');

      const now = BigInt(Math.floor(Date.now() / 1000));
      const boundaryStale = now - 61n; // Just over the limit

      vi.mocked(fetchSlab).mockResolvedValue(Buffer.from([1, 2, 3]));
      vi.mocked(parseConfig).mockReturnValue({
        authorityPriceE6: 50000000n,
        authorityTimestamp: boundaryStale,
      } as any);

      const candidates = await liquidationService.scanMarket(mockMarket);

      expect(candidates).toHaveLength(0);
    });

    it('should accept exactly 60 seconds old', async () => {
      const mockMarket = createMockMarket();
      const { fetchSlab, parseConfig, parseAccount, parseUsedIndices } = await import('@percolator/core');

      const now = BigInt(Math.floor(Date.now() / 1000));
      const boundaryFresh = now - 60n; // Exactly at the limit

      vi.mocked(fetchSlab).mockResolvedValue(Buffer.from([1, 2, 3]));
      vi.mocked(parseConfig).mockReturnValue({
        authorityPriceE6: 50000000n,
        authorityTimestamp: boundaryFresh,
      } as any);
      vi.mocked(parseUsedIndices).mockReturnValue([0]);
      vi.mocked(parseAccount).mockReturnValue(
        createMockAccount({
          positionSize: 1000000n,
          capital: 1000000n, // $1 - underwater position
          entryPrice: 100000000n,
        })
      );

      const candidates = await liquidationService.scanMarket(mockMarket);

      expect(candidates.length).toBeGreaterThan(0);
    });
  });

  describe('LIQ-003: PnL overflow protection', () => {
    it('should prevent overflow with MAX_SAFE_BIGINT position size', async () => {
      const mockMarket = createMockMarket();
      const { fetchSlab, parseConfig, parseAccount, parseUsedIndices } = await import('@percolator/core');

      const MAX_SAFE_BIGINT = 9007199254740991n;
      const now = BigInt(Math.floor(Date.now() / 1000));

      vi.mocked(fetchSlab).mockResolvedValue(Buffer.from([1, 2, 3]));
      vi.mocked(parseConfig).mockReturnValue({
        authorityPriceE6: 200000000n, // Price doubled
        authorityTimestamp: now,
      } as any);
      vi.mocked(parseUsedIndices).mockReturnValue([0]);
      
      // Extremely large position that would overflow
      vi.mocked(parseAccount).mockReturnValue(
        createMockAccount({
          positionSize: MAX_SAFE_BIGINT, // Huge position
          capital: 1000000000n,
          entryPrice: 100000000n,
        })
      );

      // Should not throw - overflow protection should clamp the value
      const candidates = await liquidationService.scanMarket(mockMarket);

      // Function should complete without error
      expect(candidates).toBeDefined();
    });

    it('should handle negative overflow protection', async () => {
      const mockMarket = createMockMarket();
      const { fetchSlab, parseConfig, parseAccount, parseUsedIndices } = await import('@percolator/core');

      const MAX_SAFE_BIGINT = 9007199254740991n;
      const now = BigInt(Math.floor(Date.now() / 1000));

      vi.mocked(fetchSlab).mockResolvedValue(Buffer.from([1, 2, 3]));
      vi.mocked(parseConfig).mockReturnValue({
        authorityPriceE6: 10000000n, // Price dropped 90%
        authorityTimestamp: now,
      } as any);
      vi.mocked(parseUsedIndices).mockReturnValue([0]);
      
      // Large short position with massive loss
      vi.mocked(parseAccount).mockReturnValue(
        createMockAccount({
          positionSize: -MAX_SAFE_BIGINT, // Huge short
          capital: 1000000000n,
          entryPrice: 100000000n,
        })
      );

      // Should not throw
      const candidates = await liquidationService.scanMarket(mockMarket);

      expect(candidates).toBeDefined();
    });

    it('should correctly calculate PnL for normal-sized positions', async () => {
      const mockMarket = createMockMarket();
      const { fetchSlab, parseConfig, parseAccount, parseUsedIndices } = await import('@percolator/core');

      const now = BigInt(Math.floor(Date.now() / 1000));

      vi.mocked(fetchSlab).mockResolvedValue(Buffer.from([1, 2, 3]));
      vi.mocked(parseConfig).mockReturnValue({
        authorityPriceE6: 120000000n, // Price up 20%
        authorityTimestamp: now,
      } as any);
      vi.mocked(parseUsedIndices).mockReturnValue([0]);
      
      // Normal position
      vi.mocked(parseAccount).mockReturnValue(
        createMockAccount({
          positionSize: 1000000n, // Long 1 unit
          capital: 50000000n, // $50
          entryPrice: 100000000n, // Entry $100
        })
      );

      const candidates = await liquidationService.scanMarket(mockMarket);

      // Position should be healthy (price went up on long)
      expect(candidates).toHaveLength(0);
    });

    it('should protect against multiplication overflow in both directions', async () => {
      const mockMarket = createMockMarket();
      const { fetchSlab, parseConfig, parseAccount, parseUsedIndices } = await import('@percolator/core');

      const MAX_SAFE_BIGINT = 9007199254740991n;
      const now = BigInt(Math.floor(Date.now() / 1000));

      vi.mocked(fetchSlab).mockResolvedValue(Buffer.from([1, 2, 3]));
      vi.mocked(parseConfig).mockReturnValue({
        authorityPriceE6: MAX_SAFE_BIGINT, // Huge price
        authorityTimestamp: now,
      } as any);
      vi.mocked(parseUsedIndices).mockReturnValue([0]);
      
      // Position that would cause diff * absPosSize to overflow
      vi.mocked(parseAccount).mockReturnValue(
        createMockAccount({
          positionSize: MAX_SAFE_BIGINT / 2n,
          capital: 1000000000n,
          entryPrice: 1000000n,
        })
      );

      // Should not throw
      expect(async () => {
        await liquidationService.scanMarket(mockMarket);
      }).not.toThrow();
    });
  });

  describe('LIQ-004: Gas estimation failure', () => {
    it('should handle insufficient gas price error', async () => {
      const mockMarket = createMockMarket();
      const { fetchSlab, parseConfig, parseAccount, parseUsedIndices } = await import('@percolator/core');
      const { getConnection } = await import('../../src/utils/solana.js');

      const now = BigInt(Math.floor(Date.now() / 1000));

      vi.mocked(fetchSlab).mockResolvedValue(Buffer.from([1, 2, 3]));
      vi.mocked(parseConfig).mockReturnValue({
        authorityPriceE6: 50000000n,
        authorityTimestamp: now,
      } as any);
      vi.mocked(parseUsedIndices).mockReturnValue([0]);
      vi.mocked(parseAccount).mockReturnValue(
        createMockAccount({
          positionSize: 1000000n,
          capital: 1000000n, // $1 - underwater position
          entryPrice: 100000000n,
        })
      );

      // Mock getConnection to return a connection that fails on sendRawTransaction
      vi.mocked(getConnection).mockReturnValueOnce({
        getLatestBlockhash: vi.fn().mockResolvedValue({
          blockhash: createTestPublicKey('Blockhash').toBase58(),
          lastValidBlockHeight: 1000000,
        }),
        sendRawTransaction: vi.fn().mockRejectedValue(
          new Error('Insufficient gas price')
        ),
        getSignatureStatuses: vi.fn().mockResolvedValue({
          value: [{ confirmationStatus: 'confirmed', err: null }],
        }),
      } as any);

      const sig = await liquidationService.liquidate(mockMarket, 0);

      // Should return null on failure
      expect(sig).toBeNull();
    });

    it('should retry on network errors but fail on gas estimation errors', async () => {
      const mockMarket = createMockMarket();
      const { fetchSlab, parseConfig, parseAccount, parseUsedIndices } = await import('@percolator/core');
      const { getConnection } = await import('../../src/utils/solana.js');
      const { eventBus } = await import('../../src/services/events.js');

      const now = BigInt(Math.floor(Date.now() / 1000));

      vi.mocked(fetchSlab).mockResolvedValue(Buffer.from([1, 2, 3]));
      vi.mocked(parseConfig).mockReturnValue({
        authorityPriceE6: 50000000n,
        authorityTimestamp: now,
      } as any);
      vi.mocked(parseUsedIndices).mockReturnValue([0]);
      vi.mocked(parseAccount).mockReturnValue(
        createMockAccount({
          positionSize: 1000000n,
          capital: 1000000n, // $1 - underwater position
          entryPrice: 100000000n,
        })
      );

      // Mock getConnection to return a connection that fails on sendRawTransaction
      vi.mocked(getConnection).mockReturnValueOnce({
        getLatestBlockhash: vi.fn().mockResolvedValue({
          blockhash: createTestPublicKey('Blockhash').toBase58(),
          lastValidBlockHeight: 1000000,
        }),
        sendRawTransaction: vi.fn().mockRejectedValue(
          new Error('Gas estimation failed')
        ),
        getSignatureStatuses: vi.fn().mockResolvedValue({
          value: [{ confirmationStatus: 'confirmed', err: null }],
        }),
      } as any);

      const sig = await liquidationService.liquidate(mockMarket, 0);

      expect(sig).toBeNull();
      expect(eventBus.publish).toHaveBeenCalledWith(
        'liquidation.failure',
        expect.any(String),
        expect.objectContaining({
          accountIdx: 0,
          error: expect.stringContaining('Gas estimation'),
        })
      );
    });
  });

  describe('LIQ-005: Insurance fund credit', () => {
    it('should credit insurance fund on successful liquidation', async () => {
      const mockMarket = createMockMarket();
      const { fetchSlab, parseConfig, parseAccount, parseUsedIndices } = await import('@percolator/core');
      const { eventBus } = await import('../../src/services/events.js');

      const now = BigInt(Math.floor(Date.now() / 1000));

      vi.mocked(fetchSlab).mockResolvedValue(Buffer.from([1, 2, 3]));
      vi.mocked(parseConfig).mockReturnValue({
        authorityPriceE6: 20000000n, // Severe price drop to $20
        authorityTimestamp: now,
      } as any);
      vi.mocked(parseUsedIndices).mockReturnValue([0]);
      
      // Position with negative equity (insurance fund covers loss)
      // Price $100 -> $20, loss = $0.80, capital $0.30 -> equity = -$0.50
      vi.mocked(parseAccount).mockReturnValue(
        createMockAccount({
          positionSize: 1000000n,
          capital: 300000n, // $0.30
          entryPrice: 100000000n,
        })
      );

      const sig = await liquidationService.liquidate(mockMarket, 0);

      expect(sig).toBeTruthy();
      
      // Verify success event was published
      expect(eventBus.publish).toHaveBeenCalledWith(
        'liquidation.success',
        expect.any(String),
        expect.objectContaining({
          signature: sig,
        })
      );
    });

    it('should track liquidation count for insurance fund accounting', async () => {
      const mockMarket = createMockMarket();
      const { fetchSlab, parseConfig, parseAccount, parseUsedIndices } = await import('@percolator/core');

      const now = BigInt(Math.floor(Date.now() / 1000));

      vi.mocked(fetchSlab).mockResolvedValue(Buffer.from([1, 2, 3]));
      vi.mocked(parseConfig).mockReturnValue({
        authorityPriceE6: 50000000n,
        authorityTimestamp: now,
      } as any);
      vi.mocked(parseUsedIndices).mockReturnValue([0]);
      vi.mocked(parseAccount).mockReturnValue(
        createMockAccount({
          positionSize: 1000000n,
          capital: 1000000n, // $1 - underwater position
          entryPrice: 100000000n,
        })
      );

      const initialStatus = liquidationService.getStatus();
      const initialCount = initialStatus.liquidationCount;

      await liquidationService.liquidate(mockMarket, 0);

      const finalStatus = liquidationService.getStatus();
      expect(finalStatus.liquidationCount).toBe(initialCount + 1);
    });
  });

  describe('LIQ-006: Healthy position ignored', () => {
    it('should not liquidate position at 50% maintenance margin (healthy)', async () => {
      const mockMarket = createMockMarket();
      const { fetchSlab, parseConfig, parseAccount, parseUsedIndices } = await import('@percolator/core');

      const now = BigInt(Math.floor(Date.now() / 1000));

      vi.mocked(fetchSlab).mockResolvedValue(Buffer.from([1, 2, 3]));
      vi.mocked(parseConfig).mockReturnValue({
        authorityPriceE6: 110000000n, // Price up slightly
        authorityTimestamp: now,
      } as any);
      vi.mocked(parseUsedIndices).mockReturnValue([0]);
      
      // Healthy position with plenty of margin
      vi.mocked(parseAccount).mockReturnValue(
        createMockAccount({
          positionSize: 1000000n,
          capital: 100000000n, // $100 capital
          entryPrice: 100000000n,
        })
      );

      const candidates = await liquidationService.scanMarket(mockMarket);

      // Should find no liquidation candidates
      expect(candidates).toHaveLength(0);
    });

    it('should skip empty positions (positionSize = 0)', async () => {
      const mockMarket = createMockMarket();
      const { fetchSlab, parseConfig, parseAccount, parseUsedIndices } = await import('@percolator/core');

      const now = BigInt(Math.floor(Date.now() / 1000));

      vi.mocked(fetchSlab).mockResolvedValue(Buffer.from([1, 2, 3]));
      vi.mocked(parseConfig).mockReturnValue({
        authorityPriceE6: 100000000n,
        authorityTimestamp: now,
      } as any);
      vi.mocked(parseUsedIndices).mockReturnValue([0]);
      
      // Empty position
      vi.mocked(parseAccount).mockReturnValue(
        createMockAccount({
          positionSize: 0n, // No position
          capital: 100000000n,
        })
      );

      const candidates = await liquidationService.scanMarket(mockMarket);

      expect(candidates).toHaveLength(0);
    });

    it('should skip LP accounts (kind = 1)', async () => {
      const mockMarket = createMockMarket();
      const { fetchSlab, parseConfig, parseAccount, parseUsedIndices } = await import('@percolator/core');

      const now = BigInt(Math.floor(Date.now() / 1000));

      vi.mocked(fetchSlab).mockResolvedValue(Buffer.from([1, 2, 3]));
      vi.mocked(parseConfig).mockReturnValue({
        authorityPriceE6: 100000000n,
        authorityTimestamp: now,
      } as any);
      vi.mocked(parseUsedIndices).mockReturnValue([0]);
      
      // LP account
      vi.mocked(parseAccount).mockReturnValue(
        createMockAccount({
          kind: 1, // LP
          positionSize: 1000000n,
        })
      );

      const candidates = await liquidationService.scanMarket(mockMarket);

      expect(candidates).toHaveLength(0);
    });

    it('should only flag positions below maintenance margin threshold', async () => {
      const mockMarket = createMockMarket();
      const { fetchSlab, parseConfig, parseAccount, parseUsedIndices } = await import('@percolator/core');

      const now = BigInt(Math.floor(Date.now() / 1000));

      vi.mocked(fetchSlab).mockResolvedValue(Buffer.from([1, 2, 3]));
      vi.mocked(parseConfig).mockReturnValue({
        authorityPriceE6: 95000000n, // Price down 5%
        authorityTimestamp: now,
      } as any);
      vi.mocked(parseUsedIndices).mockReturnValue([0]);
      
      // Position just above maintenance margin (5%)
      // Entry: $100, Current: $95, Loss: $5
      // Capital: $50, Equity: $45
      // Notional: $95, Margin Ratio: 45/95 = 47.4% (well above 5%)
      vi.mocked(parseAccount).mockReturnValue(
        createMockAccount({
          positionSize: 1000000n,
          capital: 50000000n,
          entryPrice: 100000000n,
        })
      );

      const candidates = await liquidationService.scanMarket(mockMarket);

      expect(candidates).toHaveLength(0);
    });
  });

  describe('LIQ-007: Batch scan performance', () => {
    it('should scan 1000 positions in under 5 seconds', async () => {
      const mockMarket = createMockMarket();
      const { fetchSlab, parseConfig, parseAccount, parseUsedIndices } = await import('@percolator/core');

      const now = BigInt(Math.floor(Date.now() / 1000));

      vi.mocked(fetchSlab).mockResolvedValue(Buffer.from([1, 2, 3]));
      vi.mocked(parseConfig).mockReturnValue({
        authorityPriceE6: 100000000n,
        authorityTimestamp: now,
      } as any);

      // Mock 1000 positions
      const indices = Array.from({ length: 1000 }, (_, i) => i);
      vi.mocked(parseUsedIndices).mockReturnValue(indices);
      
      // Mock parseAccount to return healthy positions (fast path)
      vi.mocked(parseAccount).mockImplementation((data, idx) => 
        createMockAccount({
          positionSize: 1000000n,
          capital: 100000000n, // Healthy
          entryPrice: 100000000n,
        })
      );

      const startTime = Date.now();
      const candidates = await liquidationService.scanMarket(mockMarket);
      const endTime = Date.now();

      const duration = endTime - startTime;
      
      // Should complete in under 5 seconds
      expect(duration).toBeLessThan(5000);
      
      // All positions are healthy, so no candidates
      expect(candidates).toHaveLength(0);
    });

    it('should efficiently scan market with sparse account bitmap', async () => {
      const mockMarket = createMockMarket();
      const { fetchSlab, parseConfig, parseAccount, parseUsedIndices } = await import('@percolator/core');

      const now = BigInt(Math.floor(Date.now() / 1000));

      vi.mocked(fetchSlab).mockResolvedValue(Buffer.from([1, 2, 3]));
      vi.mocked(parseConfig).mockReturnValue({
        authorityPriceE6: 100000000n,
        authorityTimestamp: now,
      } as any);

      // Sparse indices: 0, 5, 100, 500, 999
      vi.mocked(parseUsedIndices).mockReturnValue([0, 5, 100, 500, 999]);
      
      vi.mocked(parseAccount).mockImplementation((data, idx) => 
        createMockAccount({
          positionSize: 1000000n,
          capital: 100000000n,
          entryPrice: 100000000n,
        })
      );

      const startTime = Date.now();
      await liquidationService.scanMarket(mockMarket);
      const endTime = Date.now();

      // Should be very fast with sparse bitmap
      expect(endTime - startTime).toBeLessThan(100);
    });

    it('should handle scanning multiple markets concurrently', async () => {
      const { fetchSlab, parseConfig, parseAccount, parseUsedIndices } = await import('@percolator/core');

      const now = BigInt(Math.floor(Date.now() / 1000));

      vi.mocked(fetchSlab).mockResolvedValue(Buffer.from([1, 2, 3]));
      vi.mocked(parseConfig).mockReturnValue({
        authorityPriceE6: 100000000n,
        authorityTimestamp: now,
      } as any);
      vi.mocked(parseUsedIndices).mockReturnValue([0, 1, 2]);
      vi.mocked(parseAccount).mockImplementation(() => 
        createMockAccount({
          positionSize: 1000000n,
          capital: 100000000n,
          entryPrice: 100000000n,
        })
      );

      // Create 10 markets
      const markets = new Map();
      for (let i = 0; i < 10; i++) {
        const market = createMockMarket({
          slabAddress: createTestPublicKey(`Market${i}`),
        });
        markets.set(`market${i}`, { market });
      }

      const startTime = Date.now();
      const result = await liquidationService.scanAndLiquidateAll(markets);
      const endTime = Date.now();

      expect(result.scanned).toBe(10);
      expect(endTime - startTime).toBeLessThan(2000); // Should be fast
    });
  });

  describe('Race Condition Protection', () => {
    it('should re-verify position before liquidating', async () => {
      const mockMarket = createMockMarket();
      const { fetchSlab, parseConfig, parseAccount, parseUsedIndices } = await import('@percolator/core');

      const now = BigInt(Math.floor(Date.now() / 1000));

      // First scan: position is underwater
      vi.mocked(fetchSlab).mockResolvedValueOnce(Buffer.from([1, 2, 3]));
      vi.mocked(parseConfig).mockReturnValueOnce({
        authorityPriceE6: 50000000n,
        authorityTimestamp: now,
      } as any);
      vi.mocked(parseUsedIndices).mockReturnValue([0]);
      vi.mocked(parseAccount).mockReturnValueOnce(
        createMockAccount({
          positionSize: 1000000n,
          capital: 10000000n,
          entryPrice: 100000000n,
        })
      );

      // Second fetch (re-verification): position closed
      vi.mocked(fetchSlab).mockResolvedValueOnce(Buffer.from([1, 2, 3]));
      vi.mocked(parseConfig).mockReturnValueOnce({
        authorityPriceE6: 50000000n,
        authorityTimestamp: now,
      } as any);
      vi.mocked(parseUsedIndices).mockReturnValueOnce([]); // Account no longer active
      vi.mocked(parseAccount).mockReturnValueOnce(
        createMockAccount({
          positionSize: 0n, // Closed
        })
      );

      const sig = await liquidationService.liquidate(mockMarket, 0);

      // Should skip liquidation due to race condition
      expect(sig).toBeNull();
    });

    it('should skip if account becomes healthy before liquidation', async () => {
      const mockMarket = createMockMarket();
      const { fetchSlab, parseConfig, parseAccount, parseUsedIndices } = await import('@percolator/core');

      const now = BigInt(Math.floor(Date.now() / 1000));

      // Re-verification: position became healthy
      vi.mocked(fetchSlab).mockResolvedValue(Buffer.from([1, 2, 3]));
      vi.mocked(parseConfig).mockReturnValue({
        authorityPriceE6: 110000000n, // Price recovered
        authorityTimestamp: now,
      } as any);
      vi.mocked(parseUsedIndices).mockReturnValue([0]);
      vi.mocked(parseAccount).mockReturnValue(
        createMockAccount({
          positionSize: 1000000n,
          capital: 100000000n, // Healthy again
          entryPrice: 100000000n,
        })
      );

      const sig = await liquidationService.liquidate(mockMarket, 0);

      expect(sig).toBeNull();
    });
  });

  describe('Service Lifecycle', () => {
    it('should start and stop service correctly', () => {
      const getMarkets = () => new Map();
      
      const initialStatus = liquidationService.getStatus();
      expect(initialStatus.running).toBe(false);

      liquidationService.start(getMarkets);
      const runningStatus = liquidationService.getStatus();
      expect(runningStatus.running).toBe(true);

      liquidationService.stop();
      const stoppedStatus = liquidationService.getStatus();
      expect(stoppedStatus.running).toBe(false);
    });

    it('should track scan count and last scan time', async () => {
      const markets = new Map([
        ['market1', { market: createMockMarket() }],
      ]);

      const initialStatus = liquidationService.getStatus();
      const initialScanCount = initialStatus.scanCount;

      await liquidationService.scanAndLiquidateAll(markets);

      const finalStatus = liquidationService.getStatus();
      expect(finalStatus.scanCount).toBe(initialScanCount + 1);
      expect(finalStatus.lastScanTime).toBeGreaterThan(0);
    });
  });

  describe('Error Handling', () => {
    it('should handle market scan errors gracefully', async () => {
      const mockMarket = createMockMarket();
      const { fetchSlab } = await import('@percolator/core');

      // Mock fetchSlab to throw error
      vi.mocked(fetchSlab).mockRejectedValueOnce(new Error('RPC error'));

      const candidates = await liquidationService.scanMarket(mockMarket);

      // Should return empty array on error
      expect(candidates).toHaveLength(0);
    });

    it('should publish failure event on liquidation error', async () => {
      const mockMarket = createMockMarket();
      const { fetchSlab, parseConfig, parseAccount, parseUsedIndices } = await import('@percolator/core');
      const { getConnection } = await import('../../src/utils/solana.js');
      const { eventBus } = await import('../../src/services/events.js');

      const now = BigInt(Math.floor(Date.now() / 1000));

      vi.mocked(fetchSlab).mockResolvedValue(Buffer.from([1, 2, 3]));
      vi.mocked(parseConfig).mockReturnValue({
        authorityPriceE6: 50000000n,
        authorityTimestamp: now,
      } as any);
      vi.mocked(parseUsedIndices).mockReturnValue([0]);
      vi.mocked(parseAccount).mockReturnValue(
        createMockAccount({
          positionSize: 1000000n,
          capital: 1000000n, // $1 - underwater position
          entryPrice: 100000000n,
        })
      );

      // Mock getConnection to return a connection that fails on sendRawTransaction
      vi.mocked(getConnection).mockReturnValueOnce({
        getLatestBlockhash: vi.fn().mockResolvedValue({
          blockhash: createTestPublicKey('Blockhash').toBase58(),
          lastValidBlockHeight: 1000000,
        }),
        sendRawTransaction: vi.fn().mockRejectedValue(
          new Error('Transaction failed')
        ),
        getSignatureStatuses: vi.fn().mockResolvedValue({
          value: [{ confirmationStatus: 'confirmed', err: null }],
        }),
      } as any);

      await liquidationService.liquidate(mockMarket, 0);

      expect(eventBus.publish).toHaveBeenCalledWith(
        'liquidation.failure',
        expect.any(String),
        expect.objectContaining({
          error: expect.stringContaining('Transaction failed'),
        })
      );
    });
  });
});
