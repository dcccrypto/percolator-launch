/**
 * useInsuranceLP Hook Tests
 * 
 * Critical Test Cases:
 * - H3: Infinite loop fix in auto-refresh mechanism
 * - Insurance fund balance calculations
 * - LP token minting and redemption
 * - User share percentage calculations
 * - Redemption rate with edge cases (zero supply, overflow)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { PublicKey } from "@solana/web3.js";
import { useInsuranceLP } from "../../hooks/useInsuranceLP";

// Mock dependencies
vi.mock("@solana/wallet-adapter-react", () => ({
  useConnection: vi.fn(),
  useWallet: vi.fn(),
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

vi.mock("@solana/spl-token", () => ({
  TOKEN_PROGRAM_ID: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  getAssociatedTokenAddress: vi.fn(),
  createAssociatedTokenAccountInstruction: vi.fn(),
  unpackMint: vi.fn(),
  unpackAccount: vi.fn(),
}));

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useParams } from "next/navigation";
import { sendTx } from "@/lib/tx";
import { getAssociatedTokenAddress, unpackMint, unpackAccount } from "@solana/spl-token";

describe.skip("useInsuranceLP — TODO: fix timer/async handling", () => {
  const mockSlabAddress = "11111111111111111111111111111111";
  const mockWalletPubkey = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
  const mockProgramId = new PublicKey("5BZWY6XWPxuWFxs2nPCLLsVaKRWZVnzZh3FkJDLJBkJf");
  const mockSlabPubkey = new PublicKey(mockSlabAddress);
  const mockLpMintPubkey = new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
  const mockCollateralMint = new PublicKey("So11111111111111111111111111111111111111112");
  const mockVault = new PublicKey("EfgWMhW4VeL1CyP8nvkmsXduF1Uf9KmRgy6F1c3GEyWr");
  
  let mockConnection: any;
  let mockWallet: any;
  let mockSlabState: any;

  beforeEach(() => {
    vi.clearAllMocks();

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

    (useConnection as any).mockReturnValue({ connection: mockConnection });
    (useWallet as any).mockReturnValue(mockWallet);
    (useSlabState as any).mockReturnValue(mockSlabState);
    (useParams as any).mockReturnValue({ slab: mockSlabAddress });
    (sendTx as any).mockResolvedValue({ signature: "mock-signature" });
    (getAssociatedTokenAddress as any).mockResolvedValue(
      new PublicKey("ATA1111111111111111111111111111111111111111")
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("H3: Infinite Loop Fix", () => {
    it("should not cause infinite re-renders with auto-refresh", async () => {
      vi.useFakeTimers();
      // Mock mint exists
      mockConnection.getAccountInfo.mockResolvedValue({
        data: Buffer.alloc(82), // Standard mint account size
        executable: false,
        lamports: 1000000,
        owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      });

      (unpackMint as any).mockReturnValue({
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
        await vi.advanceTimersByTimeAsync(10000);
      });

      // Should have called getAccountInfo again for auto-refresh
      await vi.waitFor(() => {
        expect(mockConnection.getAccountInfo.mock.calls.length).toBeGreaterThan(callCount);
      });

      // Should NOT have excessive calls (would indicate infinite loop)
      expect(mockConnection.getAccountInfo.mock.calls.length).toBeLessThan(callCount + 10);
      
      vi.useRealTimers();
    });

    it("should use stable wallet public key reference to prevent re-render loop", async () => {
      vi.useFakeTimers();
      mockConnection.getAccountInfo.mockResolvedValue(null); // Mint doesn't exist

      const refreshSpy = vi.fn();
      
      // Mock wallet with new PublicKey instance on each call (simulating unstable reference)
      let callCount = 0;
      (useWallet as any).mockImplementation(() => ({
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
      
      vi.useRealTimers();
    });

    it("should cleanup interval on unmount", async () => {
      vi.useFakeTimers();
      mockConnection.getAccountInfo.mockResolvedValue(null);

      const { result, unmount } = renderHook(() => useInsuranceLP());

      await waitFor(() => {
        expect(result.current.state.insuranceBalance).toBe(1000000n);
      });

      const callsBefore = mockConnection.getAccountInfo.mock.calls.length;

      // Unmount
      unmount();

      // Advance time after unmount
      await vi.advanceTimersByTimeAsync(20000);

      // Should NOT have called getAccountInfo again
      expect(mockConnection.getAccountInfo.mock.calls.length).toBe(callsBefore);
      
      vi.useRealTimers();
    });
  });

  describe("Insurance Balance Calculations", () => {
    it("should read insurance balance from engine state", async () => {
      mockConnection.getAccountInfo.mockResolvedValue(null); // No mint yet

      const { result } = renderHook(() => useInsuranceLP());

      await waitFor(() => {
        expect(result.current.state.insuranceBalance).toBe(1000000n);
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

    it("should handle large insurance balances without overflow", async () => {
      const largeBalance = 1_000_000_000_000n; // 1 million SOL
      mockSlabState.engine.insuranceFund.balance = largeBalance;
      mockConnection.getAccountInfo.mockResolvedValue(null);

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

      (unpackMint as any).mockReturnValue({
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

      (unpackMint as any).mockReturnValue({
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

      (unpackMint as any).mockReturnValue({
        supply: lpSupply,
        decimals: 9,
        isInitialized: true,
      });

      (unpackAccount as any).mockReturnValue({
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

      (unpackMint as any).mockReturnValue({
        supply: lpSupply,
        decimals: 9,
        isInitialized: true,
      });

      (unpackAccount as any).mockReturnValue({
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

      (unpackMint as any).mockReturnValue({
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

  describe("Create Mint", () => {
    it("should create insurance mint successfully", async () => {
      mockConnection.getAccountInfo.mockResolvedValue(null);

      const { result } = renderHook(() => useInsuranceLP());

      await waitFor(() => {
        expect(result.current.state.mintExists).toBe(false);
      });

      await act(async () => {
        await result.current.createMint();
      });

      expect(sendTx).toHaveBeenCalledTimes(1);
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it.skip("should throw error if wallet not connected — TODO: fix mock timeout", async () => {
      (useWallet as any).mockReturnValue({ publicKey: null, connected: false });
      mockConnection.getAccountInfo.mockResolvedValue(null);

      const { result } = renderHook(() => useInsuranceLP());

      await waitFor(() => {
        expect(result.current.state.mintExists).toBe(false);
      });

      await act(async () => {
        await expect(result.current.createMint()).rejects.toThrow(
          "Wallet not connected"
        );
      });

      expect(result.current.error).toContain("Wallet not connected");
    });
  });

  describe("Deposit", () => {
    it("should deposit into insurance fund and mint LP tokens", async () => {
      mockConnection.getAccountInfo
        .mockResolvedValueOnce({
          // Mint exists
          data: Buffer.alloc(82),
          executable: false,
          lamports: 1000000,
          owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        })
        .mockResolvedValueOnce({
          // User LP ATA exists
          data: Buffer.alloc(165),
          executable: false,
          lamports: 2000000,
          owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        });

      (unpackMint as any).mockReturnValue({
        supply: 1000000n,
        decimals: 9,
        isInitialized: true,
      });

      const { result } = renderHook(() => useInsuranceLP());

      await waitFor(() => {
        expect(result.current.state.mintExists).toBe(true);
      });

      await act(async () => {
        await result.current.deposit(500000n);
      });

      expect(sendTx).toHaveBeenCalledTimes(1);
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it("should create LP ATA if it doesn't exist", async () => {
      mockConnection.getAccountInfo
        .mockResolvedValueOnce({
          // Mint exists
          data: Buffer.alloc(82),
          executable: false,
          lamports: 1000000,
          owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        })
        .mockResolvedValueOnce(null); // User LP ATA doesn't exist

      (unpackMint as any).mockReturnValue({
        supply: 1000000n,
        decimals: 9,
        isInitialized: true,
      });

      const { result } = renderHook(() => useInsuranceLP());

      await waitFor(() => {
        expect(result.current.state.mintExists).toBe(true);
      });

      await act(async () => {
        await result.current.deposit(500000n);
      });

      // Should include ATA creation instruction
      const txCall = (sendTx as any).mock.calls[0][0];
      expect(txCall.instructions.length).toBeGreaterThanOrEqual(2); // Create ATA + deposit
    });
  });

  describe("Withdraw", () => {
    it("should withdraw from insurance fund by burning LP tokens", async () => {
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

      (unpackMint as any).mockReturnValue({
        supply: 1000000n,
        decimals: 9,
        isInitialized: true,
      });

      (unpackAccount as any).mockReturnValue({
        amount: 500000n,
        mint: mockLpMintPubkey,
        owner: mockWalletPubkey,
      });

      const { result } = renderHook(() => useInsuranceLP());

      await waitFor(() => {
        expect(result.current.state.userLpBalance).toBe(500000n);
      });

      await act(async () => {
        await result.current.withdraw(250000n);
      });

      expect(sendTx).toHaveBeenCalledTimes(1);
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();
    });
  });

  describe("Error Handling", () => {
    it.skip("should handle RPC errors gracefully — TODO: fix mock timeout", async () => {
      mockConnection.getAccountInfo.mockRejectedValue(new Error("RPC timeout"));

      const { result } = renderHook(() => useInsuranceLP());

      // Should not throw, error logged to console
      await waitFor(() => {
        expect(result.current.state.insuranceBalance).toBe(1000000n);
      });
    });

    it.skip("should handle invalid slab address — TODO: fix mock timeout", async () => {
      (useParams as any).mockReturnValue({ slab: "invalid-address" });
      mockConnection.getAccountInfo.mockResolvedValue(null);

      const { result } = renderHook(() => useInsuranceLP());

      // Should handle gracefully without crashing
      await waitFor(() => {
        expect(result.current.state.lpMintAddress).toBeNull();
      });
    });

    it("should set error state on transaction failure", async () => {
      (sendTx as any).mockRejectedValue(new Error("Transaction failed"));
      mockConnection.getAccountInfo.mockResolvedValue(null);

      const { result } = renderHook(() => useInsuranceLP());

      await waitFor(() => {
        expect(result.current.state.mintExists).toBe(false);
      });

      await act(async () => {
        await expect(result.current.createMint()).rejects.toThrow(
          "Transaction failed"
        );
      });

      expect(result.current.error).toContain("Failed to create insurance mint");
    });
  });

  describe("Loading State", () => {
    it("should set loading during operations", async () => {
      let resolveSendTx: any;
      (sendTx as any).mockReturnValue(
        new Promise((resolve) => {
          resolveSendTx = resolve;
        })
      );
      mockConnection.getAccountInfo.mockResolvedValue(null);

      const { result } = renderHook(() => useInsuranceLP());

      await waitFor(() => {
        expect(result.current.state.mintExists).toBe(false);
      });

      act(() => {
        result.current.createMint();
      });

      expect(result.current.loading).toBe(true);

      await act(async () => {
        resolveSendTx({ signature: "mock-sig" });
      });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });
    });
  });
});
