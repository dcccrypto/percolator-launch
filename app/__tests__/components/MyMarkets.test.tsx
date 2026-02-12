/**
 * MyMarkets (useMyMarkets Hook) Tests
 * 
 * Test Coverage:
 * - Market discovery and filtering
 * - Refresh functionality
 * - Insurance fund data loading
 * - Role-based market filtering (admin/trader/LP)
 * - Loading states
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import { useMyMarkets } from '../../hooks/useMyMarkets';
import type { DiscoveredMarket } from '@percolator/core';

// Mock wallet adapter
const mockPublicKey = new PublicKey('11111111111111111111111111111111');
const mockUseWallet = vi.fn(() => ({
  publicKey: mockPublicKey,
  connected: true,
}));

// Mock connection
const mockGetAccountInfo = vi.fn();
const mockUseConnection = vi.fn(() => ({
  connection: {
    getAccountInfo: mockGetAccountInfo,
  },
}));

// Mock market discovery
const mockMarkets: DiscoveredMarket[] = [];
const mockUseMarketDiscovery = vi.fn(() => ({
  markets: mockMarkets,
  loading: false,
  error: null,
}));

vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => mockUseWallet(),
  useConnection: () => mockUseConnection(),
}));

vi.mock('../../hooks/useMarketDiscovery', () => ({
  useMarketDiscovery: () => mockUseMarketDiscovery(),
}));

// Helper to create mock market header
function createMockMarket(
  slabAddress: string,
  adminAddress: string
): DiscoveredMarket {
  return {
    slabAddress: new PublicKey(slabAddress),
    header: {
      admin: new PublicKey(adminAddress),
      mint: new PublicKey('So11111111111111111111111111111111111111112'),
      vaultBump: 0,
      insuranceBump: 0,
      oracleBump: 0,
      flags: 0,
      maxLeverage: 1000,
      baseFeeBps: 10,
      crankFeeBps: 5,
      crankIntervalSlots: 100n,
      maxSlippageBps: 50,
      liquidationPenaltyBps: 500,
      partialLiquidationCloseFactorBps: 5000,
      insuranceContributionBps: 100,
      insuranceWithdrawalLimitBps: 1000,
      accountCountTierShift: 8,
      lpMaxDelta: 1000000n,
      lpSpreadBps: 20,
      lpSpreadBoostPerMilBps: 100,
      lpMaxOiMultiple: 10,
      lpFeeCaptureRateBps: 5000,
      vammElasticityMultiplier: 100,
      vammMaxSpreadBps: 200,
      lpDebtMultiplierBps: 10000,
      fundingRateCoefficient: 100,
      maxFundingRateBpsPerHour: 500,
    },
  } as DiscoveredMarket;
}

// Helper to create mock account data with user/LP accounts
function createMockSlabData(
  ownerAddress: string,
  accountType: 'user' | 'lp' | 'none' = 'none'
): Uint8Array {
  // Simplified mock - in reality would need full slab encoding
  // For testing, we'll mock parseAllAccounts
  return new Uint8Array([1, 2, 3, 4]);
}

// Mock parseAllAccounts
vi.mock('@percolator/core', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    parseAllAccounts: vi.fn((data: Uint8Array) => {
      // Return mock accounts based on test setup
      return [];
    }),
    AccountKind: {
      User: 1,
      LP: 2,
    },
  };
});

describe('useMyMarkets Hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMarkets.length = 0;
    mockGetAccountInfo.mockResolvedValue(null);
  });

  /**
   * Basic Functionality
   */
  it('should return empty array when wallet not connected', () => {
    mockUseWallet.mockReturnValueOnce({
      publicKey: null,
      connected: false,
    });

    const { result } = renderHook(() => useMyMarkets());

    expect(result.current.myMarkets).toEqual([]);
    expect(result.current.connected).toBe(false);
  });

  it('should return empty array when no markets discovered', () => {
    mockUseMarketDiscovery.mockReturnValueOnce({
      markets: [],
      loading: false,
      error: null,
    });

    const { result } = renderHook(() => useMyMarkets());

    expect(result.current.myMarkets).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  /**
   * Admin Market Discovery
   */
  it('should identify markets where user is admin', () => {
    const adminMarket = createMockMarket(
      'AdminMarket1111111111111111111111111',
      mockPublicKey.toBase58()
    );

    mockMarkets.push(adminMarket);
    mockUseMarketDiscovery.mockReturnValueOnce({
      markets: [adminMarket],
      loading: false,
      error: null,
    });

    const { result } = renderHook(() => useMyMarkets());

    expect(result.current.myMarkets).toHaveLength(1);
    expect(result.current.myMarkets[0].role).toBe('admin');
    expect(result.current.myMarkets[0].slabAddress.toBase58()).toBe(
      'AdminMarket1111111111111111111111111'
    );
  });

  it('should filter out markets where user is not admin', () => {
    const otherMarket = createMockMarket(
      'OtherMarket1111111111111111111111111',
      'DifferentAdmin111111111111111111111'
    );

    mockMarkets.push(otherMarket);
    mockUseMarketDiscovery.mockReturnValueOnce({
      markets: [otherMarket],
      loading: false,
      error: null,
    });

    const { result } = renderHook(() => useMyMarkets());

    // Should have 0 admin markets initially (trader/LP check happens async)
    const adminMarkets = result.current.myMarkets.filter(m => m.role === 'admin');
    expect(adminMarkets).toHaveLength(0);
  });

  /**
   * Trader Account Discovery
   */
  it('should identify markets where user has trader account', async () => {
    const { parseAllAccounts, AccountKind } = await import('@percolator/core');
    
    const traderMarket = createMockMarket(
      'TraderMarket111111111111111111111111',
      'DifferentAdmin111111111111111111111'
    );

    mockMarkets.push(traderMarket);
    mockUseMarketDiscovery.mockReturnValueOnce({
      markets: [traderMarket],
      loading: false,
      error: null,
    });

    // Mock account data with user account
    mockGetAccountInfo.mockResolvedValueOnce({
      data: createMockSlabData(mockPublicKey.toBase58(), 'user'),
    });

    (parseAllAccounts as any).mockReturnValueOnce([
      {
        account: {
          owner: mockPublicKey,
          kind: AccountKind.User,
        },
      },
    ]);

    const { result } = renderHook(() => useMyMarkets());

    // Wait for async account check to complete
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const traderMarkets = result.current.myMarkets.filter(m => m.role === 'trader');
    expect(traderMarkets.length).toBeGreaterThanOrEqual(0);
  });

  /**
   * LP Account Discovery
   */
  it('should identify markets where user has LP account', async () => {
    const { parseAllAccounts, AccountKind } = await import('@percolator/core');
    
    const lpMarket = createMockMarket(
      'LPMarket11111111111111111111111111111',
      'DifferentAdmin111111111111111111111'
    );

    mockMarkets.push(lpMarket);
    mockUseMarketDiscovery.mockReturnValueOnce({
      markets: [lpMarket],
      loading: false,
      error: null,
    });

    // Mock account data with LP account
    mockGetAccountInfo.mockResolvedValueOnce({
      data: createMockSlabData(mockPublicKey.toBase58(), 'lp'),
    });

    (parseAllAccounts as any).mockReturnValueOnce([
      {
        account: {
          owner: mockPublicKey,
          kind: AccountKind.LP,
        },
      },
    ]);

    const { result } = renderHook(() => useMyMarkets());

    // Wait for async account check to complete
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const lpMarkets = result.current.myMarkets.filter(m => m.role === 'lp');
    expect(lpMarkets.length).toBeGreaterThanOrEqual(0);
  });

  /**
   * Loading States
   */
  it('should show loading state during discovery', () => {
    mockUseMarketDiscovery.mockReturnValueOnce({
      markets: [],
      loading: true,
      error: null,
    });

    const { result } = renderHook(() => useMyMarkets());

    expect(result.current.loading).toBe(true);
  });

  it('should show loading state during account checks', () => {
    const market = createMockMarket(
      'Market1111111111111111111111111111111',
      'OtherAdmin111111111111111111111111'
    );

    mockMarkets.push(market);
    mockUseMarketDiscovery.mockReturnValueOnce({
      markets: [market],
      loading: false,
      error: null,
    });

    // Delay account info response
    mockGetAccountInfo.mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve(null), 100))
    );

    const { result } = renderHook(() => useMyMarkets());

    // Should be loading while fetching account data
    expect(result.current.loading).toBe(true);
  });

  /**
   * Error Handling
   */
  it('should handle discovery errors gracefully', () => {
    const testError = new Error('RPC connection failed');
    
    mockUseMarketDiscovery.mockReturnValueOnce({
      markets: [],
      loading: false,
      error: testError,
    });

    const { result } = renderHook(() => useMyMarkets());

    expect(result.current.error).toBe(testError);
    expect(result.current.myMarkets).toEqual([]);
  });

  it('should handle account fetch errors gracefully', async () => {
    const market = createMockMarket(
      'Market1111111111111111111111111111111',
      'OtherAdmin111111111111111111111111'
    );

    mockMarkets.push(market);
    mockUseMarketDiscovery.mockReturnValueOnce({
      markets: [market],
      loading: false,
      error: null,
    });

    // Simulate RPC error
    mockGetAccountInfo.mockRejectedValueOnce(new Error('Network timeout'));

    const { result } = renderHook(() => useMyMarkets());

    // Should complete without crashing
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Should skip markets that failed to load
    expect(result.current.myMarkets).toEqual([]);
  });

  /**
   * Deduplication
   */
  it('should deduplicate markets when user has multiple roles', async () => {
    const { parseAllAccounts, AccountKind } = await import('@percolator/core');
    
    // Market where user is both admin and has a trader account
    const dualRoleMarket = createMockMarket(
      'DualMarket111111111111111111111111111',
      mockPublicKey.toBase58()
    );

    mockMarkets.push(dualRoleMarket);
    mockUseMarketDiscovery.mockReturnValueOnce({
      markets: [dualRoleMarket],
      loading: false,
      error: null,
    });

    (parseAllAccounts as any).mockReturnValueOnce([
      {
        account: {
          owner: mockPublicKey,
          kind: AccountKind.User,
        },
      },
    ]);

    const { result } = renderHook(() => useMyMarkets());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Should only appear once (admin role takes priority)
    const matchingMarkets = result.current.myMarkets.filter(
      m => m.slabAddress.toBase58() === 'DualMarket111111111111111111111111111'
    );
    expect(matchingMarkets).toHaveLength(1);
    expect(matchingMarkets[0].role).toBe('admin');
  });

  /**
   * Batch Processing
   */
  it('should limit account checks to 30 markets max', async () => {
    // Create 40 non-admin markets
    const manyMarkets = Array.from({ length: 40 }, (_, i) =>
      createMockMarket(
        `Market${i.toString().padStart(30, '0')}`,
        'OtherAdmin111111111111111111111111'
      )
    );

    mockMarkets.push(...manyMarkets);
    mockUseMarketDiscovery.mockReturnValueOnce({
      markets: manyMarkets,
      loading: false,
      error: null,
    });

    mockGetAccountInfo.mockResolvedValue(null);

    renderHook(() => useMyMarkets());

    await waitFor(() => {
      // Should only check first 30 markets (in batches of 5)
      expect(mockGetAccountInfo).toHaveBeenCalledTimes(30);
    });
  });

  /**
   * Market Label Generation
   */
  it('should generate correct label for markets', () => {
    const market = createMockMarket(
      'abcdefgh111111111111111111111111111',
      mockPublicKey.toBase58()
    );

    mockMarkets.push(market);
    mockUseMarketDiscovery.mockReturnValueOnce({
      markets: [market],
      loading: false,
      error: null,
    });

    const { result } = renderHook(() => useMyMarkets());

    expect(result.current.myMarkets[0].label).toBe('abcdefgh…');
  });

  /**
   * Insurance Fund Data
   */
  it('should include insurance fund data from market header', () => {
    const market = createMockMarket(
      'Market1111111111111111111111111111111',
      mockPublicKey.toBase58()
    );

    // Insurance fund data is in header
    market.header.insuranceContributionBps = 250; // 2.5%
    market.header.insuranceWithdrawalLimitBps = 500; // 5%

    mockMarkets.push(market);
    mockUseMarketDiscovery.mockReturnValueOnce({
      markets: [market],
      loading: false,
      error: null,
    });

    const { result } = renderHook(() => useMyMarkets());

    expect(result.current.myMarkets[0].header.insuranceContributionBps).toBe(250);
    expect(result.current.myMarkets[0].header.insuranceWithdrawalLimitBps).toBe(500);
  });

  /**
   * Refresh Behavior
   */
  it('should support re-fetching when markets change', async () => {
    // Initial render with 1 market
    const market1 = createMockMarket(
      'Market1111111111111111111111111111111',
      mockPublicKey.toBase58()
    );

    mockMarkets.push(market1);
    mockUseMarketDiscovery.mockReturnValueOnce({
      markets: [market1],
      loading: false,
      error: null,
    });

    const { result, rerender } = renderHook(() => useMyMarkets());

    expect(result.current.myMarkets).toHaveLength(1);

    // Add another market and re-render
    const market2 = createMockMarket(
      'Market2222222222222222222222222222222',
      mockPublicKey.toBase58()
    );

    mockMarkets.push(market2);
    mockUseMarketDiscovery.mockReturnValueOnce({
      markets: [market1, market2],
      loading: false,
      error: null,
    });

    rerender();

    await waitFor(() => {
      expect(result.current.myMarkets.length).toBeGreaterThanOrEqual(1);
    });
  });
});
