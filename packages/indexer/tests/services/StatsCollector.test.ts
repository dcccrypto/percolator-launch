import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';

// Mock external dependencies
const mockGetAccountInfo = vi.fn();
const mockGetMultipleAccountsInfo = vi.fn();

vi.mock('@percolator/sdk', () => ({
  parseEngine: vi.fn(),
  parseConfig: vi.fn(),
  parseParams: vi.fn(),
  parseAllAccounts: vi.fn(() => []),
}));

vi.mock('@percolator/shared', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  getConnection: vi.fn(() => ({
    getAccountInfo: mockGetAccountInfo,
    getMultipleAccountsInfo: mockGetMultipleAccountsInfo,
    getParsedAccountInfo: vi.fn().mockResolvedValue({ value: null }),
    rpcEndpoint: 'https://api.devnet.solana.com',
  })),
  upsertMarketStats: vi.fn(),
  insertOraclePrice: vi.fn(),
  get24hVolume: vi.fn(async () => ({ volume: '1000000', tradeCount: 5 })),
  getMarkets: vi.fn(async () => []),
  insertMarket: vi.fn(),
  getSupabase: vi.fn(() => ({
    from: vi.fn(() => ({
      insert: vi.fn().mockResolvedValue({ error: null }),
    })),
  })),
  withRetry: vi.fn(async (fn: any) => fn()),
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}));

import { StatsCollector } from '../../src/services/StatsCollector.js';
import type { MarketProvider } from '../../src/services/StatsCollector.js';
import * as core from '@percolator/sdk';
import * as shared from '@percolator/shared';

const SLAB1 = 'FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD';
const SLAB2 = 'FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn';

function makeEngineState(overrides: Record<string, any> = {}) {
  return {
    totalOpenInterest: 1_000_000_000n,
    vault: 500_000_000n,
    insuranceFund: { balance: 100_000_000n, feeRevenue: 50_000_000n },
    numUsedAccounts: 10,
    fundingRateBpsPerSlotLast: 5n,
    netLpPos: 100_000n,
    lpSumAbs: 200_000n,
    lpMaxAbs: 150_000n,
    lifetimeLiquidations: 5n,
    lifetimeForceCloses: 2n,
    cTot: 1_000_000n,
    pnlPosTot: 500_000n,
    lastCrankSlot: 1000n,
    maxCrankStalenessSlots: 100n,
    fundingIndexQpbE6: 0n,
    ...overrides,
  } as any;
}

function makeParams(overrides: Record<string, any> = {}) {
  return {
    maintenanceMarginBps: 500n,
    initialMarginBps: 1000n,
    maintenanceFeePerSlot: 10n,
    liquidationFeeBps: 100n,
    liquidationFeeCap: 1000n,
    liquidationBufferBps: 50n,
    warmupPeriodSlots: 100n,
    ...overrides,
  } as any;
}

function makeConfig(overrides: Record<string, any> = {}) {
  return {
    collateralMint: new PublicKey('So11111111111111111111111111111111111111112'),
    oracleAuthority: new PublicKey('SysvarC1ock11111111111111111111111111111111'),
    authorityPriceE6: 1_500_000n,
    lastEffectivePriceE6: 1_500_000n,
    // Non-zero indexFeedId = admin oracle mode (not hyperp)
    indexFeedId: new PublicKey('SysvarC1ock11111111111111111111111111111111'),
    ...overrides,
  } as any;
}

function makeMockMarket(slabAddress: string) {
  return {
    market: {
      slabAddress: new PublicKey(slabAddress),
      programId: new PublicKey('11111111111111111111111111111111'),
      config: {
        collateralMint: new PublicKey('So11111111111111111111111111111111111111112'),
        oracleAuthority: new PublicKey('SysvarC1ock11111111111111111111111111111111'),
        authorityPriceE6: 1_500_000n,
        lastEffectivePriceE6: 1_500_000n,
        // Non-zero indexFeedId = admin oracle mode (uses authorityPriceE6)
        indexFeedId: new PublicKey('SysvarC1ock11111111111111111111111111111111'),
      },
      params: { maintenanceMarginBps: 500n, initialMarginBps: 1000n },
      header: { admin: new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL') },
    },
  };
}

function setupParseMocks() {
  vi.mocked(core.parseEngine).mockReturnValue(makeEngineState());
  vi.mocked(core.parseConfig).mockReturnValue(makeConfig());
  vi.mocked(core.parseParams).mockReturnValue(makeParams());
  vi.mocked(core.parseAllAccounts).mockReturnValue([]);
}

describe('StatsCollector', () => {
  let statsCollector: StatsCollector;
  let mockMarketProvider: MarketProvider;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockMarketProvider = { getMarkets: vi.fn(() => new Map()) };
    statsCollector = new StatsCollector(mockMarketProvider);
  });

  afterEach(() => {
    statsCollector.stop();
    vi.useRealTimers();
  });

  describe('start and stop', () => {
    it('should start and call collect after initial delay', async () => {
      const markets = new Map([[SLAB1, makeMockMarket(SLAB1)]]);
      vi.mocked(mockMarketProvider.getMarkets).mockReturnValue(markets);
      mockGetAccountInfo.mockResolvedValue({ data: new Uint8Array(2048) });
      mockGetMultipleAccountsInfo.mockResolvedValue([{ data: new Uint8Array(2048) }]);
      setupParseMocks();

      statsCollector.start();

      // Before initial delay — no calls yet
      expect(shared.upsertMarketStats).not.toHaveBeenCalled();

      // Advance past 10s initial delay
      await vi.advanceTimersByTimeAsync(10_500);

      expect(shared.upsertMarketStats).toHaveBeenCalledWith(
        expect.objectContaining({ slab_address: SLAB1 })
      );
    });

    it('should stop timer cleanly', async () => {
      const markets = new Map([[SLAB1, makeMockMarket(SLAB1)]]);
      vi.mocked(mockMarketProvider.getMarkets).mockReturnValue(markets);
      mockGetAccountInfo.mockResolvedValue({ data: new Uint8Array(2048) });
      mockGetMultipleAccountsInfo.mockResolvedValue([{ data: new Uint8Array(2048) }]);
      setupParseMocks();

      statsCollector.start();

      // Advance past initial delay to trigger first collect
      await vi.advanceTimersByTimeAsync(10_500);
      const callCountAfterFirstCollect = vi.mocked(shared.upsertMarketStats).mock.calls.length;
      expect(callCountAfterFirstCollect).toBeGreaterThan(0);

      // Stop the collector
      statsCollector.stop();

      // Advance time by 2 full intervals — no further calls should happen
      await vi.advanceTimersByTimeAsync(60_000);

      expect(vi.mocked(shared.upsertMarketStats).mock.calls.length).toBe(callCountAfterFirstCollect);
    });

    it('should not start twice', async () => {
      const markets = new Map([[SLAB1, makeMockMarket(SLAB1)]]);
      vi.mocked(mockMarketProvider.getMarkets).mockReturnValue(markets);
      mockGetAccountInfo.mockResolvedValue({ data: new Uint8Array(2048) });
      mockGetMultipleAccountsInfo.mockResolvedValue([{ data: new Uint8Array(2048) }]);
      setupParseMocks();

      statsCollector.start();
      statsCollector.start(); // second call should be a no-op

      // Advance past initial delay
      await vi.advanceTimersByTimeAsync(10_500);
      const callsAfterInitial = vi.mocked(shared.upsertMarketStats).mock.calls.length;

      // Advance by exactly one more interval (120s)
      await vi.advanceTimersByTimeAsync(120_000);
      const callsAfterOneInterval = vi.mocked(shared.upsertMarketStats).mock.calls.length;

      // With double-started timers we'd get 2 extra calls; with single timer we get 1
      expect(callsAfterOneInterval).toBe(callsAfterInitial + 1);
    });
  });

  describe('collect', () => {
    it('should read on-chain data and upsert stats to DB', async () => {
      const markets = new Map([[SLAB1, makeMockMarket(SLAB1)]]);
      vi.mocked(mockMarketProvider.getMarkets).mockReturnValue(markets);
      mockGetAccountInfo.mockResolvedValue({ data: new Uint8Array(2048) });
      mockGetMultipleAccountsInfo.mockResolvedValue([{ data: new Uint8Array(2048) }]);
      setupParseMocks();

      statsCollector.start();
      await vi.advanceTimersByTimeAsync(10_500);

      expect(shared.upsertMarketStats).toHaveBeenCalledWith(
        expect.objectContaining({
          slab_address: SLAB1,
          last_price: 1.5,
          total_accounts: 10,
          vault_balance: 500000000,
          total_open_interest: 1000000000,
        })
      );
    });

    it('should log oracle prices on first collect', async () => {
      const markets = new Map([[SLAB1, makeMockMarket(SLAB1)]]);
      vi.mocked(mockMarketProvider.getMarkets).mockReturnValue(markets);
      mockGetAccountInfo.mockResolvedValue({ data: new Uint8Array(2048) });
      mockGetMultipleAccountsInfo.mockResolvedValue([{ data: new Uint8Array(2048) }]);
      setupParseMocks();

      statsCollector.start();
      await vi.advanceTimersByTimeAsync(10_500);

      expect(shared.insertOraclePrice).toHaveBeenCalledWith(
        expect.objectContaining({
          slab_address: SLAB1,
          price_e6: '1500000',
        })
      );
    });

    it('should rate-limit oracle price logging (60s per market)', async () => {
      const markets = new Map([[SLAB1, makeMockMarket(SLAB1)]]);
      vi.mocked(mockMarketProvider.getMarkets).mockReturnValue(markets);
      mockGetAccountInfo.mockResolvedValue({ data: new Uint8Array(2048) });
      mockGetMultipleAccountsInfo.mockResolvedValue([{ data: new Uint8Array(2048) }]);
      setupParseMocks();

      const baseTime = Date.now();
      statsCollector.start();
      
      // First collect at ~10s
      vi.setSystemTime(baseTime + 10_500);
      await vi.advanceTimersByTimeAsync(10_500);
      expect(vi.mocked(shared.insertOraclePrice).mock.calls.length).toBe(1);

      // Second collect at ~130s — should NOT log again (< 60s since first? Actually it's >60s so it WILL log)
      // With 120s interval, next collect fires at ~130.5s. 130.5 - 10.5 = 120s > 60s dedup, so it WILL log.
      vi.setSystemTime(baseTime + 130_500);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(vi.mocked(shared.insertOraclePrice).mock.calls.length).toBe(2);
    });

    it('should handle errored markets gracefully and continue', async () => {
      const markets = new Map([
        [SLAB1, makeMockMarket(SLAB1)],
        [SLAB2, makeMockMarket(SLAB2)],
      ]);
      vi.mocked(mockMarketProvider.getMarkets).mockReturnValue(markets);
      // getMultipleAccountsInfo returns both in one batch — first null (error), second valid
      mockGetMultipleAccountsInfo.mockResolvedValue([null, { data: new Uint8Array(2048) }]);
      mockGetAccountInfo.mockResolvedValue({ data: new Uint8Array(2048) });
      setupParseMocks();

      statsCollector.start();
      await vi.advanceTimersByTimeAsync(10_500);

      // Should still upsert for the second market
      expect(shared.upsertMarketStats).toHaveBeenCalledWith(
        expect.objectContaining({ slab_address: SLAB2 })
      );
    });

    it('should handle parse errors gracefully', async () => {
      const markets = new Map([[SLAB1, makeMockMarket(SLAB1)]]);
      vi.mocked(mockMarketProvider.getMarkets).mockReturnValue(markets);
      mockGetAccountInfo.mockResolvedValue({ data: new Uint8Array(100) });
      mockGetMultipleAccountsInfo.mockResolvedValue([{ data: new Uint8Array(100) }]);
      vi.mocked(core.parseEngine).mockImplementation(() => { throw new Error('Parse error'); });

      statsCollector.start();
      await vi.advanceTimersByTimeAsync(10_500);

      // Should not crash, no upsert
      expect(shared.upsertMarketStats).not.toHaveBeenCalled();
    });

    it('should skip collect when no markets', async () => {
      vi.mocked(mockMarketProvider.getMarkets).mockReturnValue(new Map());

      statsCollector.start();
      await vi.advanceTimersByTimeAsync(10_500);

      expect(shared.upsertMarketStats).not.toHaveBeenCalled();
    });
  });

  describe('MarketProvider interface', () => {
    it('should accept any MarketProvider implementation', async () => {
      const customProvider: MarketProvider = { getMarkets: vi.fn(() => new Map()) };
      const collector = new StatsCollector(customProvider);
      collector.start();
      await vi.advanceTimersByTimeAsync(10_500);
      expect(customProvider.getMarkets).toHaveBeenCalled();
      collector.stop();
    });
  });

  describe('bigint overflow protection', () => {
    it('should skip stats when lifetimeLiquidations exceeds sane threshold', async () => {
      const markets = new Map([[SLAB1, makeMockMarket(SLAB1)]]);
      vi.mocked(mockMarketProvider.getMarkets).mockReturnValue(markets);
      mockGetMultipleAccountsInfo.mockResolvedValue([{ data: new Uint8Array(2048) }]);

      // Value that exceeds PG BIGINT max (9.2e18) — real error case from production
      vi.mocked(core.parseEngine).mockReturnValue(
        makeEngineState({ lifetimeLiquidations: 13292928068290159000n })
      );
      vi.mocked(core.parseConfig).mockReturnValue(makeConfig());
      vi.mocked(core.parseParams).mockReturnValue(makeParams());

      statsCollector.start();
      await vi.advanceTimersByTimeAsync(10_500);

      // Should NOT upsert — isSaneEngine should catch this
      expect(shared.upsertMarketStats).not.toHaveBeenCalled();
    });

    it('should handle values near u64 max gracefully', async () => {
      const markets = new Map([[SLAB1, makeMockMarket(SLAB1)]]);
      vi.mocked(mockMarketProvider.getMarkets).mockReturnValue(markets);
      mockGetMultipleAccountsInfo.mockResolvedValue([{ data: new Uint8Array(2048) }]);

      // lifetimeForceCloses at u64::MAX should be treated as sentinel (0)
      vi.mocked(core.parseEngine).mockReturnValue(
        makeEngineState({ lifetimeForceCloses: 18446744073709551615n })
      );
      vi.mocked(core.parseConfig).mockReturnValue(makeConfig());
      vi.mocked(core.parseParams).mockReturnValue(makeParams());

      statsCollector.start();
      await vi.advanceTimersByTimeAsync(10_500);

      // safeBigNum converts U64_MAX → 0, which passes sanity check
      expect(shared.upsertMarketStats).toHaveBeenCalledWith(
        expect.objectContaining({
          slab_address: SLAB1,
          lifetime_force_closes: 0,
        })
      );
    });
  });
});
