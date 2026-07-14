import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';

const mocks = vi.hoisted(() => ({
  discoverMarketsViaProgramDirectory: vi.fn(),
  getNetwork: vi.fn(),
  isV17Account: vi.fn(),
  parseWrapperConfigV17: vi.fn(),
  parseV17RiskParams: vi.fn(),
}));

vi.mock('@/lib/market-directory-discovery', () => ({
  discoverMarketsViaProgramDirectory: mocks.discoverMarketsViaProgramDirectory,
}));

vi.mock('@/lib/config', () => ({
  getAllProgramIds: vi.fn(() => []),
  getNetwork: mocks.getNetwork,
}));

vi.mock('@/lib/v17-engine-config', () => ({
  parseV17RiskParams: mocks.parseV17RiskParams,
}));

vi.mock('@percolatorct/sdk', async () => {
  const actual = await vi.importActual<typeof import('@percolatorct/sdk')>('@percolatorct/sdk');

  return {
    ...actual,
    isV17Account: mocks.isV17Account,
    parseWrapperConfigV17: mocks.parseWrapperConfigV17,
  };
});

import {
  fetchPortfolioSnapshot,
  loadPortfolioShared,
  peekPortfolioSnapshot,
} from '@/hooks/usePortfolio';

type PortfolioSnapshot = Awaited<ReturnType<typeof fetchPortfolioSnapshot>>;

let publicKeyByte = 1;

function uniquePublicKey(): PublicKey {
  const value = publicKeyByte++;
  return new PublicKey(new Uint8Array(32).fill(value));
}

function makeMarket(slabAddress: PublicKey) {
  const collateralMint = uniquePublicKey();

  return {
    slabAddress,
    config: { collateralMint },
    configV17: { collateralMint },
  };
}

function makeLastGoodSnapshot(): PortfolioSnapshot {
  return {
    positions: [
      { slabAddress: 'complete-market-a' },
      { slabAddress: 'complete-market-b' },
    ] as unknown as PortfolioSnapshot['positions'],
    totalPnl: 30n,
    totalDeposited: 2_000n,
    totalValue: 2_030n,
    totalUnrealizedPnl: 30n,
    atRiskCount: 0,
  };
}

function makeOwnerScanFailureScenario() {
  const wallet = uniquePublicKey();

  const discoveryProgramA = uniquePublicKey();
  const discoveryProgramB = uniquePublicKey();

  const wrapperProgramA = uniquePublicKey();
  const wrapperProgramB = uniquePublicKey();

  const slabA = uniquePublicKey();
  const slabB = uniquePublicKey();

  const marketA = makeMarket(slabA);
  const marketB = makeMarket(slabB);

  mocks.discoverMarketsViaProgramDirectory.mockImplementation(
    async (_connection: unknown, programId: PublicKey) => {
      if (programId.equals(discoveryProgramA)) {
        return [marketA];
      }

      if (programId.equals(discoveryProgramB)) {
        return [marketB];
      }

      return [];
    },
  );

  const getMultipleAccountsInfo = vi.fn().mockResolvedValue([
    {
      data: Buffer.alloc(256),
      owner: wrapperProgramA,
    },
    {
      data: Buffer.alloc(256),
      owner: wrapperProgramB,
    },
  ]);

  const ownerScanError = new Error('429 Too Many Requests during v17 owner scan');

  const getProgramAccounts = vi.fn(async (programId: PublicKey) => {
    if (programId.equals(wrapperProgramA)) {
      return [
        {
          pubkey: uniquePublicKey(),
          account: { data: Buffer.alloc(1) },
        },
      ];
    }

    if (programId.equals(wrapperProgramB)) {
      throw ownerScanError;
    }

    // NFT recovery or any unrelated best-effort scan.
    return [];
  });

  const connection = {
    getMultipleAccountsInfo,
    getProgramAccounts,
  } as unknown as Parameters<typeof fetchPortfolioSnapshot>[0];

  return {
    connection,
    wallet,
    programIds: [discoveryProgramA.toBase58(), discoveryProgramB.toBase58()],
    getProgramAccounts,
    ownerScanError,
  };
}

describe('usePortfolio v17 owner-scan behavioral regression', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.getNetwork.mockReturnValue('devnet');
    mocks.isV17Account.mockReturnValue(true);

    mocks.parseWrapperConfigV17.mockReturnValue({
      markEwmaE6: 1_000_000n,
      tradeFeeBps: 30n,
    });

    mocks.parseV17RiskParams.mockReturnValue({
      maintenanceMarginBps: 600n,
      initialMarginBps: 1_000n,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ markets: [] }),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not publish or cache a partial snapshot when one v17 program scan fails', async () => {
    const scenario = makeOwnerScanFailureScenario();
    const cacheKey = `owner-scan-empty:${uniquePublicKey().toBase58()}`;

    await expect(
      loadPortfolioShared(cacheKey, true, () =>
        fetchPortfolioSnapshot(scenario.connection, scenario.wallet, scenario.programIds),
      ),
    ).rejects.toThrow(scenario.ownerScanError.message);

    expect(scenario.getProgramAccounts).toHaveBeenCalledTimes(2);
    expect(peekPortfolioSnapshot(cacheKey)).toBeNull();
  });

  it('preserves the last-good complete snapshot after a failed forced refresh', async () => {
    const scenario = makeOwnerScanFailureScenario();
    const cacheKey = `owner-scan-last-good:${uniquePublicKey().toBase58()}`;
    const lastGoodSnapshot = makeLastGoodSnapshot();

    await expect(loadPortfolioShared(cacheKey, true, async () => lastGoodSnapshot)).resolves.toBe(
      lastGoodSnapshot,
    );

    expect(peekPortfolioSnapshot(cacheKey)).toBe(lastGoodSnapshot);

    await expect(
      loadPortfolioShared(cacheKey, true, () =>
        fetchPortfolioSnapshot(scenario.connection, scenario.wallet, scenario.programIds),
      ),
    ).rejects.toThrow(scenario.ownerScanError.message);

    const cachedAfterFailure = peekPortfolioSnapshot(cacheKey);

    expect(cachedAfterFailure).toBe(lastGoodSnapshot);
    expect(cachedAfterFailure?.positions).toHaveLength(2);
    expect(cachedAfterFailure?.totalDeposited).toBe(2_000n);
    expect(cachedAfterFailure?.totalValue).toBe(2_030n);
  });
});
