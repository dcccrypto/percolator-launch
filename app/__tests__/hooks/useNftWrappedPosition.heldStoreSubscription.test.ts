/**
 * useNftWrappedPosition — v17 shared scan + batching + keep-last-good.
 *
 * Companion to __tests__/hooks/usePositionNft.sharedScan.test.ts: this hook
 * used to run its OWN held-NFT getProgramAccounts scan (byte-for-byte
 * identical to usePositionNft's fallback scan) plus a serial getAccountInfo
 * per held NFT. It now joins the shared held-NFT store in
 * lib/userAccountScan.ts and batches the wrapped-portfolio lookups into one
 * getMultipleAccountsInfo call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { Keypair, PublicKey } from "@solana/web3.js";

const mocks = vi.hoisted(() => ({
  useConnectionCompat: vi.fn(),
  useWalletCompat: vi.fn(),
  useSlabState: vi.fn(),
  isV17Account: vi.fn(),
  parsePortfolioV17: vi.fn(),
  parsePositionNftAccount: vi.fn(),
}));

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: mocks.useConnectionCompat,
  useWalletCompat: mocks.useWalletCompat,
}));

vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: mocks.useSlabState,
}));

vi.mock("@/lib/v22/layout", async (orig) => ({
  ...(await orig<typeof import("@/lib/v22/layout")>()),
  isWrapperAccount: mocks.isV17Account,
  parsePortfolio: mocks.parsePortfolioV17,
}));
vi.mock("@percolatorct/sdk", async () => {
  const actual = await vi.importActual<typeof import("@percolatorct/sdk")>("@percolatorct/sdk");
  return {
    ...actual,
    isV17Account: mocks.isV17Account,
    parsePortfolioV17: mocks.parsePortfolioV17,
    parsePositionNftAccount: mocks.parsePositionNftAccount,
  };
});

// S1-2: the app parses NFTs with its own v3 port (the installed SDK 8.0.0 parser rejects version 3). These tests drive the
// parser through `mocks.parsePositionNftAccount`; the stand-in returns a LEGACY (unbound, never stale) record merged with it.
vi.mock("@/lib/v22/sdk/nft-v3", async () => {
  const actual = await vi.importActual<typeof import("@/lib/v22/sdk/nft-v3")>("@/lib/v22/sdk/nft-v3");
  return {
    ...actual,
    parsePositionNftAccountV3: (d: Uint8Array) => ({ isLegacyV2: true, portfolioMarketGroup: null, portfolioIdAtMint: null, ...mocks.parsePositionNftAccount(d) }),
  };
});

import { useNftWrappedPosition } from "@/hooks/useNftWrappedPosition";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { __setUnknownLotExpForTest } from "@/lib/v22/lot-registry";


/** The held-NFT scan runs once per layout (239 = v3, 199 = legacy v2); these fixtures are legacy 199 B records. */
const legacyLayoutOnly = (list: unknown[]) => async (_pid: unknown, cfg: { filters: Array<{ dataSize?: number }> }) =>
  cfg.filters[0].dataSize === 199 ? list : [];

function uniquePubkey(): PublicKey {
  return Keypair.generate().publicKey;
}

function emptyPortfolio(marketGroupId: PublicKey, activeLegBasisPosQ: bigint | null) {
  return {
    marketGroupId,
    portfolioAccountId: uniquePubkey(),
    provenanceOwner: PublicKey.default,
    owner: PublicKey.default,
    capital: 0n,
    pnl: 0n,
    reservedPnl: 0n,
    residualCrystallizedLossAtomsTotal: 0n,
    residualSpentPrincipalAtomsTotal: 0n,
    residualReceivedAtomsTotal: 0n,
    feeCredits: 0n,
    cancelDepositEscrow: 0n,
    lastFeeSlot: 0n,
    activeBitmap: activeLegBasisPosQ !== null ? 1n : 0n,
    legs:
      activeLegBasisPosQ !== null
        ? [{ active: true, assetIndex: 0, marketId: 1n, side: 0, basisPosQ: activeLegBasisPosQ }]
        : [],
    sourceDomains: [],
  };
}

describe("useNftWrappedPosition — subscribes to the held-NFT store (throttled trailing scan)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("picks up the trailing scan result without a further raw change", async () => {
    __setUnknownLotExpForTest(0);
    vi.clearAllMocks();
    const wallet = uniquePubkey();
    const slabAddress = uniquePubkey().toBase58();
    const slabPk = new PublicKey(slabAddress);
    const connection = {
      getProgramAccounts: vi.fn(async () => [] as unknown[]),
      getAccountInfo: vi.fn(),
      getMultipleAccountsInfo: vi.fn().mockResolvedValue([{ data: Buffer.alloc(1) }]),
    };
    mocks.useWalletCompat.mockReturnValue({ publicKey: wallet, connected: true });
    mocks.useConnectionCompat.mockReturnValue({ connection });
    mocks.isV17Account.mockReturnValue(true);
    let raw = new Uint8Array([1]);
    mocks.useSlabState.mockImplementation(() => ({ raw }));

    // Only Date + setTimeout are faked, so React/testing-library microtasks still flow.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    // First scan: wallet holds nothing.
    const { result, rerender } = renderHook(() => useNftWrappedPosition(slabAddress, true));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(result.current).toBeNull();

    // An NFT now exists on chain; a raw change lands INSIDE the throttle window, so the scan is deferred.
    connection.getProgramAccounts.mockImplementation(legacyLayoutOnly([{ pubkey: uniquePubkey(), account: { data: new Uint8Array(199) } }]));
    mocks.parsePositionNftAccount.mockReturnValue({ nftMint: uniquePubkey(), portfolioAccount: uniquePubkey() });
    mocks.parsePortfolioV17.mockReturnValue(emptyPortfolio(slabPk, 7n));
    raw = new Uint8Array([2]);
    rerender();
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(result.current).toBeNull(); // stale snapshot while throttled

    // No further raw change: the trailing scan publishes and the hook must pick it up on its own.
    await act(async () => { await vi.advanceTimersByTimeAsync(11_000); });
    expect(result.current?.account.positionSize).toBe(7n);
  });
});
