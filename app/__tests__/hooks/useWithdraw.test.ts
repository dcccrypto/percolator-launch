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

vi.mock("@percolatorct/sdk", async () => {
  const actual = await vi.importActual("@percolatorct/sdk");
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
import { getAta } from "@percolatorct/sdk";

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
        indexFeedId: new PublicKey(new Uint8Array(32).fill(1)),
        authorityPriceE6: 1000000n,
      },
      programId: mockProgramId,
      refresh: vi.fn(),
    };

    vi.mocked(useConnectionCompat).mockReturnValue({ connection: mockConnection });
    vi.mocked(useWalletCompat).mockReturnValue(mockWallet);
    vi.mocked(useSlabState).mockReturnValue(mockSlabState);
    vi.mocked(sendTx).mockResolvedValue({ signature: "mock-signature" });
    vi.mocked(getAta).mockResolvedValue(mockUserAta);

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

      const txCall = vi.mocked(sendTx).mock.calls[0][0];
      expect(txCall.instructions.length).toBeGreaterThanOrEqual(2); // crank + withdraw
    });

    it("rejects explicit inline oracle pushes for admin oracle markets until server-side migration lands", async () => {
      mockSlabState.config.oracleAuthority = mockWalletPubkey;

      const { result } = renderHook(() => useWithdraw(mockSlabAddress));

      await act(async () => {
        await expect(
          result.current.withdraw({
            userIdx: 1,
            amount: 1000000n,
          })
        ).rejects.toThrow(/server-side oracle publisher/i);
      });

      expect(sendTx).not.toHaveBeenCalled();
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
    it("rejects inline oracle pushes when the connected wallet is the admin-oracle publisher", async () => {
      mockSlabState.config.oracleAuthority = mockWalletPubkey;

      const { result } = renderHook(() => useWithdraw(mockSlabAddress));

      await act(async () => {
        await expect(
          result.current.withdraw({
            userIdx: 1,
            amount: 1000000n,
          })
        ).rejects.toThrow(/server-side oracle publisher/i);
      });

      expect(sendTx).not.toHaveBeenCalled();
    });

    it("should detect admin oracle when feed is all zeros", async () => {
      mockSlabState.config.indexFeedId = PublicKey.default;

      const { result } = renderHook(() => useWithdraw(mockSlabAddress));

      await act(async () => {
        await result.current.withdraw({
          userIdx: 1,
          amount: 1000000n,
        });
      });

      expect(sendTx).toHaveBeenCalled();
    });

    it("does not attempt the removed inline oracle publisher flow", async () => {
      mockSlabState.config.oracleAuthority = mockWalletPubkey;

      const { result } = renderHook(() => useWithdraw(mockSlabAddress));

      await act(async () => {
        await expect(
          result.current.withdraw({
            userIdx: 1,
            amount: 1000000n,
          })
        ).rejects.toThrow(/server-side oracle publisher/i);
      });

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("surfaces a migration error instead of trying backend price fallback", async () => {
      mockSlabState.config.oracleAuthority = mockWalletPubkey;

      const { result } = renderHook(() => useWithdraw(mockSlabAddress));

      await act(async () => {
        await expect(
          result.current.withdraw({
            userIdx: 1,
            amount: 1000000n,
          })
        ).rejects.toThrow(/server-side oracle publisher/i);
      });

      expect(sendTx).not.toHaveBeenCalled();
      expect(result.current.error).toMatch(/server-side oracle publisher/i);
    });

  });

  describe("Error Handling", () => {
    it("should throw error if wallet not connected", async () => {
      vi.mocked(useWalletCompat).mockReturnValue({ publicKey: null, connected: false });

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
      vi.mocked(useSlabState).mockReturnValue({ config: null, programId: null, refresh: vi.fn() });

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
      vi.mocked(sendTx).mockRejectedValue(new Error("Insufficient balance"));

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
      vi.mocked(sendTx).mockRejectedValueOnce(new Error("First error"));

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
      vi.mocked(sendTx).mockResolvedValue({ signature: "success" });

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

      const txCall = vi.mocked(sendTx).mock.calls[0][0];
      expect(txCall.computeUnits).toBe(300_000);
    });
  });

  describe("Loading State", () => {
    it("should set loading state during withdrawal", async () => {
      let resolveSendTx: any;
      vi.mocked(sendTx).mockReturnValue(
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
      vi.mocked(sendTx).mockRejectedValue(new Error("Failed"));

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
