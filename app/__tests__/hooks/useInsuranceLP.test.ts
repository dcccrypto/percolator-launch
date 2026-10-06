/**
 * useInsuranceLP Hook Tests
 *
 * Critical Test Cases:
 * - H3: Infinite loop fix in auto-refresh mechanism
 * - Insurance fund balance calculations
 * - LP token minting and redemption
 * - User share percentage calculations
 * - Redemption rate with edge cases (zero supply, overflow)
 * - v17 LP Vault flow (CreateLpVault / DepositToLpVault / RequestRedeemLpShares / ExecuteRedemption)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { PublicKey } from "@solana/web3.js";
import { useInsuranceLP } from "../../hooks/useInsuranceLP";

// Mock dependencies
vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: vi.fn(),
  useWalletCompat: vi.fn(),
}));

vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: vi.fn(),
}));

vi.mock("@/lib/tx", () => ({
  sendTx: vi.fn(),
  SimulationRefusal: class SimulationRefusal extends Error {},
}));

// Allow the test program ID through the program allowlist gate.
// The real gate is tested in programAllowlist.test.ts.
vi.mock("@/lib/programAllowlist", () => ({
  isKnownProgram: () => true,
  assertKnownProgram: () => {},
}));

vi.mock("@percolatorct/sdk", async () => {
  const { PublicKey: PK } = await import("@solana/web3.js");
  // NOTE: vi.mock factories are hoisted — we must use dynamic import for external deps.
  const lpMint = new PK("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
  const vaultAuth = new PK("11111111111111111111111111111111"); // all-zeros via string (valid)
  const registryPda = new PK("7pXnR8Eg2g7YDtPkUeEmcYNpPN5yzGLbNHREeHJMzNhq"); // stable 32-byte pubkey
  const redemptionPda = new PK("6UwgpB4FBfQpKW8ACFv7EW5vXg1NiHRQijYzGBaXJSHJ"); // stable 32-byte pubkey
  const ledgerPda = new PK("5YNmS1R9nNSCDzb5a7mMJ1dwK9uH27bN3i2JK1eGfwCM"); // stable 32-byte pubkey
  const escrowPda = new PK("4mB4qULhrn1PcDCTVfE3XPfKvGiCTiXhbmzuUwrQZzJj"); // stable 32-byte pubkey
  const progId = new PK("5BZWY6XWPxuWFxs2nPCLLsVaKRWZVnzZh3FkJDLJBkJf");
  return {
    deriveInsuranceLpMint: vi.fn().mockReturnValue([lpMint, 255]),
    deriveVaultAuthority: vi.fn().mockReturnValue([vaultAuth, 254]),
    deriveLpVaultRegistry: vi.fn().mockReturnValue([registryPda, 253]),
    deriveLpRedemption: vi.fn().mockReturnValue([redemptionPda, 252]),
    deriveLpBackingLedger: vi.fn().mockReturnValue([ledgerPda, 251]),
    // BUG FIX (devnet flow-test 2026-07-01): added when useInsuranceLP.ts's withdraw() was
    // fixed to include the escrow account (see hook's inline fix comment) — the mock didn't
    // know about this new SDK import, so both withdraw() tests failed with
    // "No 'deriveLpEscrow' export is defined on the mock".
    deriveLpEscrow: vi.fn().mockReturnValue([escrowPda, 250]),
    encodeCreateLpVaultV17: vi.fn().mockReturnValue(Buffer.alloc(32)),
    encodeDepositToLpVault: vi.fn().mockReturnValue(Buffer.alloc(16)),
    encodeRequestRedeemLpShares: vi.fn().mockReturnValue(Buffer.alloc(16)),
    encodeExecuteRedemption: vi.fn().mockReturnValue(Buffer.alloc(8)),
    // Without this the hook's registry read throws into its catch and
    // lpVaultDomain silently stays 0, so no test could ever see a wrong domain.
    parseLpVaultRegistry: vi.fn().mockReturnValue({
      totalLpSharesOutstanding: 1_000_000n,
      feeDistributionTotalAtoms: 0n,
      redemptionCooldownSlots: 0n,
      domain: 0,
    }),
    // The payout reads the pending ticket's shares (split-pot planning, 2026-10-01b).
    parseLpRedemption: vi.fn().mockReturnValue({ shares: 1_000n, requestSlot: 0n }),
    encodeRebalanceLpVaultBacking: vi.fn().mockReturnValue(Buffer.alloc(35)),
    ACCOUNTS_REBALANCE_LP_VAULT_BACKING: [],
    buildAccountMetas: vi.fn().mockReturnValue([]),
    buildIx: vi.fn().mockReturnValue({
      programId: progId,
      keys: [],
      data: Buffer.alloc(8),
    }),
    ACCOUNTS_CREATE_LP_VAULT: [],
    ACCOUNTS_LP_VAULT_DEPOSIT: [],
    WELL_KNOWN: {
      systemProgram: new PK("11111111111111111111111111111111"),
      tokenProgram: new PK("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      clock: new PK("SysvarC1ock11111111111111111111111111111111"),
    },
  };
});

vi.mock("@solana/spl-token", () => ({
  TOKEN_PROGRAM_ID: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  getAssociatedTokenAddress: vi.fn(),
  createAssociatedTokenAccountInstruction: vi.fn(),
  unpackMint: vi.fn(),
  unpackAccount: vi.fn(),
}));

// Non-bound pot state: the deposit now FAILS CLOSED when it cannot be read, so the deposit tests
// hand the hook a healthy two-pot vault (domain = registry's; see the fail-closed test below).
vi.mock("@/lib/limits/earn-split-pot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/limits/earn-split-pot")>();
  return { ...actual, readSplitPotState: vi.fn(async () => null) };
});
import { readSplitPotState, EarnDepositsPausedError } from "@/lib/limits/earn-split-pot";
const healthySp = (ownDomain: number) => {
  const pot = { bucket: { freshUnliened: 1_000_000n * 10n ** 18n, validLiened: 0n, consumed: 0n, impaired: 0n, utilFeeEarnings: 0n, status: 1 },
    source: { positiveClaimBound: 0n, freshReserved: 0n, validLienedBacking: 0n, insuranceCreditReserved: 0n, validLienedInsurance: 0n, impairedLienedInsurance: 0n },
    ledger: { totalPrincipal: 1_000_000n, totalEarnings: 0n, totalEarningsWithdrawn: 0n, lastObsBucketEarnings: 0n, cumulativeLoss: 0n, cumulativeRecovery: 0n, lastObsUnavailable: 0n } };
  return { own: pot, sib: pot, ownDomain, totalShares: 1_000_000n, feeShareBps: 1000, ownLedger: new PublicKey("11111111111111111111111111111112"), sibLedger: new PublicKey("11111111111111111111111111111113"), navFloor: false, harvestableAtoms: 0n } as never;
};
import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useParams } from "next/navigation";
import { sendTx } from "@/lib/tx";
import { getAssociatedTokenAddress, unpackMint, unpackAccount } from "@solana/spl-token";

describe("useInsuranceLP", () => {
  const mockSlabAddress = "11111111111111111111111111111111";
  const mockWalletPubkey = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
  const mockProgramId = new PublicKey("5BZWY6XWPxuWFxs2nPCLLsVaKRWZVnzZh3FkJDLJBkJf");
  const mockSlabPubkey = new PublicKey(mockSlabAddress);
  const mockLpMintPubkey = new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
  const mockCollateralMint = new PublicKey("So11111111111111111111111111111111111111112");
  const mockVault = new PublicKey("EfgWMhW4VeL1CyP8nvkmsXduF1Uf9KmRgy6F1c3GEyWr");
  const mockAtaPk = new PublicKey("ATA1111111111111111111111111111111111111111");

  let mockConnection: any;
  let mockWallet: any;
  let mockSlabState: any;

  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure real timers are active by default
    vi.useRealTimers();

    // Mock connection
    mockConnection = {
      getAccountInfo: vi.fn(),
    };

    // Mock wallet
    mockWallet = {
      publicKey: mockWalletPubkey,
      signTransaction: vi.fn(),
      signAllTransactions: vi.fn(),
      connected: true,
    };

    // Mock slab state
    mockSlabState = {
      // A real PublicKey, as SlabProvider actually supplies (its context type
      // is `PublicKey | null`). This was a base58 STRING, which typechecked
      // only because the mock is untyped: every consumer happened to funnel it
      // through `new PublicKey(...)`, which accepts both, so the mismatch
      // stayed invisible until a consumer called a PublicKey method on it.
      programId: mockProgramId,
      engine: {
        insuranceFund: {
          balance: 1000000n, // 1 SOL
        },
      },
      config: {
        collateralMint: mockCollateralMint,
        vaultPubkey: mockVault,
      },
    };

    vi.mocked(useConnectionCompat).mockReturnValue({ connection: mockConnection });
    vi.mocked(useWalletCompat).mockReturnValue(mockWallet);
    vi.mocked(useSlabState).mockReturnValue(mockSlabState);
    vi.mocked(useParams).mockReturnValue({ slab: mockSlabAddress });
    vi.mocked(sendTx).mockResolvedValue("mock-signature");
    vi.mocked(readSplitPotState).mockResolvedValue(null);
    vi.mocked(getAssociatedTokenAddress).mockResolvedValue(mockAtaPk);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("H3: Infinite Loop Fix", () => {
    it("should not cause infinite re-renders with auto-refresh", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      // Mock mint exists
      mockConnection.getAccountInfo.mockResolvedValue({
        data: Buffer.alloc(82), // Standard mint account size
        executable: false,
        lamports: 1000000,
        owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      });

      vi.mocked(unpackMint).mockReturnValue({
        supply: 1000000n,
        decimals: 9,
        isInitialized: true,
        freezeAuthority: null,
        mintAuthority: mockLpMintPubkey,
      });

      const { result } = renderHook(() => useInsuranceLP());

      // Initial render should trigger first refresh
      await waitFor(() => {
        expect(result.current.state.mintExists).toBe(true);
      });

      const callCount = mockConnection.getAccountInfo.mock.calls.length;

      // Fast-forward 10 seconds (auto-refresh interval)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      // Should have called getAccountInfo again for auto-refresh
      await waitFor(() => {
        expect(mockConnection.getAccountInfo.mock.calls.length).toBeGreaterThan(callCount);
      });

      // Should NOT have excessive calls (would indicate infinite loop)
      expect(mockConnection.getAccountInfo.mock.calls.length).toBeLessThan(callCount + 10);
    });

    it("does not re-fetch when SlabProvider re-emits the same programId as a new object", async () => {
      // SlabProvider rebuilds programId as a brand-new PublicKey on every slab
      // poll (`programId: owner ?? s.programId`, owner being fresh off each
      // getAccountInfo). `lpMintInfo`/`registryInfo` are memos keyed on that
      // object that return fresh object literals, and they sit in the dep array
      // of the effect that does `setLoading(true); refreshStateRef.current()`.
      // So every poll re-armed the shimmer on all five Earn stat cells and
      // re-ran a 6-call refresh. The PERC-9204 note two lines above that effect
      // stabilizes `config` and was silently undone by these two siblings.
      const { result, rerender } = renderHook(() => useInsuranceLP());
      await waitFor(() => expect(result.current.loading).toBe(false));
      const callsAfterLoad = mockConnection.getAccountInfo.mock.calls.length;

      for (let poll = 0; poll < 3; poll++) {
        vi.mocked(useSlabState).mockReturnValue({
          ...mockSlabState,
          programId: new PublicKey(mockProgramId.toBase58()), // same value, new object
        });
        rerender();
      }
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(mockConnection.getAccountInfo.mock.calls.length).toBe(callsAfterLoad);
    });

    it("should use stable wallet public key reference to prevent re-render loop", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockConnection.getAccountInfo.mockResolvedValue(null); // Mint doesn't exist

      // Mock wallet with new PublicKey instance on each call (simulating unstable reference)
      let callCount = 0;
      vi.mocked(useWalletCompat).mockImplementation(() => ({
        publicKey: callCount++ < 5
          ? new PublicKey(mockWalletPubkey.toBase58()) // New instance each time
          : mockWalletPubkey, // Stable after 5 calls
        signTransaction: vi.fn(),
        connected: true,
      }));

      const { result } = renderHook(() => useInsuranceLP());

      await waitFor(() => {
        expect(result.current.state.mintExists).toBe(false);
      });

      // Should stabilize and not loop infinitely
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      // Verify no excessive re-renders
      expect(mockConnection.getAccountInfo.mock.calls.length).toBeLessThan(20);
    });

    it("should cleanup interval on unmount", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockConnection.getAccountInfo.mockResolvedValue(null);

      const { result, unmount } = renderHook(() => useInsuranceLP());

      // Wait for hook to settle — when no mint, balance is 0n (uninitialized guard)
      await waitFor(() => {
        expect(result.current.state.mintExists).toBe(false);
      });

      const callsBefore = mockConnection.getAccountInfo.mock.calls.length;

      // Unmount
      unmount();

      // Advance time after unmount
      await vi.advanceTimersByTimeAsync(20000);

      // Should NOT have called getAccountInfo again
      expect(mockConnection.getAccountInfo.mock.calls.length).toBe(callsBefore);
    });
  });

  describe("Insurance Balance Calculations", () => {
    it("should return 0 for insurance balance when LP mint does not exist (no mint = uninitialized)", async () => {
      // When mintExists=false the on-chain balance field may be garbage (u64::MAX).
      // The hook must clamp it to 0 so the UI shows the correct pool size.
      mockConnection.getAccountInfo.mockResolvedValue(null); // No mint

      const { result } = renderHook(() => useInsuranceLP());

      await waitFor(() => {
        expect(result.current.state.insuranceBalance).toBe(0n);
      });
    });

    it("should read insurance balance from engine state when LP mint exists", async () => {
      // Balance is trusted only when the LP mint is live
      mockConnection.getAccountInfo.mockResolvedValue({
        data: Buffer.alloc(82),
        executable: false,
        lamports: 1_000_000,
        owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      });
      vi.mocked(unpackMint).mockReturnValue({ supply: 0n, decimals: 6, isInitialized: true });

      const { result } = renderHook(() => useInsuranceLP());

      await waitFor(() => {
        expect(result.current.state.insuranceBalance).toBe(1_000_000n);
      });
    });

    it("should clamp u64::MAX uninitialized balance to 0 (GH#1278)", async () => {
      // Simulates the TEST/USD bug: on-chain field is uninitialised → u64::MAX
      const U64_MAX = 18_446_744_073_709_551_615n;
      mockSlabState.engine.insuranceFund.balance = U64_MAX - 65n; // ~u64::MAX as observed
      mockConnection.getAccountInfo.mockResolvedValue(null); // No LP mint

      const { result } = renderHook(() => useInsuranceLP());

      await waitFor(() => {
        expect(result.current.state.insuranceBalance).toBe(0n);
        expect(result.current.state.mintExists).toBe(false);
      });
    });

    it("should handle zero insurance balance", async () => {
      mockSlabState.engine.insuranceFund.balance = 0n;
      mockConnection.getAccountInfo.mockResolvedValue(null);

      const { result } = renderHook(() => useInsuranceLP());

      await waitFor(() => {
        expect(result.current.state.insuranceBalance).toBe(0n);
        expect(result.current.state.redemptionRateE6).toBe(1_000_000n); // 1:1 when no supply
      });
    });

    it("should handle large insurance balances without overflow when mint exists", async () => {
      const largeBalance = 1_000_000_000_000n; // 1 million SOL equivalent
      mockSlabState.engine.insuranceFund.balance = largeBalance;
      mockConnection.getAccountInfo.mockResolvedValue({
        data: Buffer.alloc(82),
        executable: false,
        lamports: 1_000_000,
        owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      });
      vi.mocked(unpackMint).mockReturnValue({ supply: 0n, decimals: 6, isInitialized: true });

      const { result } = renderHook(() => useInsuranceLP());

      await waitFor(() => {
        expect(result.current.state.insuranceBalance).toBe(largeBalance);
      });
    });
  });

  describe("LP Token Supply & Redemption Rate", () => {
    it("should calculate redemption rate with existing supply", async () => {
      const insuranceBalance = 2000000n; // 2 SOL
      const lpSupply = 1000000n; // 1 million LP tokens

      mockSlabState.engine.insuranceFund.balance = insuranceBalance;
      mockConnection.getAccountInfo.mockResolvedValue({
        data: Buffer.alloc(82),
        executable: false,
        lamports: 1000000,
        owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      });

      vi.mocked(unpackMint).mockReturnValue({
        supply: lpSupply,
        decimals: 9,
        isInitialized: true,
      });

      const { result } = renderHook(() => useInsuranceLP());

      await waitFor(() => {
        expect(result.current.state.lpSupply).toBe(lpSupply);
        // redemptionRateE6 = (2000000 * 1000000) / 1000000 = 2000000 (2:1)
        expect(result.current.state.redemptionRateE6).toBe(2_000_000n);
      });
    });

    it("should default to 1:1 redemption when supply is zero", async () => {
      mockSlabState.engine.insuranceFund.balance = 5000000n;
      mockConnection.getAccountInfo.mockResolvedValue({
        data: Buffer.alloc(82),
        executable: false,
        lamports: 1000000,
        owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      });

      vi.mocked(unpackMint).mockReturnValue({
        supply: 0n, // No LP tokens minted yet
        decimals: 9,
        isInitialized: true,
      });

      const { result } = renderHook(() => useInsuranceLP());

      await waitFor(() => {
        expect(result.current.state.redemptionRateE6).toBe(1_000_000n); // 1:1
      });
    });

    it("should handle mint not existing", async () => {
      mockConnection.getAccountInfo.mockResolvedValue(null); // Mint doesn't exist

      const { result } = renderHook(() => useInsuranceLP());

      await waitFor(() => {
        expect(result.current.state.mintExists).toBe(false);
        expect(result.current.state.lpSupply).toBe(0n);
        expect(result.current.state.lpMintAddress).toBeNull();
      });
    });
  });

  describe("User Share Calculations", () => {
    it("should calculate user share percentage correctly", async () => {
      const lpSupply = 10000000n; // 10 million LP tokens
      const userLpBalance = 2500000n; // 2.5 million LP tokens (25%)

      mockConnection.getAccountInfo
        .mockResolvedValueOnce({
          // Mint account
          data: Buffer.alloc(82),
          executable: false,
          lamports: 1000000,
          owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        })
        .mockResolvedValueOnce({
          // User ATA
          data: Buffer.alloc(165), // Token account size
          executable: false,
          lamports: 2000000,
          owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        });

      vi.mocked(unpackMint).mockReturnValue({
        supply: lpSupply,
        decimals: 9,
        isInitialized: true,
      });

      vi.mocked(unpackAccount).mockReturnValue({
        amount: userLpBalance,
        mint: mockLpMintPubkey,
        owner: mockWalletPubkey,
      });

      const { result } = renderHook(() => useInsuranceLP());

      await waitFor(() => {
        expect(result.current.state.userLpBalance).toBe(userLpBalance);
        expect(result.current.state.userSharePct).toBe(25); // 25%
      });
    });

    it("should calculate user redeemable value", async () => {
      const insuranceBalance = 10000000n; // 10 SOL
      const lpSupply = 1000000n; // 1 million LP tokens
      const userLpBalance = 250000n; // 250k LP tokens (25%)

      mockSlabState.engine.insuranceFund.balance = insuranceBalance;
      mockConnection.getAccountInfo
        .mockResolvedValueOnce({
          data: Buffer.alloc(82),
          executable: false,
          lamports: 1000000,
          owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        })
        .mockResolvedValueOnce({
          data: Buffer.alloc(165),
          executable: false,
          lamports: 2000000,
          owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        });

      vi.mocked(unpackMint).mockReturnValue({
        supply: lpSupply,
        decimals: 9,
        isInitialized: true,
      });

      vi.mocked(unpackAccount).mockReturnValue({
        amount: userLpBalance,
        mint: mockLpMintPubkey,
        owner: mockWalletPubkey,
      });

      const { result } = renderHook(() => useInsuranceLP());

      await waitFor(() => {
        // userRedeemableValue = (250000 * 10000000) / 1000000 = 2500000 (2.5 SOL)
        expect(result.current.state.userRedeemableValue).toBe(2500000n);
      });
    });

    it("should handle user with no LP tokens", async () => {
      mockConnection.getAccountInfo
        .mockResolvedValueOnce({
          data: Buffer.alloc(82),
          executable: false,
          lamports: 1000000,
          owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        })
        .mockResolvedValueOnce(null); // User ATA doesn't exist

      vi.mocked(unpackMint).mockReturnValue({
        supply: 1000000n,
        decimals: 9,
        isInitialized: true,
      });

      const { result } = renderHook(() => useInsuranceLP());

      await waitFor(() => {
        expect(result.current.state.userLpBalance).toBe(0n);
        expect(result.current.state.userSharePct).toBe(0);
        expect(result.current.state.userRedeemableValue).toBe(0n);
      });
    });
  });

  describe("Create Mint (v17 LP Vault — CreateLpVault tag 74)", () => {
    // v17: createMint() is now CreateLpVault (tag 74) — a real on-chain tx.
    // The old "stub throws percolator-stake" behavior is gone.
    it("should call sendTx when wallet and market are loaded", async () => {
      mockConnection.getAccountInfo.mockResolvedValue(null);

      const { result } = renderHook(() => useInsuranceLP());

      await waitFor(() => {
        expect(result.current.state.mintExists).toBe(false);
      });

      await act(async () => {
        await result.current.createMint();
      });

      // v17 CreateLpVault should have dispatched a transaction
      expect(sendTx).toHaveBeenCalledTimes(1);
    });

    it("should throw if wallet not connected", async () => {
      mockConnection.getAccountInfo.mockResolvedValue(null);
      vi.mocked(useWalletCompat).mockReturnValue({
        publicKey: null,
        connected: false,
        signTransaction: undefined,
      });

      const { result } = renderHook(() => useInsuranceLP());

      await act(async () => {
        await expect(result.current.createMint()).rejects.toThrow("Wallet not connected");
      });
    });
  });

  describe("Deposit (v17 LP Vault — DepositToLpVault tag 75)", () => {
    // v17: deposit() is now DepositToLpVault (tag 75) — a real on-chain tx.
    it("should call sendTx with deposit amount", async () => {
      vi.mocked(readSplitPotState).mockResolvedValue(healthySp(0));
      // ATA exists — no createATA needed. Wallet holds 10M base units
      // (the deposit guard refuses amounts above the wallet balance).
      mockConnection.getAccountInfo.mockResolvedValue({
        data: (() => { const b = Buffer.alloc(165); b.writeBigUInt64LE(10_000_000n, 64); return b; })(),
        lamports: 2_000_000,
        executable: false,
        owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      });

      const { result } = renderHook(() => useInsuranceLP());

      await act(async () => {
        await result.current.deposit(500_000n);
      });

      expect(sendTx).toHaveBeenCalledTimes(1);
    });

    it("FAILS CLOSED: a non-bound vault whose pot state cannot be read is not deposited into", async () => {
      vi.mocked(readSplitPotState).mockResolvedValue(null); // RPC error / 429 -> null
      mockConnection.getAccountInfo.mockResolvedValue({
        data: (() => { const b = Buffer.alloc(165); b.writeBigUInt64LE(10_000_000n, 64); return b; })(),
        lamports: 2_000_000,
        executable: false,
        owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      });
      const { result } = renderHook(() => useInsuranceLP());
      await act(async () => {
        await expect(result.current.deposit(500_000n)).rejects.toBeInstanceOf(EarnDepositsPausedError);
      });
      expect(sendTx).not.toHaveBeenCalled();
    });

    it("refuses to build a deposit above the wallet's collateral balance", async () => {
      mockConnection.getAccountInfo.mockResolvedValue({
        data: (() => { const b = Buffer.alloc(165); b.writeBigUInt64LE(400_000n, 64); return b; })(),
        lamports: 2_000_000,
        executable: false,
        owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      });

      const { result } = renderHook(() => useInsuranceLP());

      await act(async () => {
        await expect(result.current.deposit(500_000n)).rejects.toThrow(/exceeds your wallet balance/i);
      });
      expect(sendTx).not.toHaveBeenCalled();
    });

    // v17 DUAL-DOMAIN. The vault is bound to a pot at CreateLpVault and it is NOT
    // always 0 — a market that appends an asset binds its vault to that asset's
    // domain. The hook must take the domain off the registry and derive BOTH
    // ledgers from it; NAV is summed across the two pots, so a wrong or missing
    // sibling misprices every deposit.
    it("routes the deposit to the registry's own domain, not a hardcoded 0", async () => {
      vi.mocked(readSplitPotState).mockResolvedValue(healthySp(3));
      const sdk = await import("@percolatorct/sdk");
      vi.mocked(sdk.parseLpVaultRegistry).mockReturnValue({
        totalLpSharesOutstanding: 1_000_000n,
        feeDistributionTotalAtoms: 0n,
        redemptionCooldownSlots: 0n,
        domain: 3,
      } as never);
      mockConnection.getAccountInfo.mockResolvedValue({
        data: (() => { const b = Buffer.alloc(176); b.writeBigUInt64LE(10_000_000n, 64); return b; })(),
        lamports: 2_000_000,
        executable: false,
        owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      });

      const { result } = renderHook(() => useInsuranceLP());
      await waitFor(() => expect(result.current.state.lpVaultDomain).toBe(3));

      vi.mocked(sdk.deriveLpBackingLedger).mockClear();
      await act(async () => {
        await result.current.deposit(500_000n);
      });

      expect(sdk.encodeDepositToLpVault).toHaveBeenCalledWith(
        expect.objectContaining({ domain: 3 }),
      );
      const domainsDerived = vi
        .mocked(sdk.deriveLpBackingLedger)
        .mock.calls.map((c) => c[2]);
      expect(domainsDerived).toContain(3);
      expect(domainsDerived).toContain(2); // sibling = 3 ^ 1
    });

    it("should throw if wallet not connected", async () => {
      vi.mocked(useWalletCompat).mockReturnValue({
        publicKey: null,
        connected: false,
        signTransaction: undefined,
      });

      const { result } = renderHook(() => useInsuranceLP());

      await act(async () => {
        await expect(result.current.deposit(500_000n)).rejects.toThrow("Wallet not connected");
      });
    });
  });

  describe("Withdraw (v17 LP Vault — RequestRedeemLpShares tag 76 / ExecuteRedemption tag 77)", () => {
    // v17: withdraw() is now a 2-step flow. Step 1 = RequestRedeemLpShares if no pending
    // redemption, Step 2 = ExecuteRedemption after cooldown.
    it("should call RequestRedeemLpShares when no redemption exists (getAccountInfo returns null)", async () => {
      // All getAccountInfo calls return null (no LP mint, no redemption PDA)
      mockConnection.getAccountInfo.mockResolvedValue(null);

      const { result } = renderHook(() => useInsuranceLP());

      await act(async () => {
        await result.current.withdraw(250_000n);
      });

      // Step 1: RequestRedeemLpShares should be dispatched
      expect(sendTx).toHaveBeenCalledTimes(1);
    });

    it("should call ExecuteRedemption when redemption account already exists", async () => {
      // Redemption PDA exists → skip to step 2 (ExecuteRedemption)
      mockConnection.getAccountInfo.mockResolvedValue({
        data: Buffer.alloc(64),
        lamports: 1_000_000,
        executable: false,
        owner: new PublicKey("5BZWY6XWPxuWFxs2nPCLLsVaKRWZVnzZh3FkJDLJBkJf"),
      });

      const { result } = renderHook(() => useInsuranceLP());

      await act(async () => {
        await result.current.withdraw(250_000n);
      });

      // Step 2: ExecuteRedemption should be dispatched
      expect(sendTx).toHaveBeenCalledTimes(1);
    });

    // Live 2026-09-29 (ANSEM): every claim failed NotEnoughAccountKeys. The deployed
    // wrapper (percolator-prog #461 / GH#412, v18.2) reads a 13th account — the
    // redeemer's rent destination, pinned to redemption.redeemer — and the hook
    // passed 12.
    it("ExecuteRedemption passes all 13 accounts, [12] = the redeemer as writable, signing rent destination", async () => {
      const sdk = await import("@percolatorct/sdk");
      mockConnection.getAccountInfo.mockResolvedValue({
        data: Buffer.alloc(64),
        lamports: 1_000_000,
        executable: false,
        owner: new PublicKey("5BZWY6XWPxuWFxs2nPCLLsVaKRWZVnzZh3FkJDLJBkJf"),
      });
      const { result } = renderHook(() => useInsuranceLP());
      vi.mocked(sdk.buildIx).mockClear();
      await act(async () => {
        await result.current.withdraw(250_000n);
      });
      expect(sdk.encodeExecuteRedemption).toHaveBeenCalled();
      const call = vi.mocked(sdk.buildIx).mock.calls.find(
        (c) => (c[0] as { keys: unknown[] }).keys.length >= 12,
      );
      expect(call).toBeDefined();
      const keys = (call![0] as { keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] }).keys;
      expect(keys).toHaveLength(13);
      expect(keys[12].pubkey.equals(mockWalletPubkey)).toBe(true);
      expect(keys[12].isWritable).toBe(true);
      // Devnet v2.1 (P2b H-1b): a Live non-bound 77 needs [12] to SIGN. It is the same key as the fee
      // payer at [0], so it is one signature on the message; the flag is stated on the meta itself.
      expect(keys[12].isSigner).toBe(true);
      // [0] is still the signing cranker (the redeemer themselves).
      expect(keys[0].pubkey.equals(mockWalletPubkey)).toBe(true);
      expect(keys[0].isSigner).toBe(true);
    });

    // UX WP-4 (user decision 2026-09-30): the cooldown stays (~150 slots), so a request is its own
    // signature and the page opens the payout when it ends; only a cooldown-0 vault does [76, 77]
    // in one tx. The registry's own cooldown decides.
    const registryOnly = (cooldown: bigint) => {
      const REGISTRY = "7pXnR8Eg2g7YDtPkUeEmcYNpPN5yzGLbNHREeHJMzNhq";
      mockConnection.getAccountInfo.mockImplementation(async (pk: PublicKey) =>
        pk.toBase58() === REGISTRY ? { data: Buffer.alloc(64), lamports: 1, executable: false, owner: mockProgramId } : null,
      );
      return cooldown;
    };
    it.each([
      [150n, "requested", 1],
      [0n, "executed", 2],
    ] as const)("registry cooldown %s slots -> %s, %s instruction(s) in ONE signature", async (cooldown, step, minIxs) => {
      const sdk = await import("@percolatorct/sdk");
      vi.mocked(sdk.parseLpVaultRegistry).mockReturnValue({
        totalLpSharesOutstanding: 1_000_000n,
        feeDistributionTotalAtoms: 0n,
        redemptionCooldownSlots: registryOnly(cooldown),
        domain: 0,
      } as never);
      const { result } = renderHook(() => useInsuranceLP());
      await waitFor(() => expect(result.current.state.registryExists).toBe(true));
      expect(result.current.state.redemptionCooldownSlots).toBe(cooldown);
      vi.mocked(sendTx).mockClear();
      let r: { step: string } | undefined;
      await act(async () => {
        r = await result.current.withdraw(250_000n);
      });
      expect(r!.step).toBe(step);
      expect(sendTx).toHaveBeenCalledTimes(1);
      const ixs = (vi.mocked(sendTx).mock.calls[0][0] as { instructions: unknown[] }).instructions;
      if (step === "requested") expect(ixs).toHaveLength(1);
      else expect(ixs.length).toBeGreaterThanOrEqual(minIxs);
    });

    it("should throw if wallet not connected", async () => {
      vi.mocked(useWalletCompat).mockReturnValue({
        publicKey: null,
        connected: false,
        signTransaction: undefined,
      });

      const { result } = renderHook(() => useInsuranceLP());

      await act(async () => {
        await expect(result.current.withdraw(250_000n)).rejects.toThrow("Wallet not connected");
      });
    });
  });

  describe("Error Handling", () => {
    it("should handle RPC errors gracefully", async () => {
      // Mock getAccountInfo to reject (RPC timeout)
      mockConnection.getAccountInfo.mockRejectedValue(new Error("RPC timeout"));

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const { result } = renderHook(() => useInsuranceLP());

      // The hook should not crash on RPC errors — it catches them in refreshState
      // insuranceBalance comes from slabState.engine.insuranceFund.balance
      // which is set via the mock. After the failed RPC call, the hook should
      // still have values from slabState.
      await waitFor(() => {
        // Mint-related state should default to not-found since RPC failed
        expect(result.current.state.mintExists).toBe(false);
      });

      // Importantly: the hook should NOT crash or leave loading stuck.
      // waitFor (not a sync assert): `setLoading(false)` lives in refreshState's
      // stale-guarded `finally`, which can land in a separate React commit from
      // the `mintExists` update awaited above — the contract is "loading
      // eventually clears", not "in the same commit as mintExists".
      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      consoleSpy.mockRestore();
    });

    it("should handle invalid slab address", async () => {
      // Invalid base58 address — deriveInsuranceLpMint will throw in useMemo
      vi.mocked(useParams).mockReturnValue({ slab: "not-valid-base58!!!" });
      mockConnection.getAccountInfo.mockResolvedValue(null);

      const { result } = renderHook(() => useInsuranceLP());

      // Should handle gracefully — lpMintInfo will be null from useMemo try/catch
      await waitFor(() => {
        expect(result.current.state.lpMintAddress).toBeNull();
        expect(result.current.state.mintExists).toBe(false);
      });
    });
  });

  describe("Loading State", () => {
    it("loading should be false when not executing a tx", async () => {
      mockConnection.getAccountInfo.mockResolvedValue(null);

      const { result } = renderHook(() => useInsuranceLP());

      await waitFor(() => {
        expect(result.current.state.mintExists).toBe(false);
      });

      // Loading is false when hook is idle (no active tx)
      expect(result.current.loading).toBe(false);
    });

    it("loading transitions to true during createMint then back to false", async () => {
      mockConnection.getAccountInfo.mockResolvedValue(null);

      let resolveSendTx: any;
      vi.mocked(sendTx).mockReturnValue(
        new Promise((resolve) => {
          resolveSendTx = resolve;
        }),
      );

      const { result } = renderHook(() => useInsuranceLP());

      // Start createMint (async, don't await yet)
      let createMintPromise: Promise<void> | undefined;
      act(() => {
        createMintPromise = result.current.createMint();
      });

      // loading should flip to true
      await waitFor(() => {
        expect(result.current.loading).toBe(true);
      });

      // Resolve sendTx
      await act(async () => {
        resolveSendTx("mock-sig");
        await createMintPromise;
      });

      // loading should return to false
      expect(result.current.loading).toBe(false);
    });
  });

  // A failed read is unknown, not "this market has no Earn vault" / $0.
  describe("vault read failures", () => {
    const MINT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
    const REGISTRY = "7pXnR8Eg2g7YDtPkUeEmcYNpPN5yzGLbNHREeHJMzNhq";
    const acct = { data: Buffer.alloc(64), lamports: 1, executable: false, owner: mockProgramId };
    const REDEMPTION = "6UwgpB4FBfQpKW8ACFv7EW5vXg1NiHRQijYzGBaXJSHJ";
    let failMint = false;
    let failRegistry = false;
    let failRedemption = false;

    beforeEach(async () => {
      failMint = false;
      failRegistry = false;
      failRedemption = false;
      mockConnection.getAccountInfo.mockImplementation(async (pk: PublicKey) => {
        const k = pk.toBase58();
        if (k === MINT) {
          if (failMint) throw new Error("429 Too Many Requests");
          return acct;
        }
        if (k === REGISTRY) {
          if (failRegistry) throw new Error("429 Too Many Requests");
          return acct;
        }
        if (k === REDEMPTION && failRedemption) throw new Error("429 Too Many Requests");
        return null;
      });
      vi.mocked(unpackMint).mockReturnValue({ supply: 1_000_000n, decimals: 6, isInitialized: true } as never);
      const sdk = await import("@percolatorct/sdk");
      vi.mocked(sdk.parseLpVaultRegistry).mockReturnValue({
        totalLpSharesOutstanding: 1_000_000n,
        feeDistributionTotalAtoms: 0n,
        redemptionCooldownSlots: 0n,
        domain: 0,
      } as never);
    });

    it("a failed registry read keeps the last good vault and flags readError", async () => {
      const { result } = renderHook(() => useInsuranceLP());
      await waitFor(() => expect(result.current.state.registryExists).toBe(true));
      expect(result.current.readError).toBe(false);
      failRegistry = true;
      await act(async () => {
        await result.current.refreshState();
      });
      expect(result.current.readError).toBe(true);
      expect(result.current.state.registryExists).toBe(true);
      expect(result.current.state.vaultTotalAtoms).toBe(1_000_000n);
    });

    it("a failed first registry read flags readError (state is not a confirmed no-vault)", async () => {
      failRegistry = true;
      const { result } = renderHook(() => useInsuranceLP());
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.readError).toBe(true);
      expect(result.current.state.registryExists).toBe(false);
    });

    // Parse mocks set per test here would otherwise outlive this describe.
    afterEach(async () => {
      const sdk = await import("@percolatorct/sdk");
      vi.mocked(sdk.parseLpVaultRegistry).mockReturnValue({
        totalLpSharesOutstanding: 1_000_000n,
        feeDistributionTotalAtoms: 0n,
        redemptionCooldownSlots: 0n,
        domain: 0,
      } as never);
      vi.mocked(unpackMint).mockReset();
    });

    it("a failed redemption-ticket read keeps the last good state and flags readError", async () => {
      const { result } = renderHook(() => useInsuranceLP());
      await waitFor(() => expect(result.current.state.registryExists).toBe(true));
      failRedemption = true;
      await act(async () => {
        await result.current.refreshState();
      });
      expect(result.current.readError).toBe(true);
      expect(result.current.state.registryExists).toBe(true);
    });

    it("a failed mint read flags readError", async () => {
      failMint = true;
      const { result } = renderHook(() => useInsuranceLP());
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.readError).toBe(true);
    });

    it("the next good read clears readError", async () => {
      failRegistry = true;
      const { result } = renderHook(() => useInsuranceLP());
      await waitFor(() => expect(result.current.readError).toBe(true));
      failRegistry = false;
      await act(async () => {
        await result.current.refreshState();
      });
      expect(result.current.readError).toBe(false);
      expect(result.current.state.registryExists).toBe(true);
    });

    it("a registry that fails to parse is still published as absent, with no readError", async () => {
      const sdk = await import("@percolatorct/sdk");
      vi.mocked(sdk.parseLpVaultRegistry).mockImplementation(() => {
        throw new Error("bad layout");
      });
      const { result } = renderHook(() => useInsuranceLP());
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.readError).toBe(false);
      expect(result.current.state.registryExists).toBe(false);
      expect(result.current.state.mintExists).toBe(true);
    });

    it("stays loading while the slab is still loading, then loads", async () => {
      const loadingSlab = { ...mockSlabState, programId: null, loading: true };
      vi.mocked(useSlabState).mockReturnValue(loadingSlab);
      const { result, rerender } = renderHook(() => useInsuranceLP());
      await act(async () => {
        await result.current.refreshState();
      });
      expect(result.current.loading).toBe(true);
      vi.mocked(useSlabState).mockReturnValue({ ...mockSlabState, loading: false });
      rerender();
      await waitFor(() => expect(result.current.state.registryExists).toBe(true));
      expect(result.current.loading).toBe(false);
    });

    it("a slab that finishes loading with no programId stops loading", async () => {
      vi.mocked(useSlabState).mockReturnValue({ ...mockSlabState, programId: null, loading: true });
      const { result, rerender } = renderHook(() => useInsuranceLP());
      await act(async () => {
        await result.current.refreshState();
      });
      expect(result.current.loading).toBe(true);
      vi.mocked(useSlabState).mockReturnValue({ ...mockSlabState, programId: null, loading: false, error: "Market not found on-chain." });
      rerender();
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.readError).toBe(false);
    });

    it("a slab read that failed on the network flags readError", async () => {
      vi.mocked(useSlabState).mockReturnValue({ ...mockSlabState, programId: null, loading: true });
      const { result, rerender } = renderHook(() => useInsuranceLP());
      vi.mocked(useSlabState).mockReturnValue({
        ...mockSlabState,
        programId: null,
        config: null,
        loading: false,
        error: "RPC error: 429 Too Many Requests",
      });
      rerender();
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.readError).toBe(true);
    });
  });

  // A pending withdrawal escrows the shares until it pays out; they are still the user's.
  describe("position with a pending withdrawal", () => {
    it("share % and value count the escrowed shares, not only the wallet's", async () => {
      const MINT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
      const REGISTRY = "7pXnR8Eg2g7YDtPkUeEmcYNpPN5yzGLbNHREeHJMzNhq";
      const REDEMPTION = "6UwgpB4FBfQpKW8ACFv7EW5vXg1NiHRQijYzGBaXJSHJ";
      const acct = { data: Buffer.alloc(64), lamports: 1, executable: false, owner: mockProgramId };
      // Mint, registry and the redemption ticket exist; the wallet's LP account doesn't (all
      // of the user's shares are in the pending withdrawal).
      mockConnection.getAccountInfo.mockImplementation(async (pk: PublicKey) =>
        [MINT, REGISTRY, REDEMPTION].includes(pk.toBase58()) ? acct : null,
      );
      vi.mocked(unpackMint).mockReturnValue({ supply: 1_000_000n, decimals: 6, isInitialized: true } as never);
      const sdk = await import("@percolatorct/sdk");
      vi.mocked(sdk.parseLpVaultRegistry).mockReturnValue({
        totalLpSharesOutstanding: 1_000_000n,
        feeDistributionTotalAtoms: 0n,
        redemptionCooldownSlots: 0n,
        domain: 0,
      } as never);
      vi.mocked(sdk.parseLpRedemption).mockReturnValue({ shares: 250_000n, requestSlot: 0n } as never);

      const { result } = renderHook(() => useInsuranceLP());
      await waitFor(() => expect(result.current.state.hasPendingRedemption).toBe(true));
      expect(result.current.state.userLpBalance).toBe(0n);
      expect(result.current.state.pendingRedemptionShares).toBe(250_000n);
      expect(result.current.state.userSharePct).toBe(25);
      expect(result.current.state.userVaultValueAtoms).toBe(250_000n);
    });
  });
});
