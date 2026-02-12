/**
 * useInsuranceLP Hook Tests
 * 
 * Critical Test Cases:
 * - H3: Infinite loop fix in auto-refresh
 * - Insurance LP state calculations
 * - Mint creation for admin
 * - Deposit/withdrawal flow
 * - Redemption rate calculations
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
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

vi.mock("../lib/tx", () => ({
  sendTx: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: vi.fn(),
}));

vi.mock("@solana/spl-token", async () => {
  const actual = await vi.importActual("@solana/spl-token");
  return {
    ...actual,
    getAssociatedTokenAddress: vi.fn(),
    createAssociatedTokenAccountInstruction: vi.fn(),
    unpackMint: vi.fn(),
    unpackAccount: vi.fn(),
  };
});

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useSlabState } from "@/components/providers/SlabProvider";
import { sendTx } from "../lib/tx";
import { useParams } from "next/navigation";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  unpackMint,
  unpackAccount,
} from "@solana/spl-token";

describe("useInsuranceLP", () => {
  const mockSlabAddress = "11111111111111111111111111111111";
  const mockWalletPubkey = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
  const mockProgramId = new PublicKey("5BZWY6XWPxuWFxs2nPCLLsVaKRWZVnzZh3FkJDLJBkJf");
  const mockCollateralMint = new PublicKey("So11111111111111111111111111111111111111112");
  const mockVault = new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
  const mockLpMint = new PublicKey("DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1");
  const mockUserLpAta = new PublicKey("EhcT8iqx3u8RNMR5yPzG9CWqVmrKnRKV3y9RkHqQ3Qds");

  let mockConnection: any;
  let mockWallet: any;
  let mockSlabState: any;
  let refreshCallCount: number;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    refreshCallCount = 0;

    // Mock connection
    mockConnection = {
      getAccountInfo: vi.fn().mockImplementation(async (pubkey) => {
        refreshCallCount++;
        
        // Mock LP mint account
        if (pubkey.equals(mockLpMint)) {
          return {
            data: Buffer.alloc(82), // Mint account size
            executable: false,
            lamports: 1000000,
            owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
          };
        }
        
        // Mock user LP ATA
        if (pubkey.equals(mockUserLpAta)) {
          return {
            data: Buffer.alloc(165), // Token account size
            executable: false,
            lamports: 2039280,
            owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
          };
        }
        
        return null;
      }),
    };

    // Mock wallet
    mockWallet = {
      publicKey: mockWalletPubkey,
      signTransaction: vi.fn(),
      connected: true,
    };

    // Mock slab state
    mockSlabState = {
      config: {
        collateralMint: mockCollateralMint,
        vaultPubkey: mockVault,
      },
      engine: {
        insuranceFund: {
          balance: 10_000000n, // 10 SOL
        },
      },
      programId: mockProgramId.toBase58(),
    };

    (useConnection as any).mockReturnValue({ connection: mockConnection });
    (useWallet as any).mockReturnValue(mockWallet);
    (useSlabState as any).mockReturnValue(mockSlabState);
    (useParams as any).mockReturnValue({ slab: mockSlabAddress });
    (sendTx as any).mockResolvedValue({ signature: "mock-signature" });
    (getAssociatedTokenAddress as any).mockResolvedValue(mockUserLpAta);
    (createAssociatedTokenAccountInstruction as any).mockReturnValue({
      keys: [],
      programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      data: Buffer.alloc(0),
    });

    // Mock unpackMint to return mint data
    (unpackMint as any).mockReturnValue({
      mintAuthority: mockProgramId,
      supply: 5_000000n, // 5 LP tokens
      decimals: 6,
      isInitialized: true,
      freezeAuthority: null,
    });

    // Mock unpackAccount to return user balance
    (unpackAccount as any).mockReturnValue({
      mint: mockLpMint,
      owner: mockWalletPubkey,
      amount: 2_000000n, // 2 LP tokens
      delegate: null,
      delegatedAmount: 0n,
      isInitialized: true,
      isFrozen: false,
      isNative: false,
      rentExemptReserve: null,
      closeAuthority: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("H3: Infinite Loop Fix - Auto-Refresh", () => {
    it("should NOT cause infinite loop with stable dependencies", async () => {
      const { result, unmount } = renderHook(() => useInsuranceLP());

      // Initial render triggers first refresh
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      const initialCallCount = refreshCallCount;
      expect(initialCallCount).toBeGreaterThan(0);

      // Advance timer by 10s (one auto-refresh cycle)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      const afterOneRefresh = refreshCallCount;
      
      // Should have called refresh ONCE more (not continuously)
      expect(afterOneRefresh).toBeLessThan(initialCallCount + 5);

      // Advance another 10s
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      const afterTwoRefreshes = refreshCallCount;
      
      // Should be stable (not exponentially growing)
      expect(afterTwoRefreshes).toBeLessThan(afterOneRefresh + 5);

      unmount();
    });

    it("should use empty dependency array to prevent infinite loop", async () => {
      const { result, unmount } = renderHook(() => useInsuranceLP());

      // Let it run for 30 seconds
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });

      // Should have ~3 auto-refreshes (every 10s) + initial
      // If there's an infinite loop, this would be in the thousands
      expect(refreshCallCount).toBeLessThan(20);

      unmount();
    });

    it("should capture refreshState at mount time to prevent dependency changes", async () => {
      const { result, rerender, unmount } = renderHook(() => useInsuranceLP());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      const callCountBeforeRerender = refreshCallCount;

      // Change wallet pubkey (should NOT retrigger useEffect)
      (useWallet as any).mockReturnValue({
        publicKey: new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"),
        connected: true,
      });

      rerender();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Should NOT have caused a new refresh cycle
      expect(refreshCallCount).toBe(callCountBeforeRerender);

      unmount();
    });

    it("should cleanup interval on unmount to prevent memory leaks", async () => {
      const { unmount } = renderHook(() => useInsuranceLP());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      const callCountBeforeUnmount = refreshCallCount;

      unmount();

      // Advance time after unmount
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });

      // Should NOT have called refresh after unmount
      expect(refreshCallCount).toBe(callCountBeforeUnmount);
    });

    it("should handle rapid mount/unmount without infinite loop", async () => {
      // Simulate rapid component mounting/unmounting
      for (let i = 0; i < 5; i++) {
        const { unmount } = renderHook(() => useInsuranceLP());
        
        await act(async () => {
          await vi.advanceTimersByTimeAsync(50);
        });
        
        unmount();
      }

      // Should be stable (not exponentially growing)
      expect(refreshCallCount).toBeLessThan(30);
    });
  });

  describe("Insurance State Calculations", () => {
    it("should calculate redemption rate correctly", async () => {
      const { result } = renderHook(() => useInsuranceLP());

      await waitFor(() => {
        expect(result.current.state.redemptionRateE6).toBe(2_000000n); // 10 SOL / 5 LP = 2.0
      });
    });

    it("should calculate user share percentage correctly", async () => {
      const { result } = renderHook(() => useInsuranceLP());

      await waitFor(() => {
        expect(result.current.state.userSharePct).toBe(40); // 2 LP / 5 LP = 40%
      });
    });

    it("should calculate user redeemable value correctly", async () => {
      const { result } = renderHook(() => useInsuranceLP());

      await waitFor(() => {
        expect(result.current.state.userRedeemableValue).toBe(4_000000n); // 40% of 10 SOL = 4 SOL
      });
    });

    it("should handle zero LP supply (1:1 redemption rate)", async () => {
      (unpackMint as any).mockReturnValue({
        mintAuthority: mockProgramId,
        supply: 0n,
        decimals: 6,
        isInitialized: true,
        freezeAuthority: null,
      });

      const { result } = renderHook(() => useInsuranceLP());

      await waitFor(() => {
        expect(result.current.state.redemptionRateE6).toBe(1_000000n); // 1:1
      });
    });

    it("should handle mint not existing yet", async () => {
      mockConnection.getAccountInfo.mockResolvedValue(null);

      const { result } = renderHook(() => useInsuranceLP());

      await waitFor(() => {
        expect(result.current.state.mintExists).toBe(false);
        expect(result.current.state.lpSupply).toBe(0n);
        expect(result.current.state.userLpBalance).toBe(0n);
      });
    });
  });

  describe("Wallet PublicKey Stability", () => {
    it("should use stabilized wallet pubkey string to prevent re-renders", async () => {
      const { result, rerender } = renderHook(() => useInsuranceLP());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      const initialBalance = result.current.state.userLpBalance;

      // Mock returns a NEW PublicKey instance (different object, same value)
      (useWallet as any).mockReturnValue({
        publicKey: new PublicKey(mockWalletPubkey.toBase58()),
        connected: true,
      });

      rerender();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Balance should remain stable (not trigger unnecessary re-fetch)
      expect(result.current.state.userLpBalance).toBe(initialBalance);
    });

    it("should handle wallet disconnect gracefully", async () => {
      const { result, rerender } = renderHook(() => useInsuranceLP());

      await waitFor(() => {
        expect(result.current.state.userLpBalance).toBeGreaterThan(0n);
      });

      // Disconnect wallet
      (useWallet as any).mockReturnValue({
        publicKey: null,
        connected: false,
      });

      rerender();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Should gracefully handle null wallet
      expect(result.current.state.insuranceBalance).toBe(10_000000n);
    });
  });

  describe("Deposit Flow", () => {
    it("should create LP ATA if it doesn't exist", async () => {
      mockConnection.getAccountInfo.mockImplementation(async (pubkey) => {
        if (pubkey.equals(mockUserLpAta)) {
          return null; // ATA doesn't exist
        }
        if (pubkey.equals(mockLpMint)) {
          return { data: Buffer.alloc(82), executable: false, lamports: 1000000, owner: mockProgramId };
        }
        return null;
      });

      const { result } = renderHook(() => useInsuranceLP());

      await act(async () => {
        await result.current.deposit(1_000000n);
      });

      expect(createAssociatedTokenAccountInstruction).toHaveBeenCalled();
      expect(sendTx).toHaveBeenCalled();
    });

    it("should deposit successfully", async () => {
      const { result } = renderHook(() => useInsuranceLP());

      await act(async () => {
        await result.current.deposit(5_000000n);
      });

      expect(sendTx).toHaveBeenCalledTimes(1);
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it("should refresh state after deposit", async () => {
      const { result } = renderHook(() => useInsuranceLP());

      const initialCallCount = refreshCallCount;

      await act(async () => {
        await result.current.deposit(1_000000n);
      });

      // Should have triggered a refresh after deposit
      expect(refreshCallCount).toBeGreaterThan(initialCallCount);
    });
  });

  describe("Withdrawal Flow", () => {
    it("should withdraw successfully", async () => {
      const { result } = renderHook(() => useInsuranceLP());

      await act(async () => {
        await result.current.withdraw(1_000000n);
      });

      expect(sendTx).toHaveBeenCalledTimes(1);
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it("should refresh state after withdrawal", async () => {
      const { result } = renderHook(() => useInsuranceLP());

      const initialCallCount = refreshCallCount;

      await act(async () => {
        await result.current.withdraw(1_000000n);
      });

      // Should have triggered a refresh after withdrawal
      expect(refreshCallCount).toBeGreaterThan(initialCallCount);
    });
  });

  describe("Create Mint (Admin)", () => {
    it("should create insurance mint successfully", async () => {
      const { result } = renderHook(() => useInsuranceLP());

      await act(async () => {
        await result.current.createMint();
      });

      expect(sendTx).toHaveBeenCalledTimes(1);
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it("should refresh state after mint creation", async () => {
      const { result } = renderHook(() => useInsuranceLP());

      const initialCallCount = refreshCallCount;

      await act(async () => {
        await result.current.createMint();
      });

      // Should have triggered a refresh
      expect(refreshCallCount).toBeGreaterThan(initialCallCount);
    });
  });

  describe("Error Handling", () => {
    it("should throw error if wallet not connected", async () => {
      (useWallet as any).mockReturnValue({ publicKey: null, connected: false });

      const { result } = renderHook(() => useInsuranceLP());

      await act(async () => {
        await expect(result.current.deposit(1_000000n)).rejects.toThrow(
          "Wallet not connected"
        );
      });
    });

    it("should set error state on deposit failure", async () => {
      (sendTx as any).mockRejectedValue(new Error("Transaction failed"));

      const { result } = renderHook(() => useInsuranceLP());

      await act(async () => {
        await result.current.deposit(1_000000n).catch(() => {});
      });

      expect(result.current.error).toBe("Transaction failed");
    });

    it("should handle missing slab state gracefully", async () => {
      (useSlabState as any).mockReturnValue(null);

      const { result } = renderHook(() => useInsuranceLP());

      await act(async () => {
        await expect(result.current.deposit(1_000000n)).rejects.toThrow();
      });
    });
  });

  describe("Manual Refresh", () => {
    it("should allow manual refresh", async () => {
      const { result } = renderHook(() => useInsuranceLP());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      const callCountBefore = refreshCallCount;

      await act(async () => {
        await result.current.refreshState();
      });

      expect(refreshCallCount).toBeGreaterThan(callCountBefore);
    });
  });
});
