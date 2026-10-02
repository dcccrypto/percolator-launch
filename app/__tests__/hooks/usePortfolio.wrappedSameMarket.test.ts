/**
 * usePortfolio deduped the NFT recovery pass by MARKET, so a wallet that wrapped a position and
 * then owned a fresh portfolio on the same market (any deposit or trade there creates one:
 * InitPortfolio has no per-(market, owner) uniqueness) lost the wrapped row and its collateral.
 * It now dedups by portfolio account.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';

const mocks = vi.hoisted(() => ({
  discoverMarketsViaProgramDirectory: vi.fn(),
  getNetwork: vi.fn(),
  isV17Account: vi.fn(),
  parseWrapperConfigV17: vi.fn(),
  parsePortfolioV17: vi.fn(),
  parsePositionNftAccount: vi.fn(),
  parseV17RiskParams: vi.fn(),
}));

vi.mock('@/lib/market-directory-discovery', () => ({
  discoverMarketsViaProgramDirectory: mocks.discoverMarketsViaProgramDirectory,
}));
vi.mock('@/lib/config', () => ({ getAllProgramIds: vi.fn(() => []), getNetwork: mocks.getNetwork }));
vi.mock('@/lib/v17-engine-config', () => ({ parseV17RiskParams: mocks.parseV17RiskParams }));
vi.mock('@percolatorct/sdk', async () => {
  const actual = await vi.importActual<typeof import('@percolatorct/sdk')>('@percolatorct/sdk');
  return {
    ...actual,
    isV17Account: mocks.isV17Account,
    parseWrapperConfigV17: mocks.parseWrapperConfigV17,
    parsePortfolioV17: mocks.parsePortfolioV17,
    parsePositionNftAccount: mocks.parsePositionNftAccount,
  };
});

import { fetchPortfolioSnapshot, positionRowKeys, type PortfolioPosition } from '@/hooks/usePortfolio';
import { PERCOLATOR_NFT_PROGRAM_ID } from '@/lib/nft-program';

let b = 101;
const pk = () => new PublicKey(new Uint8Array(32).fill(b++));

// Portfolio bytes are opaque to the code under test (parsePortfolioV17 is
// mocked); the first byte tags which account is which.
const tagged = (tag: number) => {
  const d = Buffer.alloc(300);
  d[0] = tag;
  return d;
};

function scenario(wrappedCount: 1 | 2) {
  const wallet = pk();
  const escrow = pk();
  const prog = pk();
  const wrapperProgram = pk();
  const slab = pk();
  const collateralMint = pk();
  mocks.discoverMarketsViaProgramDirectory.mockResolvedValue([
    { slabAddress: slab, config: { collateralMint }, configV17: { collateralMint } },
  ]);

  // Tag 1: the fresh portfolio the wallet still OWNS on this market (idle,
  // 500 deposited). Tags 2/3: portfolios wrapped into Position NFTs (owner =
  // escrow PDA), each with a live leg.
  mocks.parsePortfolioV17.mockImplementation((d: Uint8Array) => {
    const tag = d[0];
    if (tag === 1) {
      return { owner: wallet, marketGroupId: slab, capital: 500n, pnl: 0n, reservedPnl: 0n, feeCredits: 0n, lastFeeSlot: 0n, legs: [] };
    }
    return {
      owner: escrow, marketGroupId: slab, capital: tag === 2 ? 1_000n : 2_000n, pnl: 0n, reservedPnl: 0n,
      feeCredits: 0n, lastFeeSlot: 0n, legs: [{ active: true, basisPosQ: 5n }],
    };
  });
  const wrappedPfs = [pk(), pk()].slice(0, wrappedCount);
  mocks.parsePositionNftAccount.mockImplementation((d: Uint8Array) => ({ portfolioAccount: wrappedPfs[d[0]] }));

  const getMultipleAccountsInfo = vi
    .fn()
    // 1st call: slab batch.
    .mockResolvedValueOnce([{ data: Buffer.alloc(256), owner: wrapperProgram }])
    // 2nd call: escrowed portfolios the NFTs point at.
    .mockResolvedValueOnce(wrappedPfs.map((_, i) => ({ data: tagged(2 + i) })));
  const getProgramAccounts = vi.fn(async (programId: PublicKey) => {
    if (programId.equals(wrapperProgram)) return [{ pubkey: pk(), account: { data: tagged(1) } }];
    if (programId.equals(PERCOLATOR_NFT_PROGRAM_ID)) {
      return wrappedPfs.map((_, i) => ({ pubkey: pk(), account: { data: Buffer.from([i]) } }));
    }
    return [];
  });
  const connection = { getMultipleAccountsInfo, getProgramAccounts } as unknown as Parameters<typeof fetchPortfolioSnapshot>[0];
  return { connection, wallet, programIds: [prog.toBase58()], slab };
}

describe('usePortfolio: wrapped position on a market where the wallet also owns a portfolio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getNetwork.mockReturnValue('devnet');
    mocks.isV17Account.mockReturnValue(true);
    mocks.parseWrapperConfigV17.mockReturnValue({ markEwmaE6: 1_000_000n, tradeFeeBps: 30n });
    mocks.parseV17RiskParams.mockReturnValue({ maintenanceMarginBps: 600n, initialMarginBps: 1_000n });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ markets: [] }) })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('lists the wrapped position alongside the owned one and counts its collateral', async () => {
    const s = scenario(1);
    const snap = await fetchPortfolioSnapshot(s.connection, s.wallet, s.programIds);
    expect(snap.positions.map((p) => p.nftWrapped).sort()).toEqual([false, true]);
    expect(snap.positions.every((p) => p.slabAddress === s.slab.toBase58())).toBe(true);
    expect(snap.totalDeposited).toBe(1_500n);
  });

  it('lists two wrapped positions on the same market', async () => {
    const s = scenario(2);
    const snap = await fetchPortfolioSnapshot(s.connection, s.wallet, s.programIds);
    expect(snap.positions.filter((p) => p.nftWrapped)).toHaveLength(2);
    expect(snap.totalDeposited).toBe(3_500n);
  });
});

describe('usePortfolio: same portfolio seen by both scans (stale NFT / slot skew)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getNetwork.mockReturnValue('devnet');
    mocks.isV17Account.mockReturnValue(true);
    mocks.parseWrapperConfigV17.mockReturnValue({ markEwmaE6: 1_000_000n, tradeFeeBps: 30n });
    mocks.parseV17RiskParams.mockReturnValue({ maintenanceMarginBps: 600n, initialMarginBps: 1_000n });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ markets: [] }) })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('lists the portfolio once and does not double count it', async () => {
    const wallet = pk();
    const wrapperProgram = pk();
    const slab = pk();
    const collateralMint = pk();
    const pf = pk();
    mocks.discoverMarketsViaProgramDirectory.mockResolvedValue([
      { slabAddress: slab, config: { collateralMint }, configV17: { collateralMint } },
    ]);
    // Owned by the wallet (already unwrapped), yet an NFT held by the wallet
    // still points at it.
    mocks.parsePortfolioV17.mockReturnValue({
      owner: wallet, marketGroupId: slab, capital: 700n, pnl: 0n, reservedPnl: 0n,
      feeCredits: 0n, lastFeeSlot: 0n, legs: [{ active: true, basisPosQ: 5n }],
    });
    mocks.parsePositionNftAccount.mockReturnValue({ portfolioAccount: pf });
    const getMultipleAccountsInfo = vi
      .fn()
      .mockResolvedValueOnce([{ data: Buffer.alloc(256), owner: wrapperProgram }])
      .mockResolvedValueOnce([{ data: tagged(1) }]);
    const getProgramAccounts = vi.fn(async (programId: PublicKey) => {
      if (programId.equals(wrapperProgram)) return [{ pubkey: pf, account: { data: tagged(1) } }];
      if (programId.equals(PERCOLATOR_NFT_PROGRAM_ID)) return [{ pubkey: pk(), account: { data: Buffer.from([0]) } }];
      return [];
    });
    const connection = { getMultipleAccountsInfo, getProgramAccounts } as unknown as Parameters<typeof fetchPortfolioSnapshot>[0];
    const snap = await fetchPortfolioSnapshot(connection, wallet, [pk().toBase58()]);
    expect(snap.positions).toHaveLength(1);
    expect(snap.positions[0].nftWrapped).toBe(false);
    expect(snap.totalDeposited).toBe(700n);
  });

  it("lists the portfolio once when a wrap lands between the owner scan and the NFT read", async () => {
    const wallet = pk();
    const escrow = pk();
    const wrapperProgram = pk();
    const slab = pk();
    const collateralMint = pk();
    const pf = pk();
    mocks.discoverMarketsViaProgramDirectory.mockResolvedValue([
      { slabAddress: slab, config: { collateralMint }, configV17: { collateralMint } },
    ]);
    // Same account read twice: still wallet-owned at the owner scan (tag 1), escrowed with a
    // live leg by the time the NFT pass reads it (tag 2).
    mocks.parsePortfolioV17.mockImplementation((d: Uint8Array) =>
      d[0] === 1
        ? { owner: wallet, marketGroupId: slab, capital: 700n, pnl: 0n, reservedPnl: 0n, feeCredits: 0n, lastFeeSlot: 0n, legs: [{ active: true, basisPosQ: 5n }] }
        : { owner: escrow, marketGroupId: slab, capital: 700n, pnl: 0n, reservedPnl: 0n, feeCredits: 0n, lastFeeSlot: 0n, legs: [{ active: true, basisPosQ: 5n }] },
    );
    mocks.parsePositionNftAccount.mockReturnValue({ portfolioAccount: pf });
    const getMultipleAccountsInfo = vi
      .fn()
      .mockResolvedValueOnce([{ data: Buffer.alloc(256), owner: wrapperProgram }])
      .mockResolvedValueOnce([{ data: tagged(2) }]);
    const getProgramAccounts = vi.fn(async (programId: PublicKey) => {
      if (programId.equals(wrapperProgram)) return [{ pubkey: pf, account: { data: tagged(1) } }];
      if (programId.equals(PERCOLATOR_NFT_PROGRAM_ID)) return [{ pubkey: pk(), account: { data: Buffer.from([0]) } }];
      return [];
    });
    const connection = { getMultipleAccountsInfo, getProgramAccounts } as unknown as Parameters<typeof fetchPortfolioSnapshot>[0];
    const snap = await fetchPortfolioSnapshot(connection, wallet, [pk().toBase58()]);
    expect(snap.positions).toHaveLength(1);
    expect(snap.totalDeposited).toBe(700n);
  });
});

describe("positionRowKeys", () => {
  const p = (slabAddress: string, nftWrapped = false) => ({ slabAddress, nftWrapped }) as unknown as PortfolioPosition;

  it("gives an owned and a wrapped row on one market different keys", () => {
    const keys = positionRowKeys([p("A"), p("A", true), p("B")]);
    expect(new Set(keys).size).toBe(3);
  });

  it("keeps each row's key when other markets re-sort or drop out", () => {
    const before = positionRowKeys([p("A"), p("B"), p("C", true)]);
    const after = positionRowKeys([p("C", true), p("A")]);
    expect(after).toEqual([before[2], before[0]]);
  });

  it("never hands an owned row's key to the wrapped row on the same market", () => {
    const [owned, wrapped] = positionRowKeys([p("A"), p("A", true)]);
    expect(positionRowKeys([p("A", true), p("A")])).toEqual([wrapped, owned]);
  });
});
