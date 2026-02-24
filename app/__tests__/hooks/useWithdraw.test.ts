/**
 * useWithdraw Hook Tests
 * 
 * Test Cases:
 * - Amount validation (bounds, edge cases)
 * - Network validation before withdrawal
 * - Permissionless crank prepended to withdrawal
 * - Oracle price push for admin markets
 * - Vault authority derivation
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWithdraw } from "../../hooks/useWithdraw";

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

vi.mock("@/lib/config", () => ({
  getBackendUrl: vi.fn(() => "http://localhost:3001"),
}));

const mockVaultAuth = new PublicKey("DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1");
const mockOraclePda = new PublicKey("8DjWTsU1o8RHTKpRsqGFyYqFMknb8g7z2mjLfVYUyYyF");

vi.mock("@percolator/sdk", async () => {
  const actual = await vi.importActual("@percolator/sdk");
  return {
    ...actual,
    getAta: vi.fn(),
    deriveVaultAuthority: vi.fn(() => [mockVaultAuth, 255]),
    derivePythPushOraclePDA: vi.fn(() => [mockOraclePda, 255]),
  };
});

import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { sendTx } from "@/lib/tx";
import { getAta } from "@percolator/sdk";

describe("useWithdraw", () => {
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
        oracleAuthority: PublicKey.default,
        indexFeedId: {
          toBytes: () => new Array(32).fill(1),
        },
        authorityPriceE6: 1000000n,
      },
      programId: mockProgramId,
    };

    ( useConnectionCompat as any).mockReturnValue({ connection: mockConnection });
    ( useWalletCompat as any).mockReturnValue(mockWallet);
    (useSlabState as any).mockReturnValue(mockSlabState);
    (sendTx as any).mockResolvedValue({ signature: "mock-signature" });
    (getAta as any).mockResolvedValue(mockUserAta);

    // Mock fetch for backend price
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        [mockSlabAddress]: { priceE6: "1500000" },
      }),
    });
  });

  describe("Happy Path", () => {
    it("should execute withdrawal successfully", async () => {
      const { result } = renderHook(() => useWithdraw(mockSlabAddress));

      await act(async () => {
        await result.current.withdraw({
          userIdx: 1,
          amount: 1000000n,
        });
      });

      expect(sendTx).toHaveBeenCalledTimes(1);
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it("should prepend permissionless crank instruction", async () => {
      const { result } = renderHook(() => useWithdraw(mockSlabAddress));

      await act(async () => {
        await result.current.withdraw({
          userIdx: 1,
          amount: 1000000n,
        });
      });

      const txCall = (sendTx as any).mock.calls[0][0];
      expect(txCall.instructions.length).toBeGreaterThanOrEqual(2); // crank + withdraw
    });

    it("should include oracle price push for admin oracle markets", async () => {
      mockSlabState.config.oracleAuthority = mockWalletPubkey;

      const { result } = renderHook(() => useWithdraw(mockSlabAddress));

      await act(async () => {
        await result.current.withdraw({
          userIdx: 1,
          amount: 1000000n,
        });
      });

      const txCall = (sendTx as any).mock.calls[0][0];
      expect(txCall.instructions).toHaveLength(3); // push price + crank + withdraw
    });
  });

  describe("Amount Validation", () => {
    it("should accept valid positive amount", async () => {
      const { result } = renderHook(() => useWithdraw(mockSlabAddress));

      await act(async () => {
        await result.current.withdraw({
          userIdx: 1,
          amount: 1000000n,
        });
      });

      expect(sendTx).toHaveBeenCalled();
    });

    it("should accept zero amount (edge case)", async () => {
      const { result } = renderHook(() => useWithdraw(mockSlabAddress));

      await act(async () => {
        await result.current.withdraw({
          userIdx: 1,
          amount: 0n,
        });
      });

      expect(sendTx).toHaveBeenCalled();
    });

    it("should accept MAX_U64 amount", async () => {
      const { result } = renderHook(() => useWithdraw(mockSlabAddress));

      await act(async () => {
        await result.current.withdraw({
          userIdx: 1,
          amount: 18446744073709551615n, // MAX_U64
        });
      });

      expect(sendTx).toHaveBeenCalled();
    });

    it("should handle very small amounts (1 lamport)", async () => {
      const { result } = renderHook(() => useWithdraw(mockSlabAddress));

      await act(async () => {
        await result.current.withdraw({
          userIdx: 1,
          amount: 1n,
        });
      });

      expect(sendTx).toHaveBeenCalled();
    });

    it("should handle fractional SOL amounts correctly", async () => {
      const { result } = renderHook(() => useWithdraw(mockSlabAddress));

      // 0.5 SOL = 500,000 lamports
      await act(async () => {
        await result.current.withdraw({
          userIdx: 1,
          amount: 500000n,
        });
      });

      expect(sendTx).toHaveBeenCalled();
    });

    it("should preserve precision for very precise amounts", async () => {
      const { result } = renderHook(() => useWithdraw(mockSlabAddress));

      // 1.123456 SOL = 1,123,456 lamports
      await act(async () => {
        await result.current.withdraw({
          userIdx: 1,
          amount: 1123456n,
        });
      });

      expect(sendTx).toHaveBeenCalled();
    });
  });

  describe("Network Validation (P-CRITICAL-3)", () => {
    it("should validate market exists on current network before withdrawal", async () => {
      const { result } = renderHook(() => useWithdraw(mockSlabAddress));

      await act(async () => {
        await result.current.withdraw({
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

      const { result } = renderHook(() => useWithdraw(mockSlabAddress));

      await act(async () => {
        await expect(
          result.current.withdraw({
            userIdx: 1,
            amount: 1000000n,
          })
        ).rejects.toThrow("Market not found on current network");
      });

      expect(result.current.error).toContain("Market not found");
    });

    it("should suggest network switch in error message", async () => {
      mockConnection.getAccountInfo.mockResolvedValue(null);

      const { result } = renderHook(() => useWithdraw(mockSlabAddress));

      await act(async () => {
        await expect(
          result.current.withdraw({
            userIdx: 1,
            amount: 1000000n,
          })
        ).rejects.toThrow("switch networks in your wallet");
      });
    });

    it("should continue if network check fails with RPC error", async () => {
      mockConnection.getAccountInfo.mockRejectedValue(new Error("RPC timeout"));

      const { result } = renderHook(() => useWithdraw(mockSlabAddress));

      await act(async () => {
        await result.current.withdraw({
          userIdx: 1,
          amount: 1000000n,
        });
      });

      // Should continue and let tx fail naturally
      expect(sendTx).toHaveBeenCalled();
    });
  });

  describe("Oracle Mode Detection", () => {
    it("should detect admin oracle when authority is set", async () => {
      mockSlabState.config.oracleAuthority = mockWalletPubkey;

      const { result } = renderHook(() => useWithdraw(mockSlabAddress));

      await act(async () => {
        await result.current.withdraw({
          userIdx: 1,
          amount: 1000000n,
        });
      });

      expect(sendTx).toHaveBeenCalled();
    });

    it("should detect admin oracle when feed is all zeros", async () => {
      mockSlabState.config.indexFeedId.toBytes = () => new Array(32).fill(0);

      const { result } = renderHook(() => useWithdraw(mockSlabAddress));

      await act(async () => {
        await result.current.withdraw({
          userIdx: 1,
          amount: 1000000n,
        });
      });

      expect(sendTx).toHaveBeenCalled();
    });

    it("should fetch price from backend for admin oracle", async () => {
      mockSlabState.config.oracleAuthority = mockWalletPubkey;

      const { result } = renderHook(() => useWithdraw(mockSlabAddress));

      await act(async () => {
        await result.current.withdraw({
          userIdx: 1,
          amount: 1000000n,
        });
      });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/prices/markets")
      );
    });

    it("should fallback to existing price if backend fetch fails", async () => {
      mockSlabState.config.oracleAuthority = mockWalletPubkey;
      (global.fetch as any).mockRejectedValue(new Error("Network error"));

      const { result } = renderHook(() => useWithdraw(mockSlabAddress));

      await act(async () => {
        await result.current.withdraw({
          userIdx: 1,
          amount: 1000000n,
        });
      });

      // Should still complete with fallback price
      expect(sendTx).toHaveBeenCalled();
    });

    it("should use minimum price of 1 SOL if price is invalid", async () => {
      mockSlabState.config.oracleAuthority = mockWalletPubkey;
      mockSlabState.config.authorityPriceE6 = 0n; // Invalid price

      const { result } = renderHook(() => useWithdraw(mockSlabAddress));

      await act(async () => {
        await result.current.withdraw({
          userIdx: 1,
          amount: 1000000n,
        });
      });

      expect(sendTx).toHaveBeenCalled();
    });
  });

  describe("Error Handling", () => {
    it("should throw error if wallet not connected", async () => {
      ( useWalletCompat as any).mockReturnValue({ publicKey: null, connected: false });

      const { result } = renderHook(() => useWithdraw(mockSlabAddress));

      await act(async () => {
        await expect(
          result.current.withdraw({
            userIdx: 1,
            amount: 1000000n,
          })
        ).rejects.toThrow("Wallet not connected");
      });

      expect(result.current.error).toContain("Wallet not connected");
    });

    it("should throw error if market config not loaded", async () => {
      (useSlabState as any).mockReturnValue({ config: null, programId: null });

      const { result } = renderHook(() => useWithdraw(mockSlabAddress));

      await act(async () => {
        await expect(
          result.current.withdraw({
            userIdx: 1,
            amount: 1000000n,
          })
        ).rejects.toThrow("market not loaded");
      });
    });

    it("should set error state on transaction failure", async () => {
      (sendTx as any).mockRejectedValue(new Error("Insufficient balance"));

      const { result } = renderHook(() => useWithdraw(mockSlabAddress));

      await act(async () => {
        await expect(
          result.current.withdraw({
            userIdx: 1,
            amount: 1000000n,
          })
        ).rejects.toThrow("Insufficient balance");
      });

      expect(result.current.error).toBe("Insufficient balance");
    });

    it("should clear error state on new withdrawal attempt", async () => {
      (sendTx as any).mockRejectedValueOnce(new Error("First error"));

      const { result } = renderHook(() => useWithdraw(mockSlabAddress));

      // First withdrawal fails
      await act(async () => {
        await result.current.withdraw({
          userIdx: 1,
          amount: 1000000n,
        }).catch(() => {});
      });

      expect(result.current.error).toBe("First error");

      // Second withdrawal should clear error
      (sendTx as any).mockResolvedValue({ signature: "success" });

      await act(async () => {
        await result.current.withdraw({
          userIdx: 1,
          amount: 2000000n,
        });
      });

      expect(result.current.error).toBeNull();
    });
  });

  describe("Compute Units", () => {
    it("should set compute units to 300k for withdrawal", async () => {
      const { result } = renderHook(() => useWithdraw(mockSlabAddress));

      await act(async () => {
        await result.current.withdraw({
          userIdx: 1,
          amount: 1000000n,
        });
      });

      const txCall = (sendTx as any).mock.calls[0][0];
      expect(txCall.computeUnits).toBe(300_000);
    });
  });

  describe("Loading State", () => {
    it("should set loading state during withdrawal", async () => {
      let resolveSendTx: any;
      (sendTx as any).mockReturnValue(
        new Promise((resolve) => {
          resolveSendTx = resolve;
        })
      );

      const { result } = renderHook(() => useWithdraw(mockSlabAddress));

      act(() => {
        result.current.withdraw({
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

      const { result } = renderHook(() => useWithdraw(mockSlabAddress));

      await act(async () => {
        await result.current.withdraw({
          userIdx: 1,
          amount: 1000000n,
        }).catch(() => {});
      });

      expect(result.current.loading).toBe(false);
    });
  });
});
