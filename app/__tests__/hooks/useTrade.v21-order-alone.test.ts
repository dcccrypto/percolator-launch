/**
 * Devnet v2.1 (useTrade): an opening order is sent ALONE (compute budget aside, which sendTx adds),
 * with no push / crank / refresh prefix, and a Custom(121) EngineLossStale refusal is retried with
 * the SAME single-order instruction list while the ticket says "Refreshing positions…".
 * Harness: the portfolio-selection suite's mocks (LP resolver, v18 wire, oracle, price store).
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { __setDevnetV21ForTest } from "@/lib/v21/flag";

const mocks = vi.hoisted(() => ({
  useConnectionCompat: vi.fn(),
  useWalletCompat: vi.fn(),
  useSlabState: vi.fn(),
  sendTx: vi.fn(),
  sendTxWaiting: vi.fn(),
  simulateForGate: vi.fn(),
  isV17Account: vi.fn(),
  parsePortfolioV17: vi.fn(),
  deriveMatcherDelegate: vi.fn(),
  getLivePriceSnapshot: vi.fn(),
}));

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: mocks.useConnectionCompat,
  useWalletCompat: mocks.useWalletCompat,
}));

vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: mocks.useSlabState,
}));

vi.mock("@/lib/tx", () => ({
  sendTx: mocks.sendTx,
  sendTxWaiting: mocks.sendTxWaiting,
  prewarmTxLanding: vi.fn(),
  simulateForGate: mocks.simulateForGate,
  SimulationRefusal: class SimulationRefusal extends Error {},
  buildBatchTx: vi.fn(),
  signAllCompat: vi.fn(),
  broadcastSignedTx: vi.fn(),
  getPriorityFee: vi.fn(),
}));

vi.mock("@/lib/market-lp", () => ({
  resolveMarketLp: vi.fn(async () => ({
    pubkey: new PublicKey(new Uint8Array(32).fill(13)),
    data: new Uint8Array(0),
    owner: new PublicKey(new Uint8Array(32).fill(14)),
    portfolioId: 1n,
    matcherProg: new PublicKey(new Uint8Array(32).fill(15)),
    matcherCtx: new PublicKey(new Uint8Array(32).fill(16)),
    matcherDelegate: new PublicKey(new Uint8Array(32).fill(17)),
    reason: "asset-admin",
  })),
}));

vi.mock("@/lib/v18-wire", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  fetchPortfolioIdentity: vi.fn(async () => ({ portfolioId: 2n, matcherSequence: 0n, positionEpoch: 0n })),
  fetchAssetMarketId: vi.fn(async () => 1n),
}));

vi.mock("@/lib/programAllowlist", () => ({
  isKnownProgram: () => true,
  assertKnownProgram: () => {},
  // #2381: useTrade now pins the CPI matcher via assertCanonicalMatcher — stub it
  // (like assertKnownProgram) so this portfolio-selection test isn't coupled to the
  // canonical-matcher check (which has its own dedicated coverage).
  assertCanonicalMatcher: () => {},
}));

vi.mock("@/lib/oraclePrice", () => ({
  detectOracleMode: () => "admin",
  // GH#2525: useTrade now cross-checks the off-chain feed against the on-chain
  // price before deriving a slippage limit. Returning the same $1.00 the slab
  // fixture carries keeps this suite focused on portfolio selection instead of
  // tripping that guard.
  resolveMarketPriceE6: () => 1_000_000n,
}));

vi.mock("@/lib/priceStore/priceStore", () => ({
  getLivePriceSnapshot: mocks.getLivePriceSnapshot,
}));

vi.mock("@percolatorct/sdk", async () => {
  const actual =
    await vi.importActual<typeof import("@percolatorct/sdk")>(
      "@percolatorct/sdk",
    );

  return {
    ...actual,
    isV17Account: mocks.isV17Account,
    parsePortfolioV17: mocks.parsePortfolioV17,
    deriveMatcherDelegate: mocks.deriveMatcherDelegate,
  };
});

import { useTrade } from "@/hooks/useTrade";

const programId = new PublicKey(new Uint8Array(32).fill(12));
const walletPk = new PublicKey(new Uint8Array(32).fill(11));
const takerPortfolio = new PublicKey(new Uint8Array(32).fill(21));

/** lib/tx.ts SimulationRefusal shape: the wrapper's Custom(code) at instruction 2 (after the CU prefix). */
function wrapperRefusal(code: number): Error & { programId: string } {
  const e = new Error(`Transaction simulation failed: {"InstructionError":[2,{"Custom":${code}}]}`) as Error & { programId: string };
  e.programId = programId.toBase58();
  return e;
}

describe("useTrade, Devnet v2.1: the order goes alone; Custom(121) is retried, not bundled", () => {
  let slabSeq = 40;
  let slabAddress = "";

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendTxWaiting.mockReset();
    __setDevnetV21ForTest(true);
    // A fresh slab per test: useTrade caches resolved trade accounts per (program, slab, taker) for 60 s.
    slabAddress = new PublicKey(new Uint8Array(32).fill(slabSeq++)).toBase58();
    const connection = {
      // The taker's own owner+market scan finds one plain portfolio.
      getProgramAccounts: vi.fn().mockResolvedValue([{ pubkey: takerPortfolio, account: { data: Buffer.from([1]) } }]),
      // The taker HOLDS a position (an active leg): the old flow is where crank/refresh prefixes lived.
      getAccountInfo: vi.fn().mockResolvedValue({ data: Buffer.alloc(64), owner: programId }),
    };
    mocks.isV17Account.mockReturnValue(true);
    mocks.parsePortfolioV17.mockReturnValue({ owner: walletPk, legs: [{ active: true }] });
    mocks.deriveMatcherDelegate.mockReturnValue([new PublicKey(new Uint8Array(32).fill(17)), 254]);
    mocks.getLivePriceSnapshot.mockReturnValue({ priceUsd: 1, priceE6: 1_000_000n, price: 1, change24h: null, high24h: null, low24h: null, loading: false });
    // The order alone simulates clean for the taker-crank planner: no separate crank tx either.
    mocks.simulateForGate.mockResolvedValue({ err: null, rpcFailed: false, logs: [], unitsConsumed: 300_000 });
    mocks.useConnectionCompat.mockReturnValue({ connection });
    mocks.useWalletCompat.mockReturnValue({ publicKey: walletPk, connected: true });
    mocks.useSlabState.mockReturnValue({
      config: { oracleAuthority: PublicKey.default, indexFeedId: PublicKey.default, authorityPriceE6: 1_000_000n },
      accounts: [],
      raw: Buffer.from([1]),
      programId,
      wrapperConfigV17: { oracleMode: 0 },
      refresh: vi.fn(),
      slabAddress,
    });
  });
  afterEach(() => __setDevnetV21ForTest(null));

  const sentLists = (): TransactionInstruction[][] =>
    mocks.sendTxWaiting.mock.calls.map((c) => (c[0] as { instructions: TransactionInstruction[] }).instructions);

  function expectSingleOrder(ixs: TransactionInstruction[]): void {
    // Exactly ONE instruction: the TradeCpi (tag 10) on the wrapper. No push, no crank (tag 5),
    // no refreshes. The compute-budget ixs are added by sendTx itself, below this list.
    expect(ixs).toHaveLength(1);
    expect(ixs[0].programId.equals(programId)).toBe(true);
    expect(ixs[0].data[0]).toBe(10);
  }

  it("an opening order on a market with a positioned taker sends [order] alone", async () => {
    mocks.sendTxWaiting.mockResolvedValue("sig-1");
    const onRefreshingPositions = vi.fn();
    const { result, unmount } = renderHook(() => useTrade(slabAddress));
    await act(async () => {
      await result.current.trade({ lpIdx: 0, userIdx: 0, size: 1_000_000n, onRefreshingPositions });
    });
    expect(sentLists()).toHaveLength(1);
    expectSingleOrder(sentLists()[0]);
    // No separate prior crank / refresh transaction either.
    expect(mocks.sendTx).not.toHaveBeenCalled();
    expect(onRefreshingPositions).not.toHaveBeenCalled();
    unmount();
  });

  it("Custom(121): 'Refreshing positions' on, the SAME single order resent, then off when it lands", async () => {
    mocks.sendTxWaiting
      .mockRejectedValueOnce(wrapperRefusal(121))
      .mockRejectedValueOnce(wrapperRefusal(121))
      .mockResolvedValueOnce("sig-2");
    const onRefreshingPositions = vi.fn();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { result, unmount } = renderHook(() => useTrade(slabAddress));
      let sig: unknown;
      await act(async () => {
        const p = result.current.trade({ lpIdx: 0, userIdx: 0, size: 1_000_000n, onRefreshingPositions });
        await vi.advanceTimersByTimeAsync(10_000);
        sig = await p;
      });
      expect(sig).toBe("sig-2");
      expect(sentLists()).toHaveLength(3);
      for (const ixs of sentLists()) expectSingleOrder(ixs);
      expect(Array.from(sentLists()[1][0].data)).toEqual(Array.from(sentLists()[0][0].data));
      expect(onRefreshingPositions.mock.calls).toEqual([[true], [false]]);
      expect(mocks.sendTx).not.toHaveBeenCalled();
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("any other refusal is surfaced at once (no retry, no refreshing state)", async () => {
    mocks.sendTxWaiting.mockRejectedValue(wrapperRefusal(9));
    const onRefreshingPositions = vi.fn();
    const { result, unmount } = renderHook(() => useTrade(slabAddress));
    await act(async () => {
      await expect(result.current.trade({ lpIdx: 0, userIdx: 0, size: 1_000_000n, onRefreshingPositions })).rejects.toThrow(/"Custom":9/);
    });
    expect(sentLists()).toHaveLength(1);
    expect(onRefreshingPositions).not.toHaveBeenCalled();
    unmount();
  });

  it("flag off: a 121 is not retried (the live wrapper never raises it)", async () => {
    __setDevnetV21ForTest(false);
    mocks.sendTxWaiting.mockRejectedValue(wrapperRefusal(121));
    const { result, unmount } = renderHook(() => useTrade(slabAddress));
    await act(async () => {
      await expect(result.current.trade({ lpIdx: 0, userIdx: 0, size: 1_000_000n })).rejects.toThrow(/"Custom":121/);
    });
    expect(sentLists()).toHaveLength(1);
    unmount();
  });
});
