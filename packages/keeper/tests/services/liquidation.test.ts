import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @solana/web3.js first
vi.mock('@solana/web3.js', async () => {
  const actual = await vi.importActual('@solana/web3.js');
  
  class MockTransaction {
    recentBlockhash: string | undefined;
    feePayer: any;
    signatures: any[] = [];
    instructions: any[] = [];
    
    add(...instructions: any[]) {
      this.instructions.push(...instructions);
      return this;
    }
    
    sign(...signers: any[]) {
      // Mock signing
    }
    
    serialize() {
      return Buffer.from([1, 2, 3]);
    }
  }
  
  return {
    ...actual,
    SYSVAR_CLOCK_PUBKEY: {
      toBase58: () => 'SysvarC1ock11111111111111111111111111111111',
      equals: () => false,
    },
    ComputeBudgetProgram: {
      setComputeUnitLimit: vi.fn(() => ({ keys: [], programId: { toBase58: () => '11111111111111111111111111111111' }, data: Buffer.from([]) })),
      setComputeUnitPrice: vi.fn(() => ({ keys: [], programId: { toBase58: () => '11111111111111111111111111111111' }, data: Buffer.from([]) })),
    },
    Transaction: MockTransaction,
  };
});

// Mock external dependencies
vi.mock('@percolator/sdk', () => ({
  fetchSlab: vi.fn(),
  parseConfig: vi.fn(),
  parseEngine: vi.fn(),
  parseParams: vi.fn(),
  parseAccount: vi.fn(),
  parseUsedIndices: vi.fn(),
  detectLayout: vi.fn(),
  buildAccountMetas: vi.fn(() => []),
  buildIx: vi.fn(() => ({ keys: [], programId: { toBase58: () => '11111111111111111111111111111111' }, data: Buffer.from([]) })),
  encodeLiquidateAtOracle: vi.fn(() => Buffer.from([1])),
  encodeKeeperCrank: vi.fn(() => Buffer.from([2])),
  encodePushOraclePrice: vi.fn(() => Buffer.from([3])),
  derivePythPushOraclePDA: vi.fn(() => [{ toBase58: () => 'Oracle11111111111111111111111111111111' }, 0]),
  ACCOUNTS_LIQUIDATE_AT_ORACLE: {},
  ACCOUNTS_KEEPER_CRANK: {},
  ACCOUNTS_PUSH_ORACLE_PRICE: {},
  IX_TAG: { TradeNoCpi: 1, TradeCpi: 2 },
}));

vi.mock('@percolator/shared', () => ({
  config: {
    crankKeypair: 'mock-keypair-path',
  },
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  sendWarningAlert: vi.fn(),
  getConnection: vi.fn(() => ({
    getAccountInfo: vi.fn(),
    getLatestBlockhash: vi.fn(async () => ({
      blockhash: 'mock-blockhash',
      lastValidBlockHeight: 1000000,
    })),
    sendRawTransaction: vi.fn(async () => 'mock-tx-signature'),
  })),
  loadKeypair: vi.fn(() => {
    // Use a mock publicKey with proper equals method
    const mockPubkey = {
      toBase58: () => '11111111111111111111111111111111',
      toBuffer: () => Buffer.alloc(32),
      equals: (other: any) => {
        if (!other) return false;
        const otherStr = typeof other.toBase58 === 'function' ? other.toBase58() : String(other);
        return otherStr === '11111111111111111111111111111111';
      },
    };
    return {
      publicKey: mockPubkey as any,
      secretKey: new Uint8Array(64),
    };
  }),
  sendWithRetry: vi.fn(async () => 'mock-signature'),
  pollSignatureStatus: vi.fn(async () => true),
  getRecentPriorityFees: vi.fn(async () => ({
    priorityFeeMicroLamports: 5000,
    computeUnitLimit: 200000,
  })),
  checkTransactionSize: vi.fn(),
  eventBus: {
    publish: vi.fn(),
  },
  acquireToken: vi.fn(async () => {}),
  getFallbackConnection: vi.fn(() => ({
    getAccountInfo: vi.fn(),
    getLatestBlockhash: vi.fn(async () => ({
      blockhash: 'mock-blockhash',
      lastValidBlockHeight: 1000000,
    })),
    sendRawTransaction: vi.fn(async () => 'mock-tx-signature'),
  })),
  backoffMs: vi.fn(() => 100),
}));

import { PublicKey, ComputeBudgetProgram } from '@solana/web3.js';
import { LiquidationService } from '../../src/services/liquidation.js';
import * as core from '@percolator/sdk';
import * as shared from '@percolator/shared';

describe('LiquidationService', () => {
  let liquidationService: LiquidationService;
  let mockOracleService: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockOracleService = {
      fetchPrice: vi.fn().mockResolvedValue({
        priceE6: 1_000_000n,
        source: 'dexscreener',
        timestamp: Date.now(),
      }),
    };

    liquidationService = new LiquidationService(mockOracleService, 15000);
  });

  afterEach(() => {
    liquidationService.stop();
  });

  describe('scanMarket', () => {
    it('should find undercollateralized accounts', async () => {
      const mockMarket = {
        slabAddress: { toBase58: () => 'Market111111111111111111111111111111111' },
        programId: { toBase58: () => 'Program11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'So11111111111111111111111111111111111111112' },
          oracleAuthority: { toBase58: () => 'Oracle11111111111111111111111111111111' },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
          authorityPriceE6: 1_000_000n,
          authorityTimestamp: BigInt(Math.floor(Date.now() / 1000)),
        },
        params: {
          maintenanceMarginBps: 500n, // 5%
        },
        header: {
          admin: { toBase58: () => 'Admin111111111111111111111111111111111' },
        },
      };

      const mockSlabData = new Uint8Array(1024);

      vi.mocked(core.fetchSlab).mockResolvedValue(mockSlabData);
      vi.mocked(core.parseEngine).mockReturnValue({
        totalOpenInterest: 100_000_000n,
        numUsedAccounts: 1,
        vault: 1000_000n,
        insuranceFund: { balance: 500_000n, feeRevenue: 0n },
      } as any);
      vi.mocked(core.parseParams).mockReturnValue({
        maintenanceMarginBps: 500n,
      } as any);
      vi.mocked(core.parseConfig).mockReturnValue({
        authorityPriceE6: 1_000_000n,
        authorityTimestamp: BigInt(Math.floor(Date.now() / 1000)),
      } as any);
      vi.mocked(core.detectLayout).mockReturnValue({ accountsOffset: 0 } as any);
      vi.mocked(core.parseUsedIndices).mockReturnValue([0]);

      // Undercollateralized account: 100 USDC capital, 10,000 units position @ $1
      // Notional = 10,000, margin ratio = 100 / 10,000 = 1% (below 5% maintenance)
      vi.mocked(core.parseAccount).mockReturnValue({
        kind: 0, // User account
        owner: { toBase58: () => 'User1111111111111111111111111111111111111' },
        positionSize: 10_000_000_000n, // 10,000 units (6 decimals)
        capital: 100_000_000n, // 100 USDC
        entryPrice: 1_000_000n,
      } as any);

      const candidates = await liquidationService.scanMarket(mockMarket as any);

      expect(candidates).toHaveLength(1);
      expect(candidates[0].accountIdx).toBe(0);
      expect(candidates[0].marginRatio).toBeLessThan(5); // Below 5%
    });

    it('should skip accounts with stale oracle prices', async () => {
      const mockMarket = {
        slabAddress: { toBase58: () => 'Market211111111111111111111111111111111' },
        programId: { toBase58: () => 'Program11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'So11111111111111111111111111111111111111112' },
          oracleAuthority: { toBase58: () => 'Oracle11111111111111111111111111111111' },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
          authorityPriceE6: 1_000_000n,
          authorityTimestamp: BigInt(Math.floor(Date.now() / 1000) - 120), // 2 minutes old
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'Admin111111111111111111111111111111111' } },
      };

      const mockSlabData = new Uint8Array(1024);

      vi.mocked(core.fetchSlab).mockResolvedValue(mockSlabData);
      vi.mocked(core.parseEngine).mockReturnValue({
        totalOpenInterest: 100_000_000n,
      } as any);
      vi.mocked(core.parseParams).mockReturnValue({
        maintenanceMarginBps: 500n,
      } as any);
      vi.mocked(core.parseConfig).mockReturnValue({
        authorityPriceE6: 1_000_000n,
        authorityTimestamp: BigInt(Math.floor(Date.now() / 1000) - 120), // 2 minutes old (>60s)
      } as any);
      vi.mocked(core.detectLayout).mockReturnValue({ accountsOffset: 0 } as any);

      const candidates = await liquidationService.scanMarket(mockMarket as any);

      expect(candidates).toHaveLength(0); // Skipped due to stale price
    });
  });

  describe('liquidate', () => {
    it('should execute liquidation with multi-instruction transaction', async () => {
      const mockMarket = {
        slabAddress: { toBase58: () => 'Market311111111111111111111111111111111' },
        programId: { toBase58: () => 'Program11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'So11111111111111111111111111111111111111112' },
          oracleAuthority: {
            toBase58: () => '11111111111111111111111111111111',
            equals: (other: any) => {
              if (!other) return false;
              const otherStr = typeof other.toBase58 === 'function' ? other.toBase58() : String(other);
              return otherStr === '11111111111111111111111111111111';
            },
          },
          indexFeedId: { toBytes: () => new Uint8Array(32).fill(0) },
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'Admin111111111111111111111111111111111' } },
      };

      const mockSlabData = new Uint8Array(1024);

      vi.mocked(core.fetchSlab).mockResolvedValue(mockSlabData);
      vi.mocked(core.parseEngine).mockReturnValue({} as any);
      vi.mocked(core.parseParams).mockReturnValue({ maintenanceMarginBps: 500n } as any);
      vi.mocked(core.parseConfig).mockReturnValue({
        authorityPriceE6: 1_000_000n,
        authorityTimestamp: BigInt(Math.floor(Date.now() / 1000)),
      } as any);
      vi.mocked(core.parseUsedIndices).mockReturnValue([0]);
      vi.mocked(core.parseAccount).mockReturnValue({
        kind: 0,
        owner: { toBase58: () => 'User2111111111111111111111111111111111111' },
        positionSize: 10_000_000_000n,
        capital: 1_000_000n,
        entryPrice: 1_000_000n,
      } as any);

      const signature = await liquidationService.liquidate(mockMarket as any, 0);

      expect(signature).not.toBeNull();
      expect(shared.eventBus.publish).toHaveBeenCalledWith(
        'liquidation.success',
        expect.any(String),
        expect.objectContaining({ accountIdx: 0 })
      );
    });

    it('should increment liquidation count on success', async () => {
      const mockMarket = {
        slabAddress: { toBase58: () => 'Market411111111111111111111111111111111' },
        programId: { toBase58: () => 'Program11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'So11111111111111111111111111111111111111112' },
          oracleAuthority: {
            toBase58: () => '11111111111111111111111111111111',
            equals: (other: any) => {
              if (!other) return false;
              const otherStr = typeof other.toBase58 === 'function' ? other.toBase58() : String(other);
              return otherStr === '11111111111111111111111111111111';
            },
          },
          indexFeedId: { toBytes: () => new Uint8Array(32).fill(0) },
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'Admin111111111111111111111111111111111' } },
      };

      vi.mocked(core.fetchSlab).mockResolvedValue(new Uint8Array(1024));
      vi.mocked(core.parseEngine).mockReturnValue({} as any);
      vi.mocked(core.parseParams).mockReturnValue({ maintenanceMarginBps: 500n } as any);
      vi.mocked(core.parseConfig).mockReturnValue({
        authorityPriceE6: 1_000_000n,
        authorityTimestamp: BigInt(Math.floor(Date.now() / 1000)),
      } as any);
      vi.mocked(core.parseUsedIndices).mockReturnValue([0]);
      vi.mocked(core.parseAccount).mockReturnValue({
        kind: 0,
        owner: { toBase58: () => 'User3111111111111111111111111111111111111' },
        positionSize: 10_000_000_000n,
        capital: 1_000_000n,
        entryPrice: 1_000_000n,
      } as any);

      const statusBefore = liquidationService.getStatus();
      
      await liquidationService.liquidate(mockMarket as any, 0);

      const statusAfter = liquidationService.getStatus();
      expect(statusAfter.liquidationCount).toBe(statusBefore.liquidationCount + 1);
    });
  });

  describe('start and stop', () => {
    it('should start and stop timer', () => {
      const markets = new Map();
      
      liquidationService.start(() => markets);
      expect(liquidationService.getStatus().running).toBe(true);

      liquidationService.stop();
      expect(liquidationService.getStatus().running).toBe(false);
    });
  });
});
