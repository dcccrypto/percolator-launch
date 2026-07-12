/**
 * usePositionNft — v17 shared-scan + batching + keep-last-good.
 *
 * Frontend perf audit (2026-07-12): the v17 path used to run its OWN
 * getProgramAccounts scan for "do I own an unwrapped portfolio here"
 * (byte-for-byte identical to useUserAccount's scan) AND a serial
 * getAccountInfo per held NFT when falling back to the "received via
 * transfer" path. It now joins the shared stores in lib/userAccountScan.ts
 * and batches the held-NFT portfolio lookups into one
 * getMultipleAccountsInfo call. These tests exercise the hook's public
 * behavior (not the store internals, covered separately in
 * __tests__/lib/userAccountScan.test.ts):
 *
 *   1. The held-NFT fallback batches N wrapped-portfolio lookups into a
 *      single getMultipleAccountsInfo call instead of N getAccountInfo calls.
 *   2. A transient error in the surrounding logic (not just the shared
 *      scans, which already keep-last-good internally) keeps the
 *      previously-determined mint state instead of resetting to "Not
 *      minted" — a UI state that would otherwise invite a doomed re-mint.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { Keypair, PublicKey } from "@solana/web3.js";

const mocks = vi.hoisted(() => ({
  useConnectionCompat: vi.fn(),
  useWalletCompat: vi.fn(),
  useSlabState: vi.fn(),
  useUserAccount: vi.fn(),
  isV17Account: vi.fn(),
  parsePortfolioV17: vi.fn(),
  parsePositionNftAccount: vi.fn(),
  // Real `deriveNftPda` calls `findProgramAddressSync`, which is flaky under
  // this sandbox's jsdom + pure-JS-bigint-fallback test environment (fails
  // with "Unable to find a viable program address nonce" even for valid
  // random inputs — an environment quirk unrelated to this hook's logic).
  // Mocked out like the other SDK parsing functions below.
  deriveNftPda: vi.fn(),
}));

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: mocks.useConnectionCompat,
  useWalletCompat: mocks.useWalletCompat,
}));

vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: mocks.useSlabState,
}));

vi.mock("@/hooks/useUserAccount", () => ({
  useUserAccount: mocks.useUserAccount,
}));

vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false }));

vi.mock("@percolatorct/sdk", async () => {
  const actual = await vi.importActual<typeof import("@percolatorct/sdk")>("@percolatorct/sdk");
  return {
    ...actual,
    isV17Account: mocks.isV17Account,
    parsePortfolioV17: mocks.parsePortfolioV17,
    parsePositionNftAccount: mocks.parsePositionNftAccount,
    deriveNftPda: mocks.deriveNftPda,
  };
});

import { usePositionNft } from "@/hooks/usePositionNft";

// Real, random Keypair-derived pubkeys (not structured fill()-style bytes) —
// PDA derivation (deriveNftPdaV17, exercised for real in this file) needs an
// off-curve derived address, which is effectively guaranteed for genuinely
// random inputs but was flaky with a structured `fill(n)` byte pattern.
function uniquePubkey(): PublicKey {
  return Keypair.generate().publicKey;
}

function emptyPortfolio(marketGroupId: PublicKey) {
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
    activeBitmap: 0n,
    legs: [],
    sourceDomains: [],
  };
}

describe("usePositionNft — v17 shared scan + batching", () => {
  let wallet: PublicKey;
  let programId: PublicKey;
  let slabAddress: string;
  let connection: {
    getProgramAccounts: ReturnType<typeof vi.fn>;
    getAccountInfo: ReturnType<typeof vi.fn>;
    getMultipleAccountsInfo: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    wallet = uniquePubkey();
    programId = uniquePubkey();
    slabAddress = uniquePubkey().toBase58();

    connection = {
      getProgramAccounts: vi.fn(),
      getAccountInfo: vi.fn().mockResolvedValue(null),
      getMultipleAccountsInfo: vi.fn().mockResolvedValue([]),
    };

    mocks.useWalletCompat.mockReturnValue({ publicKey: wallet, connected: true });
    mocks.useConnectionCompat.mockReturnValue({ connection });
    mocks.useUserAccount.mockReturnValue(null);
    mocks.isV17Account.mockReturnValue(true);
    mocks.deriveNftPda.mockReturnValue([uniquePubkey(), 255]);
  });

  it("batches held-NFT wrapped-portfolio lookups into one getMultipleAccountsInfo call", async () => {
    const slabPk = new PublicKey(slabAddress);
    const raw = new Uint8Array([1]);
    mocks.useSlabState.mockReturnValue({ programId, raw });

    // No own unwrapped portfolio here (leg-less / not found) — falls through
    // to the held-NFT scan.
    connection.getProgramAccounts.mockImplementation(async (pid: PublicKey) => {
      if (pid.equals(programId)) return []; // own-portfolio scan: nothing
      // NFT-program held scan: two NFTs held by this wallet.
      return [
        { pubkey: uniquePubkey(), account: { data: new Uint8Array(199) } },
        { pubkey: uniquePubkey(), account: { data: new Uint8Array(199) } },
      ];
    });

    const nftA = uniquePubkey();
    const nftB = uniquePubkey();
    const pfA = uniquePubkey(); // wrapped portfolio on a DIFFERENT market
    const pfB = uniquePubkey(); // wrapped portfolio on THIS market, active leg

    mocks.parsePositionNftAccount
      .mockReturnValueOnce({ nftMint: nftA, portfolioAccount: pfA })
      .mockReturnValueOnce({ nftMint: nftB, portfolioAccount: pfB });

    connection.getMultipleAccountsInfo.mockResolvedValue([
      { data: Buffer.alloc(1) }, // pfA
      { data: Buffer.alloc(1) }, // pfB
    ]);

    mocks.parsePortfolioV17
      .mockReturnValueOnce({ ...emptyPortfolio(uniquePubkey()) }) // pfA: different market
      .mockReturnValueOnce({
        ...emptyPortfolio(slabPk),
        legs: [{ active: true, assetIndex: 0, marketId: 1n, side: 0, basisPosQ: 3n }],
      }); // pfB: this market, active leg

    const { result } = renderHook(() => usePositionNft(slabAddress));

    await waitFor(() => {
      expect(result.current.hasMintedNft).toBe(true);
    });

    expect(connection.getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
    expect(connection.getMultipleAccountsInfo).toHaveBeenCalledWith([pfA, pfB]);
    // No per-NFT serial getAccountInfo for wrapped portfolios.
    expect(connection.getAccountInfo).not.toHaveBeenCalled();
    expect(result.current.nftMint?.equals(nftB)).toBe(true);
  });

  it("keeps the last-good mint state on a transient error instead of resetting to Not Minted", async () => {
    let raw = new Uint8Array([1]);
    mocks.useSlabState.mockImplementation(() => ({ programId, raw }));

    const ownPortfolioPk = uniquePubkey();
    connection.getProgramAccounts.mockImplementation(async (pid: PublicKey) => {
      if (pid.equals(programId)) {
        return [{ pubkey: ownPortfolioPk, account: { data: Buffer.alloc(1) } }];
      }
      return [];
    });
    mocks.parsePortfolioV17.mockReturnValue({
      ...emptyPortfolio(new PublicKey(slabAddress)),
      owner: wallet,
      legs: [{ active: true, assetIndex: 0, marketId: 1n, side: 0, basisPosQ: 10n }],
    });

    const nftMint = uniquePubkey();
    connection.getAccountInfo.mockResolvedValueOnce({ data: new Uint8Array(199) });
    mocks.parsePositionNftAccount.mockReturnValueOnce({ nftMint, portfolioAccount: ownPortfolioPk });

    const { result, rerender } = renderHook(() => usePositionNft(slabAddress));

    await waitFor(() => {
      expect(result.current.hasMintedNft).toBe(true);
    });
    expect(result.current.nftMint?.equals(nftMint)).toBe(true);

    // Next slab update: the own-NFT-PDA getAccountInfo call itself throws
    // (a surrounding-logic error, not a shared-store scan error — those
    // already keep-last-good internally and are covered in
    // __tests__/lib/userAccountScan.test.ts).
    connection.getAccountInfo.mockRejectedValueOnce(new Error("RPC timeout"));
    raw = new Uint8Array([2]);
    rerender();

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Still reports the previously-determined minted state — did NOT reset
    // to "Not minted" (which would re-enable a doomed re-mint attempt).
    expect(result.current.hasMintedNft).toBe(true);
    expect(result.current.nftMint?.equals(nftMint)).toBe(true);
  });
});
