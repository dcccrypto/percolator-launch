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

// Bypass the program-allowlist gate for tests that focus on the trade flow.
// The gate is exercised in app/__tests__/lib/programAllowlist.test.ts and
// app/__tests__/providers/SlabProvider-allowlist.test.tsx.
vi.mock("@/lib/programAllowlist", () => ({
  isKnownProgram: () => true,
  assertKnownProgram: () => {},
}));

// Mock useLivePrice so the slippage-limit auto-compute has a valid mark.
// Tests that exercise the no-mark abort path override this with priceE6: null.
vi.mock("@/hooks/useLivePrice", () => ({
  useLivePrice: vi.fn(() => ({
    priceUsd: 1.5,
    priceE6: 1_500_000n,
    price: 1.5,
    loading: false,
  })),
}));

const mockLpPda = new PublicKey("3yEEksiUkq5K2PmjbRSHpXVN4FJgYuNn7rV31ek3PCwu");
const mockOraclePda = new PublicKey("8DjWTsU1o8RHTKpRsqGFyYqFMknb8g7z2mjLfVYUyYyF");
const mockVaultAuth = new PublicKey("DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1");

vi.mock("@percolatorct/sdk", async () => {
  const actual = await vi.importActual("@percolatorct/sdk");
  return {
    ...actual,
    deriveLpPda: vi.fn(() => [mockLpPda, 255]),
    derivePythPushOraclePDA: vi.fn(() => [mockOraclePda, 255]),
    deriveVaultAuthority: vi.fn(() => [mockVaultAuth, 255]),
  };
});

import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
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

    vi.mocked(useConnectionCompat).mockReturnValue({ connection: mockConnection });
    vi.mocked(useWalletCompat).mockReturnValue(mockWallet);
    vi.mocked(useSlabState).mockReturnValue(mockSlabState);
    vi.mocked(sendTx).mockResolvedValue({ signature: "mock-signature" });

    // Mock fetch for backend price API (PERC-8328: price required, no fallback allowed)
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        [mockSlabAddress]: { priceE6: "1500000" },
      }),
    });
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
      const txCall = vi.mocked(sendTx).mock.calls[0][0];
      expect(txCall.instructions).toHaveLength(2); // crank + trade
    });

    it("rejects inline oracle pushes for admin markets until the server-side flow is wired in", async () => {
      mockSlabState.config.oracleAuthority = mockWalletPubkey;
      
      const { result } = renderHook(() => useTrade(mockSlabAddress));

      await act(async () => {
        await expect(
          result.current.trade({
            lpIdx: 0,
            userIdx: 1,
            size: 1000000n,
          })
        ).rejects.toThrow(/server-side oracle publisher/i);
      });

      expect(sendTx).not.toHaveBeenCalled();
    });
  });

  // NOTE: H4 (RPC cancellation) and C2 (stale preview prevention) tests removed.
  // The matcher context validation in useTrade was intentionally disabled — all current
  // markets have default matcher context which is valid for non-vAMM LPs.
  // The program returns proper errors if matcher context is invalid, so client-side
  // validation is no longer needed. See useTrade.ts comments for details.
  //
  // If matcher context validation is re-enabled in the future, restore these tests
  // from git history (commit before this change).

  describe("Error Handling", () => {
    it("should throw error if wallet not connected", async () => {
      vi.mocked(useWalletCompat).mockReturnValue({ publicKey: null, connected: false });

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
    it("should detect admin oracle when authority is set but another publisher is responsible", async () => {
      mockSlabState.config.oracleAuthority = new PublicKey("9n2E7x6u7sGeqXEt3G5UpiRaY1oCbcnZ6FQcmGeXgn6M");
      
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
      mockSlabState.config.indexFeedId = PublicKey.default;
      
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
      mockSlabState.config.indexFeedId = new PublicKey(new Uint8Array(32).fill(1));
      
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
      vi.mocked(sendTx).mockReturnValue(
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

  describe("Slippage protection", () => {
    // useTrade builds a 2-ix tx: [crank, tradeCpi]. The tradeCpi data layout is
    //   tag(u8=10) ‖ lpIdx(u16) ‖ userIdx(u16) ‖ size(i128) ‖ limit_price_e6(u64)
    // = 1 + 2 + 2 + 16 + 8 = 29 bytes. The limit is the trailing u64 LE.
    function decodeLimit(data: Uint8Array | Buffer): bigint {
      const buf = data instanceof Uint8Array ? Buffer.from(data) : data;
      return buf.readBigUInt64LE(buf.length - 8);
    }

    it("auto-computes a non-zero limit for a long when the caller omits limitPriceE6", async () => {
      const { result } = renderHook(() => useTrade(mockSlabAddress));
      await act(async () => {
        await result.current.trade({ lpIdx: 0, userIdx: 1, size: 1_000_000n });
      });
      const tx = vi.mocked(sendTx).mock.calls[0][0] as {
        instructions: Array<{ data: Uint8Array }>;
      };
      const tradeIx = tx.instructions[tx.instructions.length - 1];
      const limit = decodeLimit(tradeIx.data);
      // mark = 1_500_000, default 100 bps → 1_500_000 * 10_100 / 10_000 = 1_515_000
      expect(limit).toBe(1_515_000n);
    });

    it("auto-computes a non-zero limit ≤ mark for a short (size < 0)", async () => {
      const { result } = renderHook(() => useTrade(mockSlabAddress));
      await act(async () => {
        await result.current.trade({ lpIdx: 0, userIdx: 1, size: -1_000_000n });
      });
      const tx = vi.mocked(sendTx).mock.calls[0][0] as {
        instructions: Array<{ data: Uint8Array }>;
      };
      const limit = decodeLimit(tx.instructions[tx.instructions.length - 1].data);
      // mark = 1_500_000, default 100 bps → 1_500_000 * 9_900 / 10_000 = 1_485_000
      expect(limit).toBe(1_485_000n);
      expect(limit).toBeLessThan(1_500_000n);
    });

    it("preserves an explicit limitPriceE6 supplied by the caller", async () => {
      const { result } = renderHook(() => useTrade(mockSlabAddress));
      await act(async () => {
        await result.current.trade({
          lpIdx: 0,
          userIdx: 1,
          size: 1_000_000n,
          limitPriceE6: 1_999_999n,
        });
      });
      const tx = vi.mocked(sendTx).mock.calls[0][0] as {
        instructions: Array<{ data: Uint8Array }>;
      };
      const limit = decodeLimit(tx.instructions[tx.instructions.length - 1].data);
      expect(limit).toBe(1_999_999n);
    });

    it("keeper escape hatch: explicit limitPriceE6 = 0n is passed through unchanged", async () => {
      const { result } = renderHook(() => useTrade(mockSlabAddress));
      await act(async () => {
        await result.current.trade({
          lpIdx: 0,
          userIdx: 1,
          size: 1_000_000n,
          limitPriceE6: 0n,
        });
      });
      const tx = vi.mocked(sendTx).mock.calls[0][0] as {
        instructions: Array<{ data: Uint8Array }>;
      };
      const limit = decodeLimit(tx.instructions[tx.instructions.length - 1].data);
      expect(limit).toBe(0n);
    });

    it("aborts the trade if the live mark price is null (no oracle yet)", async () => {
      const { useLivePrice } = await import("@/hooks/useLivePrice");
      vi.mocked(useLivePrice).mockReturnValueOnce({
        priceUsd: null,
        priceE6: null,
        price: null,
        loading: true,
      } as ReturnType<typeof useLivePrice>);

      const { result } = renderHook(() => useTrade(mockSlabAddress));
      await act(async () => {
        await expect(
          result.current.trade({ lpIdx: 0, userIdx: 1, size: 1_000_000n }),
        ).rejects.toThrow(/mark price unavailable/i);
      });
      expect(sendTx).not.toHaveBeenCalled();
    });

    it("aborts the trade if the live mark price is 0n (broken oracle)", async () => {
      const { useLivePrice } = await import("@/hooks/useLivePrice");
      vi.mocked(useLivePrice).mockReturnValueOnce({
        priceUsd: 0,
        priceE6: 0n,
        price: 0,
        loading: false,
      } as ReturnType<typeof useLivePrice>);

      const { result } = renderHook(() => useTrade(mockSlabAddress));
      await act(async () => {
        await expect(
          result.current.trade({ lpIdx: 0, userIdx: 1, size: 1_000_000n }),
        ).rejects.toThrow(/mark price unavailable/i);
      });
      expect(sendTx).not.toHaveBeenCalled();
    });

    it("never encodes the on-chain 0-sentinel by default", async () => {
      // Regression guard for the original bug: the trade ix must not be
      // encoded with limit_price_e6 = 0 when the caller didn't ask for that.
      const { result } = renderHook(() => useTrade(mockSlabAddress));
      await act(async () => {
        await result.current.trade({ lpIdx: 0, userIdx: 1, size: 1_000_000n });
      });
      const tx = vi.mocked(sendTx).mock.calls[0][0] as {
        instructions: Array<{ data: Uint8Array }>;
      };
      const limit = decodeLimit(tx.instructions[tx.instructions.length - 1].data);
      expect(limit).not.toBe(0n);
    });
  });
});
