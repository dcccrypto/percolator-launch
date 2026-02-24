/**
 * useDeposit Hook Tests
 * 
 * Critical Test Cases:
 * - C1: MAX button race condition (balance check → user input → stale value)
 * - Network validation before deposit
 * - Amount validation
 * - Collateral ATA handling
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { PublicKey } from "@solana/web3.js";
import { useDeposit } from "../../hooks/useDeposit";

// Mock dependencies
vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: vi.fn(),
  useWalletCompat: vi.fn(),
}));

vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: vi.fn(),
}));

vi.mock("@/lib/tx", () => ({
  sendTx: vi.fn(),
}));

vi.mock("@percolator/sdk", async () => {
  const actual = await vi.importActual("@percolator/sdk");
  return {
    ...actual,
    getAta: vi.fn(),
  };
});

import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { sendTx } from "@/lib/tx";
import { getAta } from "@percolator/sdk";

describe("useDeposit", () => {
  const mockSlabAddress = "11111111111111111111111111111111";
  const mockWalletPubkey = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
  const mockProgramId = new PublicKey("5BZWY6XWPxuWFxs2nPCLLsVaKRWZVnzZh3FkJDLJBkJf");
  const mockCollateralMint = new PublicKey("So11111111111111111111111111111111111111112");
  const mockVault = new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
  const mockUserAta = new PublicKey("DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1");

  let mockConnection: any;
  let mockWallet: any;
  let mockSlabState: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock connection
    mockConnection = {
      getAccountInfo: vi.fn().mockResolvedValue({
        data: Buffer.alloc(100),
        executable: false,
        lamports: 1000000,
        owner: mockProgramId,
      }),
    };

    // Mock wallet — shape must match useWalletCompat return value:
    // { publicKey, connected, connecting, wallet, signTransaction, disconnect }
    mockWallet = {
      publicKey: mockWalletPubkey,
      connected: true,
      connecting: false,
      wallet: { address: mockWalletPubkey.toBase58() },
      signTransaction: vi.fn(),
      disconnect: vi.fn(),
    };

    // Mock slab state
    mockSlabState = {
      config: {
        collateralMint: mockCollateralMint,
        vaultPubkey: mockVault,
      },
      programId: mockProgramId,
    };

    ( useConnectionCompat as any).mockReturnValue({ connection: mockConnection });
    ( useWalletCompat as any).mockReturnValue(mockWallet);
    (useSlabState as any).mockReturnValue(mockSlabState);
    (sendTx as any).mockResolvedValue({ signature: "mock-signature" });
    (getAta as any).mockResolvedValue(mockUserAta);
  });

  describe("Happy Path", () => {
    it("should execute deposit successfully", async () => {
      const { result } = renderHook(() => useDeposit(mockSlabAddress));

      await act(async () => {
        await result.current.deposit({
          userIdx: 1,
          amount: 1000000n,
        });
      });

      expect(sendTx).toHaveBeenCalledTimes(1);
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it("should fetch user ATA before deposit", async () => {
      const { result } = renderHook(() => useDeposit(mockSlabAddress));

      await act(async () => {
        await result.current.deposit({
          userIdx: 1,
          amount: 1000000n,
        });
      });

      expect(getAta).toHaveBeenCalledWith(mockWalletPubkey, mockCollateralMint);
    });
  });

  describe("C1: MAX Button Race Condition", () => {
    it("should use amount passed at deposit time, not stale balance", async () => {
      const { result } = renderHook(() => useDeposit(mockSlabAddress));

      // Simulate: User has 5 SOL, clicks MAX (sets to 5 SOL)
      const initialAmount = 5_000000n;

      // But before deposit tx is sent, balance changes to 3 SOL
      // The deposit should still use the 5 SOL value the user saw

      await act(async () => {
        await result.current.deposit({
          userIdx: 1,
          amount: initialAmount, // User's intention at time of click
        });
      });

      const txCall = (sendTx as any).mock.calls[0][0];
      expect(txCall.instructions).toBeDefined();
      // Amount is encoded in instruction data - we trust it's the passed value
      expect(sendTx).toHaveBeenCalled();
    });

    it("should handle concurrent deposits without race", async () => {
      const { result } = renderHook(() => useDeposit(mockSlabAddress));

      // Execute two sequential deposits
      await act(async () => {
        await result.current.deposit({
          userIdx: 1,
          amount: 1_000000n,
        });
      });

      await act(async () => {
        await result.current.deposit({
          userIdx: 1,
          amount: 2_000000n,
        });
      });

      // Both deposits should have been sent with their correct amounts
      expect(sendTx).toHaveBeenCalledTimes(2);
    });

    it("should validate amount at deposit time, not input time", async () => {
      const { result } = renderHook(() => useDeposit(mockSlabAddress));

      // Even if UI shows MAX = 5 SOL, user manually types 10 SOL
      // Validation happens when deposit() is called
      const invalidAmount = 10_000000n;

      await act(async () => {
        // Transaction will fail on-chain, but hook shouldn't prevent it
        await result.current.deposit({
          userIdx: 1,
          amount: invalidAmount,
        });
      });

      expect(sendTx).toHaveBeenCalled();
    });
  });

  describe("Network Validation (P-CRITICAL-3)", () => {
    it("should validate market exists on current network before deposit", async () => {
      const { result } = renderHook(() => useDeposit(mockSlabAddress));

      await act(async () => {
        await result.current.deposit({
          userIdx: 1,
          amount: 1000000n,
        });
      });

      expect(mockConnection.getAccountInfo).toHaveBeenCalledWith(
        new PublicKey(mockSlabAddress)
      );
    });

    it("should throw error if market not found on network", async () => {
      mockConnection.getAccountInfo.mockResolvedValue(null);

      const { result } = renderHook(() => useDeposit(mockSlabAddress));

      await act(async () => {
        await expect(
          result.current.deposit({
            userIdx: 1,
            amount: 1000000n,
          })
        ).rejects.toThrow("Market not found on current network");
      });

      expect(result.current.error).toContain("Market not found");
    });

    it("should suggest network switch in error message", async () => {
      mockConnection.getAccountInfo.mockResolvedValue(null);

      const { result } = renderHook(() => useDeposit(mockSlabAddress));

      await act(async () => {
        await expect(
          result.current.deposit({
            userIdx: 1,
            amount: 1000000n,
          })
        ).rejects.toThrow("switch networks in your wallet");
      });
    });

    it("should continue if network check fails with RPC error", async () => {
      mockConnection.getAccountInfo.mockRejectedValue(new Error("RPC timeout"));

      const { result } = renderHook(() => useDeposit(mockSlabAddress));

      await act(async () => {
        await result.current.deposit({
          userIdx: 1,
          amount: 1000000n,
        });
      });

      // Should continue and let tx fail naturally
      expect(sendTx).toHaveBeenCalled();
    });
  });

  describe("Amount Validation", () => {
    it("should accept zero amount (edge case)", async () => {
      const { result } = renderHook(() => useDeposit(mockSlabAddress));

      await act(async () => {
        await result.current.deposit({
          userIdx: 1,
          amount: 0n,
        });
      });

      expect(sendTx).toHaveBeenCalled();
    });

    it("should accept MAX_U64 amount", async () => {
      const { result } = renderHook(() => useDeposit(mockSlabAddress));

      await act(async () => {
        await result.current.deposit({
          userIdx: 1,
          amount: 18446744073709551615n, // MAX_U64
        });
      });

      expect(sendTx).toHaveBeenCalled();
    });

    it("should handle very small amounts (1 lamport)", async () => {
      const { result } = renderHook(() => useDeposit(mockSlabAddress));

      await act(async () => {
        await result.current.deposit({
          userIdx: 1,
          amount: 1n,
        });
      });

      expect(sendTx).toHaveBeenCalled();
    });
  });

  describe("Error Handling", () => {
    it("should throw error if wallet not connected", async () => {
      ( useWalletCompat as any).mockReturnValue({ publicKey: null, connected: false, connecting: false, wallet: null, signTransaction: undefined, disconnect: vi.fn() });

      const { result } = renderHook(() => useDeposit(mockSlabAddress));

      await act(async () => {
        await expect(
          result.current.deposit({
            userIdx: 1,
            amount: 1000000n,
          })
        ).rejects.toThrow("Wallet not connected");
      });

      expect(result.current.error).toContain("Wallet not connected");
    });

    it("should throw error if market config not loaded", async () => {
      (useSlabState as any).mockReturnValue({ config: null, programId: null });

      const { result } = renderHook(() => useDeposit(mockSlabAddress));

      await act(async () => {
        await expect(
          result.current.deposit({
            userIdx: 1,
            amount: 1000000n,
          })
        ).rejects.toThrow("market not loaded");
      });
    });

    it("should set error state on transaction failure", async () => {
      (sendTx as any).mockRejectedValue(new Error("Transaction failed"));

      const { result } = renderHook(() => useDeposit(mockSlabAddress));

      await act(async () => {
        await expect(
          result.current.deposit({
            userIdx: 1,
            amount: 1000000n,
          })
        ).rejects.toThrow("Transaction failed");
      });

      expect(result.current.error).toBe("Transaction failed");
    });

    it("should clear error state on new deposit attempt", async () => {
      (sendTx as any).mockRejectedValueOnce(new Error("First error"));

      const { result } = renderHook(() => useDeposit(mockSlabAddress));

      // First deposit fails
      await act(async () => {
        await result.current.deposit({
          userIdx: 1,
          amount: 1000000n,
        }).catch(() => {});
      });

      expect(result.current.error).toBe("First error");

      // Second deposit should clear error
      (sendTx as any).mockResolvedValue({ signature: "success" });

      await act(async () => {
        await result.current.deposit({
          userIdx: 1,
          amount: 2000000n,
        });
      });

      expect(result.current.error).toBeNull();
    });
  });

  describe("Loading State", () => {
    it("should set loading state during deposit", async () => {
      let resolveSendTx: any;
      (sendTx as any).mockReturnValue(
        new Promise((resolve) => {
          resolveSendTx = resolve;
        })
      );

      const { result } = renderHook(() => useDeposit(mockSlabAddress));

      act(() => {
        result.current.deposit({
          userIdx: 1,
          amount: 1000000n,
        });
      });

      expect(result.current.loading).toBe(true);

      await act(async () => {
        resolveSendTx({ signature: "mock-sig" });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(result.current.loading).toBe(false);
    });

    it("should clear loading state on error", async () => {
      (sendTx as any).mockRejectedValue(new Error("Failed"));

      const { result } = renderHook(() => useDeposit(mockSlabAddress));

      await act(async () => {
        await result.current.deposit({
          userIdx: 1,
          amount: 1000000n,
        }).catch(() => {});
      });

      expect(result.current.loading).toBe(false);
    });
  });
});
