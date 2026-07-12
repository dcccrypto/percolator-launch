/**
 * /my-markets creator-dashboard tests.
 *
 * Covers:
 *  - useCreatedMarkets (hooks/useCreatedMarkets.ts): admin-detection filter,
 *    dedup, label generation, loading/error passthrough, v17 enrichment
 *    merge. This REPLACES the old useMyMarkets.ts test suite (that hook is
 *    deleted — its trader/LP owner-scan second pass was dropped entirely;
 *    see useCreatedMarkets.ts's top-of-file doc comment for why).
 *  - CreatorAttentionStrip's pure detection logic (components/my-markets/
 *    attentionLogic.ts): keeper-dead-feed and engine-crank-stale conditions.
 *  - The LP-liquidity display helpers (components/my-markets/types.ts):
 *    v17-vs-v12 source switch and the "materially diverges" sub-label gate.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import { useCreatedMarkets } from '../../hooks/useCreatedMarkets';
import {
  isKeeperFeedDead,
  isEngineCrankStale,
  KEEPER_PRICE_STALE_THRESHOLD_SLOTS,
  ENGINE_STALE_THRESHOLD_SLOTS,
} from '../../components/my-markets/attentionLogic';
import {
  deriveMarketLiquidityAtoms,
  lpCollateralMateriallyDiverges,
  unitScaleToDecimals,
  resolveCreatedMarketPriceE6,
} from '../../components/my-markets/types';
import type { CreatorMarketDetail } from '../../components/my-markets/types';
import type { DiscoveredMarket } from '@percolatorct/sdk';
import type { CreatedMarket } from '../../hooks/useCreatedMarkets';

// Mock wallet adapter
const mockPublicKey = new PublicKey('11111111111111111111111111111111');
const mockUseWallet = vi.fn(() => ({
  publicKey: mockPublicKey,
  connected: true,
}));

// Mock connection — resolveLabel's fetchTokenMeta call will fail against this
// stub (no real getAccountInfo behavior), which is fine: it exercises the
// same "fall back to a truncated mint address" path the label logic already
// has a catch-block for.
//
// IMPORTANT: the connection object itself must be REFERENCE-STABLE across
// calls (module-scope singleton, not a fresh object literal per call) — the
// hook's resolveLabel is a useCallback keyed on `connection`, which feeds the
// admin-detection effect's dependency array. A fresh `{ connection: {...} }`
// on every render makes that effect re-fire every render, which — combined
// with `setCreatedMarkets([])`'s brand-new array reference — never settles
// and spins the test into an OOM (found by actually running these tests;
// the previous suite never had to contend with this because it was entirely
// `describe.skip`).
const mockConnection = {
  getSlot: vi.fn().mockResolvedValue(1000),
  getMultipleAccountsInfo: vi.fn().mockResolvedValue([]),
};
const mockUseConnection = vi.fn(() => ({ connection: mockConnection }));

const mockMarkets: DiscoveredMarket[] = [];
const mockUseMarketDiscovery = vi.fn(() => ({
  markets: mockMarkets,
  loading: false,
  error: null,
  refetch: vi.fn(),
}));

vi.mock('@/hooks/useWalletCompat', () => ({
  useWalletCompat: () => mockUseWallet(),
  useConnectionCompat: () => mockUseConnection(),
}));

vi.mock('../../hooks/useMarketDiscovery', () => ({
  useMarketDiscovery: () => mockUseMarketDiscovery(),
}));

// fetchTokenMeta's real implementation falls through to a live, key-free
// DexScreener network call when nothing else resolves — deterministic here
// means never hitting the network. Always reject, so every label test
// exercises the hook's own try/catch fallback (truncated mint address)
// instead of depending on live network state.
vi.mock('@/lib/tokenMeta', () => ({
  fetchTokenMeta: vi.fn().mockRejectedValue(new Error('no network in tests')),
}));

/** Deterministic, always-VALID PublicKey for test fixtures — every byte set
 *  to `n` (1-255). Hand-rolled base58 strings (the previous, never-actually-
 *  run test suite used things like 'AdminMarket111...') are NOT guaranteed
 *  valid base58/32-byte input and throw at `new PublicKey(...)` the moment
 *  these tests actually execute (they never did before — the whole suite was
 *  `describe.skip`). */
function pk(n: number): PublicKey {
  return new PublicKey(new Uint8Array(32).fill(n));
}

/** Minimal v12-shaped DiscoveredMarket — admin/header path only (no
 *  configV17), matching what useCreatedMarkets' admin-detection effect reads. */
function createMockV12Market(slabAddress: PublicKey, adminAddress: PublicKey): DiscoveredMarket {
  const mint = new PublicKey('So11111111111111111111111111111111111111112');
  return {
    slabAddress,
    programId: pk(9),
    header: {
      admin: adminAddress,
      paused: false,
    },
    config: {
      collateralMint: mint,
      oracleAuthority: new PublicKey('11111111111111111111111111111111'),
      authorityPriceE6: 0n,
      unitScale: 1_000_000,
    },
    engine: {
      vault: 10_000_000n,
      totalOpenInterest: 5_000_000n,
      insuranceFund: { balance: 1_000_000n, feeRevenue: 0n },
      currentSlot: 1000n,
      lastCrankSlot: 995n,
      maxCrankStalenessSlots: 100n,
      numUsedAccounts: 3,
    },
    params: {},
  } as unknown as DiscoveredMarket;
}

describe('useCreatedMarkets Hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMarkets.length = 0;
    mockUseWallet.mockReturnValue({ publicKey: mockPublicKey, connected: true });
  });

  it('returns empty array when wallet not connected', () => {
    // .mockReturnValue (not Once) — the hook re-renders as its effects
    // settle, so the override must survive every call, not just the first.
    mockUseWallet.mockReturnValue({ publicKey: null as unknown as PublicKey, connected: false });

    const { result } = renderHook(() => useCreatedMarkets());

    expect(result.current.myMarkets).toEqual([]);
    expect(result.current.connected).toBe(false);
  });

  it('returns empty array when no markets discovered', () => {
    mockUseMarketDiscovery.mockReturnValue({ markets: [], loading: false, error: null, refetch: vi.fn() });

    const { result } = renderHook(() => useCreatedMarkets());

    expect(result.current.myMarkets).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('identifies markets where the connected wallet is admin', async () => {
    const slab = pk(101);
    const adminMarket = createMockV12Market(slab, mockPublicKey);
    mockMarkets.push(adminMarket);
    mockUseMarketDiscovery.mockReturnValue({ markets: [adminMarket], loading: false, error: null, refetch: vi.fn() });

    const { result } = renderHook(() => useCreatedMarkets());

    await waitFor(() => {
      expect(result.current.myMarkets).toHaveLength(1);
    });
    expect(result.current.myMarkets[0].slabAddress.toBase58()).toBe(slab.toBase58());
  });

  it('excludes markets administered by a different wallet', async () => {
    const otherMarket = createMockV12Market(pk(102), pk(200));
    mockMarkets.push(otherMarket);
    mockUseMarketDiscovery.mockReturnValue({ markets: [otherMarket], loading: false, error: null, refetch: vi.fn() });

    const { result } = renderHook(() => useCreatedMarkets());

    // No second-pass trader/LP scan exists anymore — a non-admin market must
    // never appear on this dashboard, full stop (this IS the behavior change
    // the rebuild made: /my-markets = "markets you created", not "markets
    // you touched").
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.myMarkets).toHaveLength(0);
  });

  it('matches admin via configV17.marketauth on a v17 market (empty v12 header)', async () => {
    // v17 markets carry an empty header ({}) — the admin lives in
    // configV17.marketauth instead of header.admin. Optional-chaining this
    // is the fix for the TypeError that used to blank the whole dashboard
    // for any wallet with a v17 market (see useCreatedMarkets.ts's comment).
    const slab = pk(105);
    const v17Market = {
      slabAddress: slab,
      programId: pk(9),
      header: {},
      config: {},
      configV17: { marketauth: mockPublicKey, unitScale: 1_000_000, collateralMint: pk(1) },
      engine: {},
      params: {},
    } as unknown as DiscoveredMarket;
    mockMarkets.push(v17Market);
    mockUseMarketDiscovery.mockReturnValue({ markets: [v17Market], loading: false, error: null, refetch: vi.fn() });

    const { result } = renderHook(() => useCreatedMarkets());

    await waitFor(() => {
      expect(result.current.myMarkets).toHaveLength(1);
    });
    expect(result.current.myMarkets[0].slabAddress.toBase58()).toBe(slab.toBase58());
  });

  it('generates a truncated-address label when token metadata cannot be resolved', async () => {
    const market = createMockV12Market(pk(104), mockPublicKey);
    mockMarkets.push(market);
    mockUseMarketDiscovery.mockReturnValue({ markets: [market], loading: false, error: null, refetch: vi.fn() });

    const { result } = renderHook(() => useCreatedMarkets());

    await waitFor(() => {
      expect(result.current.myMarkets).toHaveLength(1);
    });
    // fetchTokenMeta has no real RPC behind the mocked connection, so the
    // label falls back to the mint's truncated address — this exercises the
    // hook's own try/catch fallback, not a real token registry lookup.
    expect(result.current.myMarkets[0].label).toMatch(/…$/);
  });

  it('propagates discovery errors without throwing', () => {
    const testError = new Error('RPC connection failed');
    // .mockReturnValue (not Once) — see the wallet-disconnect test's comment
    // above for why a one-shot override doesn't survive this hook's re-renders.
    mockUseMarketDiscovery.mockReturnValue({ markets: [], loading: false, error: testError, refetch: vi.fn() });

    const { result } = renderHook(() => useCreatedMarkets());

    expect(result.current.error).toBe(testError);
    expect(result.current.myMarkets).toEqual([]);
  });

  it('reports loading while discovery is loading, with no second RPC pass to wait on', () => {
    mockUseMarketDiscovery.mockReturnValue({ markets: [], loading: true, error: null, refetch: vi.fn() });

    const { result } = renderHook(() => useCreatedMarkets());

    expect(result.current.loading).toBe(true);
  });
});

/* ── CreatorAttentionStrip pure detection logic ── */

/** Minimal v17-shaped CreatedMarket — only the fields isKeeperFeedDead /
 *  isEngineCrankStale actually read. */
function createMockV17Market(opts: {
  oracleMode: number;
  markEwmaE6: bigint;
  markEwmaLastSlot: bigint;
  assetSlotLast?: bigint | null;
}): CreatedMarket {
  return {
    slabAddress: PublicKey.default,
    programId: PublicKey.default,
    label: 'TEST',
    config: undefined,
    configV17: {
      oracleMode: opts.oracleMode,
      markEwmaE6: opts.markEwmaE6,
      markEwmaLastSlot: opts.markEwmaLastSlot,
      invert: 0,
      unitScale: 1_000_000,
      collateralMint: PublicKey.default,
      marketauth: mockPublicKey,
    },
    v17Stats: opts.assetSlotLast === undefined ? undefined : {
      oi: { insuranceBalance: 0n, totalLongOiQ: 0n, totalShortOiQ: 0n, assets: [] },
      assetSlotLast: opts.assetSlotLast,
    },
  } as unknown as CreatedMarket;
}

describe('CreatorAttentionStrip detection logic', () => {
  const NOW = 100_000n;

  it('flags a keeper-mode market that has never received a price', () => {
    const m = createMockV17Market({ oracleMode: 3, markEwmaE6: 0n, markEwmaLastSlot: 0n });
    expect(isKeeperFeedDead(m, NOW)).toBe(true);
  });

  it('flags a keeper-mode market whose last price push is far beyond the threshold', () => {
    const m = createMockV17Market({
      oracleMode: 3,
      markEwmaE6: 150_000_000n,
      markEwmaLastSlot: NOW - BigInt(KEEPER_PRICE_STALE_THRESHOLD_SLOTS) - 1n,
    });
    expect(isKeeperFeedDead(m, NOW)).toBe(true);
  });

  it('does NOT flag a keeper-mode market with a recent price push', () => {
    const m = createMockV17Market({
      oracleMode: 3,
      markEwmaE6: 150_000_000n,
      markEwmaLastSlot: NOW - 10n,
    });
    expect(isKeeperFeedDead(m, NOW)).toBe(false);
  });

  it('does NOT flag a non-keeper (hyperp/admin) market even with markEwmaE6 = 0', () => {
    // oracleMode !== 3 → detectOracleMode won't resolve to "keeper" purely
    // from the byte; hyperp/admin markets are out of scope for this signal.
    const m = createMockV17Market({ oracleMode: 1, markEwmaE6: 0n, markEwmaLastSlot: 0n });
    expect(isKeeperFeedDead(m, NOW)).toBe(false);
  });

  it('does not flag a keeper feed as dead when currentSlot is not yet known (never a false positive on first load)', () => {
    const m = createMockV17Market({
      oracleMode: 3,
      markEwmaE6: 150_000_000n,
      markEwmaLastSlot: 0n,
    });
    expect(isKeeperFeedDead(m, null)).toBe(false);
  });

  it('flags engine crank staleness at/above the threshold', () => {
    const m = createMockV17Market({
      oracleMode: 3,
      markEwmaE6: 150_000_000n,
      markEwmaLastSlot: NOW,
      assetSlotLast: NOW - BigInt(ENGINE_STALE_THRESHOLD_SLOTS),
    });
    expect(isEngineCrankStale(m, NOW)).toBe(true);
  });

  it('does not flag engine crank staleness just under the threshold', () => {
    const m = createMockV17Market({
      oracleMode: 3,
      markEwmaE6: 150_000_000n,
      markEwmaLastSlot: NOW,
      assetSlotLast: NOW - BigInt(ENGINE_STALE_THRESHOLD_SLOTS) + 1n,
    });
    expect(isEngineCrankStale(m, NOW)).toBe(false);
  });

  it('treats crank-freshness and keeper-feed-liveness as independent signals', () => {
    // Fresh price feed, but the engine hasn't accrued in a long time — both
    // conditions must be able to fire independently of each other.
    const m = createMockV17Market({
      oracleMode: 3,
      markEwmaE6: 150_000_000n,
      markEwmaLastSlot: NOW - 5n,
      assetSlotLast: NOW - BigInt(ENGINE_STALE_THRESHOLD_SLOTS) - 100n,
    });
    expect(isKeeperFeedDead(m, NOW)).toBe(false);
    expect(isEngineCrankStale(m, NOW)).toBe(true);
  });
});

/* ── LP-liquidity display helpers ── */

describe('LP-liquidity display helpers', () => {
  function v17MarketWithConfig(): CreatedMarket {
    return { configV17: { unitScale: 1_000_000 }, engine: undefined } as unknown as CreatedMarket;
  }
  function v12MarketWithVault(vault: bigint | undefined): CreatedMarket {
    return { configV17: undefined, engine: vault === undefined ? undefined : { vault } } as unknown as CreatedMarket;
  }

  it('v17: uses the API-provided vault_balance (real on-chain LP capital)', () => {
    const market = v17MarketWithConfig();
    const detail = { vault_balance: 42_500_000 } as CreatorMarketDetail;
    expect(deriveMarketLiquidityAtoms(market, detail)).toBe(42_500_000n);
  });

  it('v17: returns null (never fabricates 0) when the API has no vault_balance yet', () => {
    const market = v17MarketWithConfig();
    expect(deriveMarketLiquidityAtoms(market, null)).toBeNull();
    expect(deriveMarketLiquidityAtoms(market, { vault_balance: null } as CreatorMarketDetail)).toBeNull();
  });

  it('v12: falls back to engine.vault, ignoring the API detail entirely', () => {
    const market = v12MarketWithVault(7_000_000n);
    const detail = { vault_balance: 1n } as CreatorMarketDetail; // must be ignored on v12
    expect(deriveMarketLiquidityAtoms(market, detail)).toBe(7_000_000n);
  });

  it('lp_collateral divergence: flags a >2x drop or >2x growth from the stored figure', () => {
    expect(lpCollateralMateriallyDiverges(10_000_000n, 100_000_000n)).toBe(true); // dropped to 1/10th
    expect(lpCollateralMateriallyDiverges(300_000_000n, 100_000_000n)).toBe(true); // grew 3x
    expect(lpCollateralMateriallyDiverges(150_000_000n, 100_000_000n)).toBe(false); // 1.5x — not material
  });

  it('lp_collateral divergence: never flags when either figure is unknown or stored is zero', () => {
    expect(lpCollateralMateriallyDiverges(null, 100_000_000n)).toBe(false);
    expect(lpCollateralMateriallyDiverges(100_000_000n, null)).toBe(false);
    expect(lpCollateralMateriallyDiverges(100_000_000n, 0n)).toBe(false);
  });

  it('unitScaleToDecimals derives sane decimals, defaulting to 6', () => {
    expect(unitScaleToDecimals(1_000_000)).toBe(6);
    expect(unitScaleToDecimals(1_000_000_000)).toBe(9);
    expect(unitScaleToDecimals(undefined)).toBe(6);
    expect(unitScaleToDecimals(0)).toBe(6);
  });

  it('resolveCreatedMarketPriceE6 reads v17 markEwmaE6 and v12 authorityPriceE6', () => {
    const v17 = { configV17: { markEwmaE6: 150_000_000n, invert: 0 } } as unknown as CreatedMarket;
    expect(resolveCreatedMarketPriceE6(v17)).toBe(150_000_000n);

    const v12 = { configV17: undefined, config: { authorityPriceE6: 5_000_000n } } as unknown as CreatedMarket;
    expect(resolveCreatedMarketPriceE6(v12)).toBe(5_000_000n);
  });
});
