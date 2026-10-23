/**
 * S1-2 stale-incarnation branches of the three NFT hooks (A-3). These live in their own file, and mock `@/lib/v22/layout`
 * (the seam the hooks really read through), so they run in ALL modes (flag off / V22 / V22+V21) and are NOT quarantined.
 * The NFT is parsed by the REAL `parsePositionNftAccountV3` on real v3 / legacy bytes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { Keypair, PublicKey } from "@solana/web3.js";

const mocks = vi.hoisted(() => ({
  discoverMarketsViaProgramDirectory: vi.fn(),
  getNetwork: vi.fn(),
  isV17Account: vi.fn(),
  parseWrapperConfigV17: vi.fn(),
  parsePortfolioV17: vi.fn(),
  parsePositionNftAccount: vi.fn(),
  parseV17RiskParams: vi.fn(),
  useConnectionCompat: vi.fn(),
  useWalletCompat: vi.fn(),
  useSlabState: vi.fn(),
  useUserAccount: vi.fn(),
  deriveNftPda: vi.fn(),
  parsePortfolio: vi.fn(),
  deployedS12: false,
}));

vi.mock("@/lib/market-directory-discovery", () => ({ discoverMarketsViaProgramDirectory: mocks.discoverMarketsViaProgramDirectory }));
vi.mock("@/lib/config", () => ({ getAllProgramIds: vi.fn(() => []), getMarketDiscoveryProgramIds: vi.fn(() => []), getNetwork: mocks.getNetwork }));
vi.mock("@/lib/v17-engine-config", () => ({ parseV17RiskParams: mocks.parseV17RiskParams }));
vi.mock("@/hooks/useWalletCompat", () => ({ useConnectionCompat: mocks.useConnectionCompat, useWalletCompat: mocks.useWalletCompat }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: mocks.useSlabState }));
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: mocks.useUserAccount }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false }));
vi.mock("@percolatorct/sdk", async () => {
  const actual = await vi.importActual<typeof import("@percolatorct/sdk")>("@percolatorct/sdk");
  return {
    ...actual,
    isV17Account: mocks.isV17Account,
    parseWrapperConfigV17: mocks.parseWrapperConfigV17,
    parsePortfolioV17: mocks.parsePortfolioV17,
    deriveNftPda: mocks.deriveNftPda,
  };
});
// The seam all three hooks decode portfolios through (flag-independent here).
vi.mock("@/lib/v22/layout", async () => {
  const actual = await vi.importActual<typeof import("@/lib/v22/layout")>("@/lib/v22/layout");
  return { ...actual, parsePortfolio: (d: Uint8Array) => mocks.parsePortfolioV17(d), isWrapperAccount: () => true };
});
// Per-cluster S1-2 deploy config: toggled per test (production flips it in the runbook step).
vi.mock("@/lib/program-ids", async () => {
  const actual = await vi.importActual<typeof import("@/lib/program-ids")>("@/lib/program-ids");
  return { ...actual, nftS12Deploy: () => ({ deployed: mocks.deployedS12, minDeploySlot: null }) };
});

import { fetchPortfolioSnapshot } from "@/hooks/usePortfolio";
import { usePositionNft } from "@/hooks/usePositionNft";
import { useNftWrappedPosition } from "@/hooks/useNftWrappedPosition";
import { PERCOLATOR_NFT_PROGRAM_ID } from "@/lib/nft-program";
import { resetNftIncarnationCache } from "@/lib/nft-incarnation";

const MAGIC = 0x5045_5243_4e46_5400n;
/** Real NFT account bytes: v3 (239 B) with the incarnation, or legacy v2 (199 B). */
function nftBytes(o: { portfolio: PublicKey; mint: PublicKey; v3?: { group: PublicKey; id: bigint } }): Buffer {
  const b = Buffer.alloc(o.v3 ? 239 : 199);
  b.writeBigUInt64LE(MAGIC, 0);
  b[8] = o.v3 ? 3 : 2;
  o.portfolio.toBuffer().copy(b, 10);
  o.mint.toBuffer().copy(b, 42);
  if (o.v3) {
    o.v3.group.toBuffer().copy(b, 199);
    b.writeBigUInt64LE(o.v3.id, 231);
  }
  return b;
}
const uniquePubkey = (): PublicKey => Keypair.generate().publicKey;

beforeEach(() => {
  vi.clearAllMocks();
  resetNftIncarnationCache();
  mocks.deployedS12 = false;
});

let b = 101;
const pk = () => new PublicKey(new Uint8Array(32).fill(b++));

// Portfolio bytes are opaque to the code under test (parsePortfolioV17 is
// mocked); the first byte tags which account is which.
const tagged = (tag: number) => {
  const d = Buffer.alloc(300);
  d[0] = tag;
  return d;
};

function scenario(wrappedCount: 1 | 2, inc: { nftId: bigint; liveId: bigint }) {
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
      feeCredits: 0n, lastFeeSlot: 0n, legs: [{ active: true, basisPosQ: 5n }], portfolioId: inc.liveId,
    };
  });
  const wrappedPfs = [pk(), pk()].slice(0, wrappedCount);


  const getMultipleAccountsInfo = vi
    .fn()
    // 1st call: slab batch.
    .mockResolvedValueOnce([{ data: Buffer.alloc(256), owner: wrapperProgram }])
    // 2nd call: escrowed portfolios the NFTs point at.
    .mockResolvedValueOnce(wrappedPfs.map((_, i) => ({ data: tagged(2 + i) })));
  const getProgramAccounts = vi.fn(async (programId: PublicKey, cfg?: { filters?: Array<{ dataSize?: number }> }) => {
    if (programId.equals(wrapperProgram)) return [{ pubkey: pk(), account: { data: tagged(1) } }];
    if (programId.equals(PERCOLATOR_NFT_PROGRAM_ID)) {
      if (cfg?.filters?.[0]?.dataSize === 239) return [];
      return wrappedPfs.map((pf) => ({ pubkey: pk(), account: { data: nftBytes({ portfolio: pf, mint: pk(), v3: { group: slab, id: inc.nftId } }) } }));
    }
    return [];
  });
  const connection = { getMultipleAccountsInfo, getProgramAccounts } as unknown as Parameters<typeof fetchPortfolioSnapshot>[0];
  return { connection, wallet, programIds: [prog.toBase58()], slab };
}


describe("usePortfolio (S1-2): wrapped position by NFT incarnation", () => {
  beforeEach(() => {
    mocks.getNetwork.mockReturnValue("devnet");
    mocks.isV17Account.mockReturnValue(true);
    mocks.parseWrapperConfigV17.mockReturnValue({ markEwmaE6: 1_000_000n, tradeFeeBps: 30n });
    mocks.parseV17RiskParams.mockReturnValue({ maintenanceMarginBps: 600n, initialMarginBps: 1_000n });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ markets: [] }) })));
  });
  afterEach(() => vi.unstubAllGlobals());
  it("an NFT of an EARLIER incarnation (id differs) is not listed as a position; a matching id is", async () => {
    const stale = scenario(1, { nftId: 5n, liveId: 9n });
    const s1 = await fetchPortfolioSnapshot(stale.connection, stale.wallet, stale.programIds);
    expect(s1.positions.map((p) => p.nftWrapped)).toEqual([false]);
    expect(s1.totalDeposited).toBe(500n);
    const cur = scenario(1, { nftId: 9n, liveId: 9n });
    const s2 = await fetchPortfolioSnapshot(cur.connection, cur.wallet, cur.programIds);
    expect(s2.positions.map((p) => p.nftWrapped).sort()).toEqual([false, true]);
  });
});

function portfolioFor(group: PublicKey, id: bigint, basis = 4n) {
  return {
    marketGroupId: group, portfolioId: id, portfolioAccountId: uniquePubkey(), provenanceOwner: PublicKey.default, owner: PublicKey.default,
    capital: 0n, pnl: 0n, reservedPnl: 0n, residualCrystallizedLossAtomsTotal: 0n, residualSpentPrincipalAtomsTotal: 0n,
    residualReceivedAtomsTotal: 0n, feeCredits: 0n, cancelDepositEscrow: 0n, lastFeeSlot: 0n, activeBitmap: 1n,
    legs: [{ active: true, assetIndex: 0, marketId: 1n, side: 0, basisPosQ: basis }], sourceDomains: [],
  };
}

describe("useNftWrappedPosition (S1-2)", () => {
  async function run(nft: { v3?: { id: bigint } }, liveId: bigint) {
    const wallet = uniquePubkey();
    const slabAddress = uniquePubkey().toBase58();
    const slabPk = new PublicKey(slabAddress);
    const connection = { getProgramAccounts: vi.fn(), getAccountInfo: vi.fn().mockResolvedValue(null), getMultipleAccountsInfo: vi.fn() };
    mocks.useWalletCompat.mockReturnValue({ publicKey: wallet, connected: true });
    mocks.useConnectionCompat.mockReturnValue({ connection });
    mocks.useSlabState.mockReturnValue({ raw: new Uint8Array([7]) });
    const pf = uniquePubkey();
    const bytes = nftBytes({ portfolio: pf, mint: uniquePubkey(), v3: nft.v3 && { group: slabPk, id: nft.v3.id } });
    connection.getProgramAccounts.mockImplementation(async (_p: PublicKey, cfg: { filters: Array<{ dataSize?: number }> }) =>
      cfg.filters[0].dataSize === bytes.length ? [{ pubkey: uniquePubkey(), account: { data: bytes } }] : []);
    connection.getMultipleAccountsInfo.mockResolvedValue([{ data: Buffer.alloc(1) }]);
    mocks.parsePortfolioV17.mockReturnValue(portfolioFor(slabPk, liveId));
    const r = renderHook(() => useNftWrappedPosition(slabAddress, true));
    return { ...r, connection };
  }
  it("a stale v3 NFT (re-created portfolio) is not surfaced as a wrapped position", async () => {
    const { result, connection } = await run({ v3: { id: 5n } }, 9n);
    await waitFor(() => expect(connection.getMultipleAccountsInfo).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toBeNull();
  });
  it("a current v3 NFT is surfaced", async () => {
    const { result } = await run({ v3: { id: 9n } }, 9n);
    await waitFor(() => expect(result.current?.account.positionSize).toBe(4n));
  });
  it("a legacy v2 NFT is surfaced while pre-S1-2, hidden once the S1-2 program is deployed", async () => {
    const pre = await run({}, 9n);
    await waitFor(() => expect(pre.result.current?.account.positionSize).toBe(4n));
    resetNftIncarnationCache();
    mocks.deployedS12 = true;
    const post = await run({}, 9n);
    await waitFor(() => expect(post.connection.getMultipleAccountsInfo).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(post.result.current).toBeNull();
  });
});

describe("usePositionNft (S1-2)", () => {
  async function run(nft: { v3?: { id: bigint } }, liveId: bigint) {
    const wallet = uniquePubkey();
    const programId = uniquePubkey();
    const slabAddress = uniquePubkey().toBase58();
    const slabPk = new PublicKey(slabAddress);
    const connection = { getProgramAccounts: vi.fn(), getAccountInfo: vi.fn().mockResolvedValue(null), getMultipleAccountsInfo: vi.fn() };
    mocks.useWalletCompat.mockReturnValue({ publicKey: wallet, connected: true });
    mocks.useConnectionCompat.mockReturnValue({ connection });
    mocks.useUserAccount.mockReturnValue(null);
    mocks.isV17Account.mockReturnValue(true);
    mocks.deriveNftPda.mockReturnValue([uniquePubkey(), 255]);
    mocks.useSlabState.mockReturnValue({ programId, raw: new Uint8Array([3]) });
    const pf = uniquePubkey();
    const mint = uniquePubkey();
    const bytes = nftBytes({ portfolio: pf, mint, v3: nft.v3 && { group: slabPk, id: nft.v3.id } });
    connection.getProgramAccounts.mockImplementation(async (pid: PublicKey, cfg: { filters: Array<{ dataSize?: number }> }) => {
      if (pid.equals(programId)) return [];
      return cfg.filters[0].dataSize === bytes.length ? [{ pubkey: uniquePubkey(), account: { data: bytes } }] : [];
    });
    connection.getMultipleAccountsInfo.mockResolvedValue([{ data: Buffer.alloc(1) }]);
    mocks.parsePortfolioV17.mockReturnValue(portfolioFor(slabPk, liveId, 3n));
    return { ...renderHook(() => usePositionNft(slabAddress)), mint };
  }
  it("a stale v3 NFT surfaces as stale + burnable (EmergencyBurn), never as a normal wrapped position", async () => {
    const { result, mint } = await run({ v3: { id: 5n } }, 9n);
    await waitFor(() => expect(result.current.stale).toBe(true));
    expect(result.current.staleKind).toBe("burnable");
    expect(result.current.hasMintedNft).toBe(true);
    expect(result.current.pendingSettlement).toBe(true);
    expect(result.current.nftMint?.equals(mint)).toBe(true);
  });
  it("a current v3 NFT is a normal wrapped position (not stale)", async () => {
    const { result } = await run({ v3: { id: 9n } }, 9n);
    await waitFor(() => expect(result.current.hasMintedNft).toBe(true));
    expect(result.current.stale).toBeFalsy();
    expect(result.current.pendingSettlement).toBe(false);
  });
  it("a legacy v2 NFT is a normal position while pre-S1-2", async () => {
    const { result } = await run({}, 9n);
    await waitFor(() => expect(result.current.hasMintedNft).toBe(true));
    expect(result.current.stale).toBeFalsy();
  });
  it("a legacy v2 NFT under the S1-2 program is stale + UNRECOVERABLE (no burn path)", async () => {
    mocks.deployedS12 = true;
    const { result } = await run({}, 9n);
    await waitFor(() => expect(result.current.stale).toBe(true));
    expect(result.current.staleKind).toBe("unrecoverable");
  });
});
