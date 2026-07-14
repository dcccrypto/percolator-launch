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
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
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

vi.mock("@percolatorct/sdk", async () => {
  const actual = await vi.importActual<typeof import("@percolatorct/sdk")>("@percolatorct/sdk");
  return {
    ...actual,
    isV17Account: mocks.isV17Account,
    parsePortfolioV17: mocks.parsePortfolioV17,
    parsePositionNftAccount: mocks.parsePositionNftAccount,
  };
});

import { useNftWrappedPosition } from "@/hooks/useNftWrappedPosition";

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

describe("useNftWrappedPosition — v17 shared scan + batching", () => {
  let wallet: PublicKey;
  let slabAddress: string;
  let connection: {
    getProgramAccounts: ReturnType<typeof vi.fn>;
    getAccountInfo: ReturnType<typeof vi.fn>;
    getMultipleAccountsInfo: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    wallet = uniquePubkey();
    slabAddress = uniquePubkey().toBase58();

    connection = {
      getProgramAccounts: vi.fn(),
      getAccountInfo: vi.fn(),
      getMultipleAccountsInfo: vi.fn().mockResolvedValue([]),
    };

    mocks.useWalletCompat.mockReturnValue({ publicKey: wallet, connected: true });
    mocks.useConnectionCompat.mockReturnValue({ connection });
    mocks.isV17Account.mockReturnValue(true);
  });

  it("finds the wrapped position via ONE batched getMultipleAccountsInfo call, not N getAccountInfo calls", async () => {
    const slabPk = new PublicKey(slabAddress);
    const raw = new Uint8Array([1]);
    mocks.useSlabState.mockReturnValue({ raw });

    connection.getProgramAccounts.mockResolvedValue([
      { pubkey: uniquePubkey(), account: { data: new Uint8Array(199) } },
      { pubkey: uniquePubkey(), account: { data: new Uint8Array(199) } },
    ]);

    const nftMintOther = uniquePubkey();
    const pfOther = uniquePubkey(); // different market
    const nftMintWrapped = uniquePubkey();
    const pfWrapped = uniquePubkey(); // this market, active leg
    const nftPda = uniquePubkey();

    mocks.parsePositionNftAccount
      .mockReturnValueOnce({ nftMint: nftMintOther, portfolioAccount: pfOther })
      .mockReturnValueOnce({ nftMint: nftMintWrapped, portfolioAccount: pfWrapped });

    connection.getMultipleAccountsInfo.mockResolvedValue([
      { data: Buffer.alloc(1) },
      { data: Buffer.alloc(1) },
    ]);

    mocks.parsePortfolioV17
      .mockReturnValueOnce(emptyPortfolio(uniquePubkey(), 5n)) // pfOther: wrong market
      .mockReturnValueOnce(emptyPortfolio(slabPk, 12n)); // pfWrapped: this market, active leg

    const { result } = renderHook(() => useNftWrappedPosition(slabAddress, true));

    await waitFor(() => {
      expect(result.current).not.toBeNull();
    });

    expect(connection.getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
    expect(connection.getAccountInfo).not.toHaveBeenCalled();
    expect(result.current?.account.positionSize).toBe(12n);
  });

  it("keeps the last-good wrapped position on a transient error instead of vanishing", async () => {
    const slabPk = new PublicKey(slabAddress);
    let raw = new Uint8Array([1]);
    mocks.useSlabState.mockImplementation(() => ({ raw }));

    const heldNftPk = uniquePubkey();
    connection.getProgramAccounts.mockResolvedValue([{ pubkey: heldNftPk, account: { data: new Uint8Array(199) } }]);

    const nftMint = uniquePubkey();
    const pfPk = uniquePubkey();
    mocks.parsePositionNftAccount.mockReturnValue({ nftMint, portfolioAccount: pfPk });
    connection.getMultipleAccountsInfo.mockResolvedValueOnce([{ data: Buffer.alloc(1) }]);
    mocks.parsePortfolioV17.mockReturnValueOnce(emptyPortfolio(slabPk, 8n));

    const { result, rerender } = renderHook(() => useNftWrappedPosition(slabAddress, true));

    await waitFor(() => {
      expect(result.current?.account.positionSize).toBe(8n);
    });

    // Next slab update: the batched wrapped-portfolio fetch itself throws.
    connection.getMultipleAccountsInfo.mockRejectedValueOnce(new Error("RPC 429"));
    raw = new Uint8Array([2]);
    rerender();

    // Give the effect's microtasks a tick to run and (fail to) settle.
    await new Promise((r) => setTimeout(r, 0));

    expect(result.current).not.toBeNull();
    expect(result.current?.account.positionSize).toBe(8n); // unchanged, not vanished
  });
});
