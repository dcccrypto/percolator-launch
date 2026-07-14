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
      programId: mockProgramId.toBase58(),
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
      // ATA exists — no createATA needed
      mockConnection.getAccountInfo.mockResolvedValue({
        data: Buffer.alloc(165),
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
});
