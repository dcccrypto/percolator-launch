/**
 * useTrade Hook Tests
 * 
 * Critical Test Cases:
 * - H4: RPC cancellation when wallet disconnects mid-trade
 * - C2: Stale preview data prevention
 * - Trade execution flow with permissionless crank
 * - Oracle authority validation
 * - Matcher context validation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { PublicKey } from "@solana/web3.js";
import { useTrade } from "../../hooks/useTrade";

// Mock dependencies
vi.mock("@solana/wallet-adapter-react", () => ({
  useConnection: vi.fn(),
  useWallet: vi.fn(),
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

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useSlabState } from "@/components/providers/SlabProvider";
import { sendTx } from "@/lib/tx";

describe("useTrade", () => {
  const mockSlabAddress = "11111111111111111111111111111111";
  const mockWalletPubkey = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
  const mockProgramId = new PublicKey("5BZWY6XWPxuWFxs2nPCLLsVaKRWZVnzZh3FkJDLJBkJf");
  const mockSlabPubkey = new PublicKey(mockSlabAddress);
  const mockMatcherContext = new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
  
  let mockConnection: any;
  let mockWallet: any;
  let mockSlabState: any;
  let mockAbortController: AbortController;

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
      signAllTransactions: vi.fn(),
      connected: true,
    };

    // Mock slab state  
    const feedIdBuffer = Buffer.alloc(32);
    Buffer.from("FeedId").copy(feedIdBuffer);
    mockSlabState = {
      config: {
        oracleAuthority: PublicKey.default,
        indexFeedId: new PublicKey(feedIdBuffer),
        authorityPriceE6: 1000000n,
      },
      accounts: [
        {
          idx: 0,
          account: {
            owner: mockWalletPubkey,
            matcherContext: mockMatcherContext,
            matcherProgram: new PublicKey("DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1"),
          },
        },
      ],
      programId: mockProgramId,
    };

    (useConnection as any).mockReturnValue({ connection: mockConnection });
    (useWallet as any).mockReturnValue(mockWallet);
    (useSlabState as any).mockReturnValue(mockSlabState);
    (sendTx as any).mockResolvedValue({ signature: "mock-signature" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Happy Path", () => {
    it("should execute trade successfully with permissionless crank", async () => {
      const { result } = renderHook(() => useTrade(mockSlabAddress));

      await act(async () => {
        await result.current.trade({
          lpIdx: 0,
          userIdx: 1,
          size: 1000000n,
        });
      });

      expect(sendTx).toHaveBeenCalledTimes(1);
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();
      
      // Verify instructions include crank + trade
      const txCall = (sendTx as any).mock.calls[0][0];
      expect(txCall.instructions).toHaveLength(2); // crank + trade
    });

    it("should include oracle price push for admin oracle markets", async () => {
      mockSlabState.config.oracleAuthority = mockWalletPubkey;
      
      const { result } = renderHook(() => useTrade(mockSlabAddress));

      await act(async () => {
        await result.current.trade({
          lpIdx: 0,
          userIdx: 1,
          size: 1000000n,
        });
      });

      const txCall = (sendTx as any).mock.calls[0][0];
      expect(txCall.instructions).toHaveLength(3); // push price + crank + trade
    });
  });

  describe("H4: RPC Cancellation on Wallet Disconnect", () => {
    it("should cancel pending RPC calls when wallet disconnects", async () => {
      let resolveGetAccountInfo: any;
      const slowRpcPromise = new Promise((resolve) => {
        resolveGetAccountInfo = resolve;
      });

      mockConnection.getAccountInfo.mockReturnValue(slowRpcPromise);

      const { result, unmount } = renderHook(() => useTrade(mockSlabAddress));

      // Start trade (won't complete due to slow RPC)
      const tradePromise = act(async () => {
        return result.current.trade({
          lpIdx: 0,
          userIdx: 1,
          size: 1000000n,
        }).catch(() => {}); // Catch expected cancellation
      });

      // Simulate wallet disconnect by unmounting
      await act(async () => {
        unmount();
      });

      // Complete the RPC call after disconnect
      resolveGetAccountInfo({
        data: Buffer.alloc(100),
        executable: false,
        lamports: 1000000,
        owner: mockProgramId,
      });

      // Transaction should NOT have been sent
      await tradePromise;
      expect(sendTx).not.toHaveBeenCalled();
    });

    it("should handle AbortError gracefully", async () => {
      const abortError = new Error("AbortError");
      abortError.name = "AbortError";
      mockConnection.getAccountInfo.mockRejectedValue(abortError);

      const { result } = renderHook(() => useTrade(mockSlabAddress));

      await act(async () => {
        await result.current.trade({
          lpIdx: 0,
          userIdx: 1,
          size: 1000000n,
        }).catch(() => {}); // Expect no error thrown
      });

      // Should not set error state for abort
      expect(result.current.error).toBeNull();
    });
  });

  describe("C2: Stale Preview Prevention", () => {
    it("should fetch fresh matcher context before trade", async () => {
      const { result } = renderHook(() => useTrade(mockSlabAddress));

      await act(async () => {
        await result.current.trade({
          lpIdx: 0,
          userIdx: 1,
          size: 1000000n,
        });
      });

      // Verify getAccountInfo was called to validate matcher context
      expect(mockConnection.getAccountInfo).toHaveBeenCalledWith(
        mockMatcherContext,
        expect.any(Object)
      );
    });

    it("should reject trade if matcher context doesn't exist", async () => {
      mockConnection.getAccountInfo.mockResolvedValue(null);

      const { result } = renderHook(() => useTrade(mockSlabAddress));

      await act(async () => {
        await expect(
          result.current.trade({
            lpIdx: 0,
            userIdx: 1,
            size: 1000000n,
          })
        ).rejects.toThrow("Matcher context account not found");
      });

      expect(result.current.error).toContain("Matcher context");
    });

    it("should reject trade if matcher context is default pubkey", async () => {
      mockSlabState.accounts[0].account.matcherContext = PublicKey.default;

      const { result } = renderHook(() => useTrade(mockSlabAddress));

      await act(async () => {
        await expect(
          result.current.trade({
            lpIdx: 0,
            userIdx: 1,
            size: 1000000n,
          })
        ).rejects.toThrow("no vAMM liquidity provider");
      });
    });
  });

  describe("Error Handling", () => {
    it("should throw error if wallet not connected", async () => {
      (useWallet as any).mockReturnValue({ publicKey: null, connected: false });

      const { result } = renderHook(() => useTrade(mockSlabAddress));

      await act(async () => {
        await expect(
          result.current.trade({
            lpIdx: 0,
            userIdx: 1,
            size: 1000000n,
          })
        ).rejects.toThrow("Wallet not connected");
      });

      expect(result.current.error).toContain("Wallet not connected");
    });

    it("should throw error if LP not found", async () => {
      const { result } = renderHook(() => useTrade(mockSlabAddress));

      await act(async () => {
        await expect(
          result.current.trade({
            lpIdx: 99, // Non-existent LP
            userIdx: 1,
            size: 1000000n,
          })
        ).rejects.toThrow("LP at index 99 not found");
      });
    });

    it("should handle RPC errors gracefully", async () => {
      mockConnection.getAccountInfo.mockRejectedValue(new Error("RPC timeout"));

      const { result } = renderHook(() => useTrade(mockSlabAddress));

      await act(async () => {
        await result.current.trade({
          lpIdx: 0,
          userIdx: 1,
          size: 1000000n,
        });
      });

      // Should continue despite RPC error (fail at tx time)
      expect(sendTx).toHaveBeenCalled();
    });
  });

  describe("Oracle Mode Detection", () => {
    it("should detect admin oracle when authority is set", async () => {
      mockSlabState.config.oracleAuthority = mockWalletPubkey;
      
      const { result } = renderHook(() => useTrade(mockSlabAddress));

      await act(async () => {
        await result.current.trade({
          lpIdx: 0,
          userIdx: 1,
          size: 1000000n,
        });
      });

      // Should use slab as oracle account (admin mode)
      expect(sendTx).toHaveBeenCalled();
    });

    it("should detect admin oracle when feed is all zeros", async () => {
      mockSlabState.config.indexFeedId.toBytes = () => new Array(32).fill(0);
      
      const { result } = renderHook(() => useTrade(mockSlabAddress));

      await act(async () => {
        await result.current.trade({
          lpIdx: 0,
          userIdx: 1,
          size: 1000000n,
        });
      });

      expect(sendTx).toHaveBeenCalled();
    });

    it("should use Pyth oracle for standard markets", async () => {
      mockSlabState.config.oracleAuthority = PublicKey.default;
      mockSlabState.config.indexFeedId.toBytes = () => new Array(32).fill(1);
      
      const { result } = renderHook(() => useTrade(mockSlabAddress));

      await act(async () => {
        await result.current.trade({
          lpIdx: 0,
          userIdx: 1,
          size: 1000000n,
        });
      });

      expect(sendTx).toHaveBeenCalled();
    });
  });

  describe("Loading State", () => {
    it("should set loading state during trade execution", async () => {
      let resolveSendTx: any;
      (sendTx as any).mockReturnValue(
        new Promise((resolve) => {
          resolveSendTx = resolve;
        })
      );

      const { result } = renderHook(() => useTrade(mockSlabAddress));

      act(() => {
        result.current.trade({
          lpIdx: 0,
          userIdx: 1,
          size: 1000000n,
        });
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
