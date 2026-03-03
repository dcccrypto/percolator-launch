import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @solana/web3.js first, before importing it
vi.mock('@solana/web3.js', async () => {
  const actual = await vi.importActual('@solana/web3.js');
  return {
    ...actual,
    SYSVAR_CLOCK_PUBKEY: {
      toBase58: () => 'SysvarC1ock11111111111111111111111111111111',
      equals: () => false,
    },
  };
});

// Mock all external dependencies
vi.mock('@percolator/sdk', () => ({
  discoverMarkets: vi.fn(),
  encodeKeeperCrank: vi.fn(() => Buffer.from([1, 2, 3])),
  encodePushOraclePrice: vi.fn(() => Buffer.from([4, 5, 6])),
  buildAccountMetas: vi.fn(() => []),
  buildIx: vi.fn(() => ({})),
  derivePythPushOraclePDA: vi.fn(() => [{ toBase58: () => '11111111111111111111111111111111' }, 0]),
  ACCOUNTS_KEEPER_CRANK: {},
  ACCOUNTS_PUSH_ORACLE_PRICE: {},
}));

vi.mock('@percolator/shared', () => ({
  config: {
    crankIntervalMs: 30000,
    crankInactiveIntervalMs: 120000,
    discoveryIntervalMs: 300000,
    allProgramIds: ['11111111111111111111111111111111', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
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
  getFallbackConnection: vi.fn(() => ({
    getProgramAccounts: vi.fn(),
  })),
  loadKeypair: vi.fn(() => ({
    publicKey: { toBase58: () => '11111111111111111111111111111111', equals: () => true },
    secretKey: new Uint8Array(64),
  })),
  sendWithRetry: vi.fn(async () => 'mock-signature-' + Date.now()),
  sendWithRetryKeeper: vi.fn(async () => 'mock-keeper-sig-' + Date.now()),
  rateLimitedCall: vi.fn((fn) => fn()),
  sendCriticalAlert: vi.fn(),
  eventBus: {
    publish: vi.fn(),
  },
}));

import { PublicKey } from '@solana/web3.js';
import { CrankService } from '../../src/services/crank.js';
import * as core from '@percolator/sdk';
import * as shared from '@percolator/shared';

describe('CrankService', () => {
  let crankService: CrankService;
  let mockOracleService: any;

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockOracleService = {
      pushPrice: vi.fn().mockResolvedValue(true),
    };

    crankService = new CrankService(mockOracleService);
  });

  afterEach(() => {
    crankService.stop();
  });

  describe('constructor', () => {
    it('should set intervals from config', () => {
      const customInterval = 15000;
      const service = new CrankService(mockOracleService, customInterval);
      
      expect(service.isRunning).toBe(false);
    });
  });

  describe('discover', () => {
    it('should discover markets across multiple program IDs', async () => {
      const mockMarkets = [
        {
          slabAddress: { toBase58: () => 'Market111111111111111111111111111111111' },
          programId: { toBase58: () => '11111111111111111111111111111111' },
          config: {
            collateralMint: { toBase58: () => 'Mint1111111111111111111111111111111111' },
            oracleAuthority: { toBase58: () => 'Oracle11111111111111111111111111111111', equals: () => false },
            indexFeedId: { toBytes: () => new Uint8Array(32) },
          },
          params: {
            maintenanceMarginBps: 500n,
            initialMarginBps: 1000n,
          },
          header: {
            admin: { toBase58: () => 'Admin111111111111111111111111111111111' },
          },
        },
      ];

      vi.mocked(core.discoverMarkets).mockResolvedValue(mockMarkets as any);

      const result = await crankService.discover();

      // discoverMarkets returns same market for each program ID, so 2 total
      expect(result).toHaveLength(mockMarkets.length * 2);
      expect(core.discoverMarkets).toHaveBeenCalledTimes(2); // Two program IDs
      // Same slab address from both programs → stored once in map
      expect(crankService.getMarkets().size).toBe(1);
    });

    it('should handle discovery errors per program without crashing', async () => {
      vi.mocked(core.discoverMarkets)
        .mockRejectedValueOnce(new Error('Program 1 failed'))
        .mockResolvedValueOnce([{
          slabAddress: { toBase58: () => 'Market211111111111111111111111111111111' },
          programId: { toBase58: () => 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
          config: {
            collateralMint: { toBase58: () => 'Mint2111111111111111111111111111111111' },
            oracleAuthority: { toBase58: () => 'Oracle21111111111111111111111111111111', equals: () => false },
            indexFeedId: { toBytes: () => new Uint8Array(32) },
          },
          params: { maintenanceMarginBps: 500n },
          header: { admin: { toBase58: () => 'Admin211111111111111111111111111111111' } },
        }] as any);

      const result = await crankService.discover();

      expect(result).toHaveLength(1);
      expect(crankService.getMarkets().size).toBe(1);
    });

    it('should track and remove markets missing from 3 consecutive discoveries', async () => {
      // First discovery: add market
      const market1 = {
        slabAddress: { toBase58: () => 'Market311111111111111111111111111111111' },
        programId: { toBase58: () => '11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'Mint3111111111111111111111111111111111' },
          oracleAuthority: { toBase58: () => 'Oracle31111111111111111111111111111111', equals: () => false },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'Admin311111111111111111111111111111111' } },
      };

      vi.mocked(core.discoverMarkets).mockResolvedValue([market1] as any);
      await crankService.discover();
      expect(crankService.getMarkets().size).toBe(1);

      // Second discovery: market missing (count = 1)
      vi.mocked(core.discoverMarkets).mockResolvedValue([]);
      await crankService.discover();
      expect(crankService.getMarkets().size).toBe(1);

      // Third discovery: market missing (count = 2)
      await crankService.discover();
      expect(crankService.getMarkets().size).toBe(1);

      // Fourth discovery: market missing (count = 3, should be removed)
      await crankService.discover();
      expect(crankService.getMarkets().size).toBe(0);
    }, 20000);
  });

  describe('crankMarket', () => {
    it('should successfully crank a market and update state', async () => {
      const slabAddress = 'Market411111111111111111111111111111111';
      const mockMarket = {
        slabAddress: { toBase58: () => slabAddress },
        programId: { toBase58: () => '11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'Mint4111111111111111111111111111111111' },
          oracleAuthority: { toBase58: () => '11111111111111111111111111111111', equals: () => true },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'Admin411111111111111111111111111111111' } },
      };

      vi.mocked(core.discoverMarkets).mockResolvedValue([mockMarket] as any);
      await crankService.discover();

      const result = await crankService.crankMarket(slabAddress);

      expect(result).toBe(true);
      expect(shared.sendWithRetryKeeper).toHaveBeenCalled();
      
      const state = crankService.getMarkets().get(slabAddress);
      expect(state?.successCount).toBe(1);
      expect(state?.consecutiveFailures).toBe(0);
      expect(state?.isActive).toBe(true);
    });

    it('should increment failure count on crank failure', async () => {
      const slabAddress = 'Market511111111111111111111111111111111';
      const mockMarket = {
        slabAddress: { toBase58: () => slabAddress },
        programId: { toBase58: () => '11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'Mint5111111111111111111111111111111111' },
          oracleAuthority: { toBase58: () => '11111111111111111111111111111111', equals: () => true },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'Admin511111111111111111111111111111111' } },
      };

      vi.mocked(core.discoverMarkets).mockResolvedValue([mockMarket] as any);
      await crankService.discover();

      vi.mocked(shared.sendWithRetryKeeper).mockRejectedValue(new Error('Transaction failed'));

      const result = await crankService.crankMarket(slabAddress);

      expect(result).toBe(false);
      
      const state = crankService.getMarkets().get(slabAddress);
      expect(state?.failureCount).toBe(1);
      expect(state?.consecutiveFailures).toBe(1);
    });

    it('should use longer inactive interval (60s) after 10 consecutive failures', async () => {
      // After 10 failures the market is demoted to inactive (isActive=false).
      // The isDue logic switches from crankIntervalMs (30s) to crankInactiveIntervalMs (60s).
      // Verify that within 60s of the last successful crank, isDue returns false.
      const slabAddress = 'MarketInactive11111111111111111111111111';
      const mockMarket = {
        slabAddress: { toBase58: () => slabAddress },
        programId: { toBase58: () => '11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'MintInactive1111111111111111111111111111' },
          oracleAuthority: { toBase58: () => '11111111111111111111111111111111', equals: () => true },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'AdminInact1111111111111111111111111111' } },
      };

      vi.mocked(core.discoverMarkets).mockResolvedValue([mockMarket] as any);
      await crankService.discover();

      // Set a known baseline time via fake timers
      const startTime = 1_700_000_000_000; // fixed epoch ms
      vi.setSystemTime(startTime);

      // One successful crank to set lastCrankTime
      vi.mocked(shared.sendWithRetryKeeper).mockResolvedValue('initial-success');
      await crankService.crankMarket(slabAddress);
      const stateAfterSuccess = crankService.getMarkets().get(slabAddress)!;
      expect(stateAfterSuccess.isActive).toBe(true);
      expect(stateAfterSuccess.lastCrankTime).toBeCloseTo(startTime, -2);

      // Now fail 10 consecutive times → market becomes inactive
      vi.mocked(shared.sendWithRetryKeeper).mockRejectedValue(new Error('Transaction failed'));
      for (let i = 0; i < 10; i++) {
        await crankService.crankMarket(slabAddress);
      }

      const stateAfterFailures = crankService.getMarkets().get(slabAddress)!;
      expect(stateAfterFailures.isActive).toBe(false);
      expect(stateAfterFailures.consecutiveFailures).toBe(10);

      // --- Verify isDue logic using inactive interval (60s) ---
      // The inactive interval from config mock is 120_000ms.
      // Active interval is 30_000ms.
      // Since market is now inactive, the effective interval is 120s (crankInactiveIntervalMs).

      // At t+30s: 30s < 120s → isDue should be false
      vi.setSystemTime(startTime + 30_000);
      const isDueAt30s = Date.now() - stateAfterFailures.lastCrankTime >= 120_000;
      expect(isDueAt30s).toBe(false);

      // At t+60s: 60s < 120s → still false
      vi.setSystemTime(startTime + 60_000);
      const isDueAt60s = Date.now() - stateAfterFailures.lastCrankTime >= 120_000;
      expect(isDueAt60s).toBe(false);

      // At t+121s: 121s >= 120s → isDue becomes true (inactive interval elapsed)
      vi.setSystemTime(startTime + 121_000);
      const isDueAt121s = Date.now() - stateAfterFailures.lastCrankTime >= 120_000;
      expect(isDueAt121s).toBe(true);
    });

    it('should mark market inactive after 10 consecutive failures', async () => {
      const slabAddress = 'Market611111111111111111111111111111111';
      const mockMarket = {
        slabAddress: { toBase58: () => slabAddress },
        programId: { toBase58: () => '11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'Mint6111111111111111111111111111111111' },
          oracleAuthority: { toBase58: () => '11111111111111111111111111111111', equals: () => true },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'Admin611111111111111111111111111111111' } },
      };

      vi.mocked(core.discoverMarkets).mockResolvedValue([mockMarket] as any);
      await crankService.discover();

      vi.mocked(shared.sendWithRetryKeeper).mockRejectedValue(new Error('Transaction failed'));

      // Fail 10 times
      for (let i = 0; i < 10; i++) {
        await crankService.crankMarket(slabAddress);
      }

      const state = crankService.getMarkets().get(slabAddress);
      expect(state?.consecutiveFailures).toBe(10);
      expect(state?.isActive).toBe(false);
    });
  });

  describe('PERC-381: permanent skip cooldown', () => {
    it('should NOT re-enable 0x4-skipped markets on immediate rediscovery', async () => {
      const slabAddress = 'MarketSkip111111111111111111111111111111';
      const mockMarket = {
        slabAddress: { toBase58: () => slabAddress },
        programId: { toBase58: () => '11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'MintSkip1111111111111111111111111111111' },
          oracleAuthority: { toBase58: () => '11111111111111111111111111111111', equals: () => true },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'AdminSkip111111111111111111111111111111' } },
      };

      vi.mocked(core.discoverMarkets).mockResolvedValue([mockMarket] as any);
      await crankService.discover();

      // Simulate 0x4 error → permanently skipped
      vi.mocked(shared.sendWithRetryKeeper).mockRejectedValue(
        new Error('failed to send transaction: Transaction simulation failed: Error processing Instruction 0: custom program error: 0x4')
      );
      await crankService.crankMarket(slabAddress);

      const stateAfterSkip = crankService.getMarkets().get(slabAddress)!;
      expect(stateAfterSkip.permanentlySkipped).toBe(true);
      expect(stateAfterSkip.permanentlySkippedAt).toBeDefined();
      expect(stateAfterSkip.skipCount).toBe(1);

      // Immediately rediscover — should NOT re-enable (cooldown not elapsed)
      await crankService.discover();

      const stateAfterRediscovery = crankService.getMarkets().get(slabAddress)!;
      expect(stateAfterRediscovery.permanentlySkipped).toBe(true);
    });

    it('should re-enable 0x4-skipped markets after cooldown expires', async () => {
      const slabAddress = 'MarketCool111111111111111111111111111111';
      const mockMarket = {
        slabAddress: { toBase58: () => slabAddress },
        programId: { toBase58: () => '11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'MintCool1111111111111111111111111111111' },
          oracleAuthority: { toBase58: () => '11111111111111111111111111111111', equals: () => true },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'AdminCool111111111111111111111111111111' } },
      };

      vi.mocked(core.discoverMarkets).mockResolvedValue([mockMarket] as any);
      await crankService.discover();

      // Simulate 0x4 error
      vi.mocked(shared.sendWithRetryKeeper).mockRejectedValue(
        new Error('custom program error: 0x4')
      );
      await crankService.crankMarket(slabAddress);

      const state = crankService.getMarkets().get(slabAddress)!;
      expect(state.permanentlySkipped).toBe(true);

      // Fast-forward past the 1-hour cooldown (skipCount=1 → 1h)
      state.permanentlySkippedAt = Date.now() - 3_700_000; // 1h + 100s ago

      // Rediscover — should now re-enable
      await crankService.discover();

      const stateAfterCooldown = crankService.getMarkets().get(slabAddress)!;
      expect(stateAfterCooldown.permanentlySkipped).toBe(false);
      expect(stateAfterCooldown.consecutiveFailures).toBe(0);
    });

    it('should increase cooldown with each skip (exponential backoff)', { timeout: 30000 }, async () => {
      const slabAddress = 'MarketExp1111111111111111111111111111111';
      const mockMarket = {
        slabAddress: { toBase58: () => slabAddress },
        programId: { toBase58: () => '11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'MintExp11111111111111111111111111111111' },
          oracleAuthority: { toBase58: () => '11111111111111111111111111111111', equals: () => true },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'AdminExp1111111111111111111111111111111' } },
      };

      vi.mocked(core.discoverMarkets).mockResolvedValue([mockMarket] as any);
      await crankService.discover();

      // Simulate multiple 0x4 errors
      vi.mocked(shared.sendWithRetryKeeper).mockRejectedValue(
        new Error('custom program error: 0x4')
      );
      await crankService.crankMarket(slabAddress);

      const state = crankService.getMarkets().get(slabAddress)!;
      expect(state.skipCount).toBe(1);

      // Re-enable after cooldown, then fail again → skipCount=2
      state.permanentlySkippedAt = Date.now() - 3_700_000; // past 1h cooldown
      await crankService.discover();
      expect(state.permanentlySkipped).toBe(false);

      await crankService.crankMarket(slabAddress);
      expect(state.permanentlySkipped).toBe(true);
      expect(state.skipCount).toBe(2);

      // After 1h (skipCount=2 → 2h cooldown) → should NOT re-enable yet
      state.permanentlySkippedAt = Date.now() - 3_700_000; // 1h ago, but need 2h
      await crankService.discover();
      expect(state.permanentlySkipped).toBe(true); // Still in cooldown

      // After 2h → should re-enable
      state.permanentlySkippedAt = Date.now() - 7_300_000; // 2h+ ago
      await crankService.discover();
      expect(state.permanentlySkipped).toBe(false);
    });
  });

  describe('start and stop', () => {
    it('should start timer and perform initial discovery', async () => {
      vi.mocked(core.discoverMarkets).mockResolvedValue([]);
      
      crankService.start();
      
      expect(crankService.isRunning).toBe(true);
      
      // Wait for initial discovery
      await new Promise(resolve => setTimeout(resolve, 100));
      
      expect(core.discoverMarkets).toHaveBeenCalled();
    });

    it('should stop timer', () => {
      crankService.start();
      expect(crankService.isRunning).toBe(true);
      
      crankService.stop();
      expect(crankService.isRunning).toBe(false);
    });
  });
});
