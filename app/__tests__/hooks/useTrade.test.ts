/**
 * useTrade Hook Tests
 *
 * Critical Test Cases:
 * - Trade execution flow on a v17/v18 market (the only live path)
 * - Oracle authority wallet is not blocked (5c33e236)
 * - Oracle mode detection drives the self-heal catch-up oracle tail
 * - Slippage limit derivation / pass-through on the v18 TradeCpi wire
 *
 * 2026-10-02 (fix/preexisting-test-failures): this suite used to drive the LEGACY
 * v12 branch (no `raw` on the mocked slab), asserting a [crank, trade] tx sent via
 * `sendTx` and the 29-byte v12 TradeCpi. Trunk moved on:
 *   - 0d975d00: the v18 anti-replay wire — TradeCpi is 85 bytes and binds both
 *     portfolios' identity (live-read via lib/v18-wire), so the v12 branch can no
 *     longer build a trade at all (it is dead: no v12 market is live);
 *   - 6d4112f3 / cc5d74c5: the taker crank NEVER rides in the trade's tx;
 *   - the trade is sent with `sendTxWaiting` (UX WP-2 wait loop + self-heal);
 *   - 18526d86: the LP is resolved by on-chain identity (lib/market-lp.ts, own tests);
 *   - 5c33e236: the oracle-authority wallet trades like any other wallet.
 * The suite now drives the v17 path with the resolver and identity reads stubbed;
 * the assertions keep their intent against the current wire.
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
  sendTxWaiting: vi.fn(),
  prewarmTxLanding: vi.fn(),
  simulateForGate: vi.fn(),
  SimulationRefusal: class SimulationRefusal extends Error {},
  buildBatchTx: vi.fn(),
  signAllCompat: vi.fn(),
  broadcastSignedTx: vi.fn(),
  getPriorityFee: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
}));

// Bypass the program-allowlist gate for tests that focus on the trade flow.
// The gate is exercised in app/__tests__/lib/programAllowlist.test.ts and
// app/__tests__/providers/SlabProvider-allowlist.test.tsx.
vi.mock("@/lib/programAllowlist", () => ({
  isKnownProgram: () => true,
  assertKnownProgram: () => {},
  assertCanonicalMatcher: () => {},
}));

// Mock the price store's non-reactive snapshot reader so the slippage-limit
// auto-compute has a valid mark. useTrade() reads price via
// getLivePriceSnapshot() (a plain function, read fresh at submit time inside
// the trade() callback) rather than the reactive useLivePrice() hook — see
// hooks/useTrade.ts and BUILD-LOG.md Phase 1 for why: useLivePrice() is only
// ever used for JSX display now; a hook subscription here would force every
// component that calls useTrade() to re-render on every price tick.
// Tests that exercise the no-mark abort path override this with priceE6: null.
vi.mock("@/lib/priceStore/priceStore", () => ({
  getLivePriceSnapshot: vi.fn(() => ({
    priceUsd: 1.5,
    priceE6: 1_500_000n,
    price: 1.5,
    change24h: null,
    high24h: null,
    low24h: null,
    loading: false,
  })),
}));

const mockLpPda = new PublicKey("3yEEksiUkq5K2PmjbRSHpXVN4FJgYuNn7rV31ek3PCwu");
const mockOraclePda = new PublicKey("8DjWTsU1o8RHTKpRsqGFyYqFMknb8g7z2mjLfVYUyYyF");
const mockVaultAuth = new PublicKey("DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1");
// A stable mock delegate PDA — avoids the "no viable nonce" error that occurs when
// deriveMatcherDelegate is called with all-zeros pubkeys (PublicKey.default) in tests.
const mockMatcherDelegate = new PublicKey("De1egaTE11111111111111111111111111111111111");
// v17 trade accounts (the LP comes from the identity resolver, the taker from the owner scan).
const mockLpPortfolio = new PublicKey(new Uint8Array(32).fill(51));
const mockTakerPortfolio = new PublicKey(new Uint8Array(32).fill(52));
const mockMatcherProg = new PublicKey(new Uint8Array(32).fill(53));
const mockMatcherCtx = new PublicKey(new Uint8Array(32).fill(54));

vi.mock("@percolatorct/sdk", async () => {
  const actual = await vi.importActual("@percolatorct/sdk");
  return {
    ...actual,
    deriveLpPda: vi.fn(() => [mockLpPda, 255]),
    derivePythPushOraclePDA: vi.fn(() => [mockOraclePda, 255]),
    deriveVaultAuthority: vi.fn(() => [mockVaultAuth, 255]),
    // deriveMatcherDelegate uses findProgramAddressSync which fails when seeds contain
    // all-zero pubkeys (no valid off-curve nonce). Mock it to return a stable key.
    deriveMatcherDelegate: vi.fn(() => [mockMatcherDelegate, 254]),
  };
});

vi.mock("@/lib/market-lp", () => ({
  resolveMarketLp: vi.fn(async () => ({
    pubkey: mockLpPortfolio,
    data: new Uint8Array(0),
    owner: new PublicKey(new Uint8Array(32).fill(55)),
    portfolioId: 1n,
    matcherProg: mockMatcherProg,
    matcherCtx: mockMatcherCtx,
    matcherDelegate: mockMatcherDelegate,
    reason: "asset-admin",
  })),
}));

vi.mock("@/lib/owner-portfolio", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  findOwnerPortfolio: vi.fn(async () => mockTakerPortfolio),
}));

vi.mock("@/lib/v18-wire", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  fetchPortfolioIdentity: vi.fn(async (_c: unknown, pk: PublicKey) => ({
    portfolioId: pk.equals(mockLpPortfolio) ? 1n : 2n,
    matcherSequence: 0n,
    positionEpoch: 0n,
  })),
  fetchAssetMarketId: vi.fn(async () => 1n),
}));

import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { sendTx, sendTxWaiting } from "@/lib/tx";

/** The v17 trade is sent with sendTxWaiting; sendTx only carries a separate taker crank. */
const sent = () => vi.mocked(sendTxWaiting);

/** v18 TradeCpi (85 B): tag | 5×u64 ids | u16 asset | u64 marketId | i128 size | u64 fee | u64 limit | u16 cap. */
const V18_TRADE_CPI_LEN = 85;
const V18_TRADE_CPI_LIMIT_OFF = 75;

/** A v17/v18 market header (magic + version 18 + kind 1) so useTrade takes the live path. */
function v17MarketRaw(): Uint8Array {
  const raw = new Uint8Array(64);
  raw.set([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50], 0);
  raw[8] = 18;
  raw[10] = 1;
  return raw;
}

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
          // GH#2525: must agree with the mocked live feed (priceE6 1_500_000n) to
          // within 200 bps, or the derived slippage limit is refused. This was
          // 1_000_000n against a $1.50 feed — a 50% divergence no real market
          // shows. Raised to match the FEED rather than lowering the feed, because
          // the slippage assertions further down are written against a 1_500_000 mark.
          authorityPriceE6: 1_500_000n,
          // Pyth-pinned markets reference lastEffectivePriceE6 on-chain (same mark).
          lastEffectivePriceE6: 1_500_000n,
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
      // v17/v18 market header — the live path (isV17Account(raw)).
      raw: v17MarketRaw(),
      programId: mockProgramId,
      refresh: vi.fn(),
    };

    vi.mocked(useConnectionCompat).mockReturnValue({ connection: mockConnection });
    vi.mocked(useWalletCompat).mockReturnValue(mockWallet);
    vi.mocked(useSlabState).mockReturnValue(mockSlabState);
    vi.mocked(sendTx).mockResolvedValue({ signature: "mock-signature" });
    vi.mocked(sendTxWaiting).mockResolvedValue("mock-signature");

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
    it("should execute trade successfully as a lone TradeCpi (no crank in the trade's tx)", async () => {
      const { result } = renderHook(() => useTrade(mockSlabAddress));

      await act(async () => {
        await result.current.trade({
          lpIdx: 0,
          userIdx: 1,
          size: 1000000n,
        });
      });

      expect(sent()).toHaveBeenCalledTimes(1);
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();

      // 6d4112f3: crank + trade in one tx trips Custom(21); the trade goes alone.
      const txCall = sent().mock.calls[0][0];
      expect(txCall.instructions).toHaveLength(1);
      const tradeIx = txCall.instructions[0];
      expect(tradeIx.data[0]).toBe(10); // TradeCpi
      expect(tradeIx.data.length).toBe(V18_TRADE_CPI_LEN);
      // [2] taker portfolio, [3] LP portfolio, [4]/[5]/[6] the LP's matcher.
      expect(tradeIx.keys[2].pubkey.equals(mockTakerPortfolio)).toBe(true);
      expect(tradeIx.keys[3].pubkey.equals(mockLpPortfolio)).toBe(true);
      expect(tradeIx.keys[4].pubkey.equals(mockMatcherProg)).toBe(true);
      expect(tradeIx.keys[5].pubkey.equals(mockMatcherCtx)).toBe(true);
      expect(tradeIx.keys[6].pubkey.equals(mockMatcherDelegate)).toBe(true);
      // No separate crank either: the taker has no open legs.
      expect(sendTx).not.toHaveBeenCalled();
    });

    // 5c33e236 removed the dead "inline oracle push removed" throw: v18 AUTH_MARK
    // markets are priced by the keeper, so the authority wallet trades normally.
    it("#49: forwards onConfirming as the send's onProgress", async () => {
      const onConfirming = vi.fn();
      const { result } = renderHook(() => useTrade(mockSlabAddress));
      await act(async () => {
        await result.current.trade({ lpIdx: 0, userIdx: 1, size: 1000000n, onConfirming });
      });
      expect(sent()).toHaveBeenCalledWith(expect.objectContaining({ onProgress: onConfirming }));
    });

    it("lets the oracle-authority wallet trade on an admin market (no inline push)", async () => {
      mockSlabState.config.oracleAuthority = mockWalletPubkey;

      const { result } = renderHook(() => useTrade(mockSlabAddress));

      await act(async () => {
        await result.current.trade({
          lpIdx: 0,
          userIdx: 1,
          size: 1000000n,
        });
      });

      expect(sent()).toHaveBeenCalledTimes(1);
      const ixs = sent().mock.calls[0][0].instructions;
      expect(ixs.map((ix: { data: Uint8Array }) => ix.data[0])).toEqual([10]); // no PushOraclePrice (old tag 16)
      expect(result.current.error).toBeNull();
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

    it("legacy v12 slab (no v17 header): should throw error if LP not found", async () => {
      mockSlabState.raw = undefined;
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

      // The taker-portfolio read is best-effort (it only decides the separate crank):
      // a failing read must not abort the trade.
      expect(sent()).toHaveBeenCalled();
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

      // Admin mode: the slab is the oracle, so the self-heal catch-up carries no oracle tail.
      expect(sent()).toHaveBeenCalled();
      expect(sent().mock.calls[0][0].selfHeal?.catchUp?.oracleTail).toEqual([]);
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

      expect(sent()).toHaveBeenCalled();
      expect(sent().mock.calls[0][0].selfHeal?.catchUp?.oracleTail).toEqual([]);
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

      // Pyth-pinned: the Pyth push-oracle PDA rides as the catch-up oracle tail.
      expect(sent()).toHaveBeenCalled();
      const tail = sent().mock.calls[0][0].selfHeal?.catchUp?.oracleTail;
      expect(tail).toHaveLength(1);
      expect(tail?.[0]?.pubkey.equals(mockOraclePda)).toBe(true);
    });
  });

  describe("Loading State", () => {
    it("should set loading state during trade execution", async () => {
      let resolveSendTx: any;
      vi.mocked(sendTxWaiting).mockReturnValue(
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
        resolveSendTx("mock-sig");
      });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });
    });
  });

  describe("Slippage protection", () => {
    // v18 TradeCpi (deployed wrapper 553d76f0, tag-10 decode): tag ‖ a_id ‖ a_epoch ‖
    // b_id ‖ b_epoch ‖ b_matcher_seq (5×u64) ‖ asset u16 ‖ market_id u64 ‖ size i128 ‖
    // fee_bps u64 ‖ limit_price u64 ‖ backing_fee_cap_bps u16 = 85 bytes; limit @ 75.
    function decodeLimit(data: Uint8Array | Buffer): bigint {
      const buf = Buffer.from(data);
      expect(buf.length).toBe(V18_TRADE_CPI_LEN);
      return buf.readBigUInt64LE(V18_TRADE_CPI_LIMIT_OFF);
    }

    it("auto-computes a non-zero limit for a long when the caller omits limitPriceE6", async () => {
      const { result } = renderHook(() => useTrade(mockSlabAddress));
      await act(async () => {
        await result.current.trade({ lpIdx: 0, userIdx: 1, size: 1_000_000n });
      });
      const tx = sent().mock.calls[0][0] as {
        instructions: Array<{ data: Uint8Array }>;
      };
      const tradeIx = tx.instructions[tx.instructions.length - 1];
      const limit = decodeLimit(tradeIx.data);
      // BUG FIX (devnet flow-test 2026-07-01): DEFAULT_SLIPPAGE_BPS raised 100->500 (see
      // app/lib/slippage.ts doc comment — devnet-verified matcher skew asymmetry also hits
      // the long side once a market has real inventory skew, not just shorts).
      // mark = 1_500_000, default 500 bps → 1_500_000 * 10_500 / 10_000 = 1_575_000
      expect(limit).toBe(1_575_000n);
    });

    it("auto-computes a non-zero limit ≤ mark for a short (size < 0)", async () => {
      const { result } = renderHook(() => useTrade(mockSlabAddress));
      await act(async () => {
        await result.current.trade({ lpIdx: 0, userIdx: 1, size: -1_000_000n });
      });
      const tx = sent().mock.calls[0][0] as {
        instructions: Array<{ data: Uint8Array }>;
      };
      const limit = decodeLimit(tx.instructions[tx.instructions.length - 1].data);
      // mark = 1_500_000, default 500 bps (DEFAULT_SHORT_SLIPPAGE_BPS, unchanged by the
      // 2026-07-01 fix) → 1_500_000 * 9_500 / 10_000 = 1_425_000
      expect(limit).toBe(1_425_000n);
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
      const tx = sent().mock.calls[0][0] as {
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
      const tx = sent().mock.calls[0][0] as {
        instructions: Array<{ data: Uint8Array }>;
      };
      const limit = decodeLimit(tx.instructions[tx.instructions.length - 1].data);
      expect(limit).toBe(0n);
    });

    it("aborts the trade if the live mark price is null (no oracle yet)", async () => {
      const { getLivePriceSnapshot } = await import("@/lib/priceStore/priceStore");
      vi.mocked(getLivePriceSnapshot).mockReturnValueOnce({
        priceUsd: null,
        priceE6: null,
        price: null,
        change24h: null,
        high24h: null,
        low24h: null,
        loading: true,
      } as ReturnType<typeof getLivePriceSnapshot>);

      const { result } = renderHook(() => useTrade(mockSlabAddress));
      await act(async () => {
        await expect(
          result.current.trade({ lpIdx: 0, userIdx: 1, size: 1_000_000n }),
        ).rejects.toThrow(/mark price unavailable/i);
      });
      expect(sent()).not.toHaveBeenCalled();
      expect(sendTx).not.toHaveBeenCalled();
    });

    it("aborts the trade if the live mark price is 0n (broken oracle)", async () => {
      const { getLivePriceSnapshot } = await import("@/lib/priceStore/priceStore");
      vi.mocked(getLivePriceSnapshot).mockReturnValueOnce({
        priceUsd: 0,
        priceE6: 0n,
        price: 0,
        change24h: null,
        high24h: null,
        low24h: null,
        loading: false,
      } as ReturnType<typeof getLivePriceSnapshot>);

      const { result } = renderHook(() => useTrade(mockSlabAddress));
      await act(async () => {
        await expect(
          result.current.trade({ lpIdx: 0, userIdx: 1, size: 1_000_000n }),
        ).rejects.toThrow(/mark price unavailable/i);
      });
      expect(sent()).not.toHaveBeenCalled();
      expect(sendTx).not.toHaveBeenCalled();
    });

    it("never encodes the on-chain 0-sentinel by default", async () => {
      // Regression guard for the original bug: the trade ix must not be
      // encoded with limit_price_e6 = 0 when the caller didn't ask for that.
      const { result } = renderHook(() => useTrade(mockSlabAddress));
      await act(async () => {
        await result.current.trade({ lpIdx: 0, userIdx: 1, size: 1_000_000n });
      });
      const tx = sent().mock.calls[0][0] as {
        instructions: Array<{ data: Uint8Array }>;
      };
      const limit = decodeLimit(tx.instructions[tx.instructions.length - 1].data);
      expect(limit).not.toBe(0n);
    });
  });
});
