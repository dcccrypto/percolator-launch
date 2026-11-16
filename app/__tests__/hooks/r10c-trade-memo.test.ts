/** Council r10 recheck D1: useTrade attaches the funding memo to an open from flat (and to nothing else). */
/**
 * Taker (accountA) portfolio selection in useTrade.
 *
 * 2026-10-02 (fix/preexisting-test-failures): since 18526d86 the LP side (accountB) is
 * resolved by on-chain identity in lib/market-lp.ts (its own suite, incl. a negative
 * control) — it reads the market + ctx accounts, which this suite never served, so the
 * resolver is stubbed here and the ONLY program scan left is the taker's owner scan.
 * The v17 trade is sent with sendTxWaiting (not sendTx) and binds both portfolios'
 * identity via lib/v18-wire (0d975d00) — stubbed as well. Since F-3 (fb7700c6) an
 * "LP-shaped" account must be a full portfolio (kind 2, 9,563 B) to count as an LP.
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";

const mocks = vi.hoisted(() => ({
  useConnectionCompat: vi.fn(),
  useWalletCompat: vi.fn(),
  useSlabState: vi.fn(),
  sendTx: vi.fn(),
  isV17Account: vi.fn(),
  parsePortfolioV17: vi.fn(),
  deriveMatcherDelegate: vi.fn(),
  getLivePriceSnapshot: vi.fn(),
  readBeforeTrade: vi.fn(async () => 5n),
  measurePositionChange: vi.fn(async () => ({ beforeQ: 5n, afterQ: 6n })),
  recordPositionChange: vi.fn(),
  before: { value: null as { q: bigint; funding: { netPaid: bigint; legs: number } | null } | null },
}));
// v2.2 on, single-asset market: the order takes the path that carries the funding memo.
// The 121 peer refresh: the order is rebuilt from its body with a peer crank in front (lib/v22/trade-refresh-wire.ts).
vi.mock("@/lib/v21/loss-stale-retry", async (orig) => ({ ...(await orig<typeof import("@/lib/v21/loss-stale-retry")>()), isLossStaleError: (e: unknown) => String(e).includes("LOSS_STALE_121"), lossStaleHandlingEnabled: () => false }));
vi.mock("@/lib/v22/trade-refresh-wire", async (orig) => ({
  ...(await orig<typeof import("@/lib/v22/trade-refresh-wire")>()),
  planTradeRefresh: async (_c: unknown, input: { body: import("@solana/web3.js").TransactionInstruction[] }) => ({ cranks: [{ role: "peer" }], instructions: [peerCrank, ...input.body] }),
  sendWithRefreshRetry: async (plan: () => Promise<import("@solana/web3.js").TransactionInstruction[]>, send: (ixs: import("@solana/web3.js").TransactionInstruction[]) => Promise<string>) => send(await plan()),
}));
const peerCrank = new (require("@solana/web3.js").TransactionInstruction)({ programId: new (require("@solana/web3.js").PublicKey)(new Uint8Array(32).fill(99)), keys: [], data: Buffer.from([1]) });
vi.mock("@/lib/v22/flag", async (orig) => ({ ...(await orig<typeof import("@/lib/v22/flag")>()), isDevnetV22Enabled: () => true }));
vi.mock("@/lib/v22/trade-refresh", async (orig) => ({ ...(await orig<typeof import("@/lib/v22/trade-refresh")>()), marketAssetSlots: () => 1 }));
vi.mock("@/lib/v22/lev-guard", async (orig) => ({ ...(await orig<typeof import("@/lib/v22/lev-guard")>()), levGuardExists: async () => false }));
vi.mock("@/lib/limits/trade-fee-resolve", async (orig) => ({ ...(await orig<typeof import("@/lib/limits/trade-fee-resolve")>()), fetchTradeFeeBps: async () => 135n }));

// #3314: the position measurement for the saved entry (lib/position-change.ts, tested on its own).
vi.mock("@/lib/position-change", () => ({
  readBeforeTrade: mocks.readBeforeTrade,
  // the pre-trade read with funding counters (none here: no memo), routed through the same mock
  readBeforeTradeFull: async () => mocks.before.value,
  measurePositionChange: mocks.measurePositionChange,
  recordPositionChange: mocks.recordPositionChange,
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
  sendTxWaiting: mocks.sendTx,
  prewarmTxLanding: vi.fn(),
  simulateForGate: vi.fn(),
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

vi.mock("@/lib/v22/layout", async (orig) => ({
  ...(await orig<typeof import("@/lib/v22/layout")>()),
  isWrapperAccount: mocks.isV17Account,
  parsePortfolio: mocks.parsePortfolioV17,
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
import { __setUnknownLotExpForTest } from "@/lib/v22/lot-registry";
import { MEMO_PROGRAM_ID } from "@/lib/funding-memo";

describe("useTrade: funding memo", () => {
  const slabAddress = "11111111111111111111111111111111";
  const walletPk = new PublicKey(new Uint8Array(32).fill(11));
  const programId = new PublicKey(new Uint8Array(32).fill(12));
  const portfolio = new PublicKey(new Uint8Array(32).fill(21));
  let connection: { getProgramAccounts: ReturnType<typeof vi.fn>; getAccountInfo: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    __setUnknownLotExpForTest(0);
    vi.clearAllMocks();
    connection = { getProgramAccounts: vi.fn(), getAccountInfo: vi.fn().mockResolvedValue(null) };
    mocks.isV17Account.mockReturnValue(true);
    mocks.parsePortfolioV17.mockReturnValue({ owner: walletPk, legs: [] });
    mocks.deriveMatcherDelegate.mockReturnValue([new PublicKey(new Uint8Array(32).fill(17)), 254]);
    mocks.getLivePriceSnapshot.mockReturnValue({ priceUsd: 1.0, priceE6: 1_000_000n, price: 1.0, change24h: null, high24h: null, low24h: null, loading: false });
    mocks.sendTx.mockResolvedValue("sig-open");
    mocks.useConnectionCompat.mockReturnValue({ connection });
    mocks.useWalletCompat.mockReturnValue({ publicKey: walletPk, connected: true });
    mocks.useSlabState.mockReturnValue({
      config: { oracleAuthority: PublicKey.default, indexFeedId: PublicKey.default, authorityPriceE6: 1_000_000n },
      accounts: [], raw: Buffer.from([1]), programId, wrapperConfigV17: { oracleMode: 0 }, refresh: vi.fn(), slabAddress,
    });
  });

  async function sentMemos(): Promise<string[]> {
    connection.getProgramAccounts.mockResolvedValueOnce([{ pubkey: portfolio, account: { data: Buffer.from([1]) } }]);
    const { result, unmount } = renderHook(() => useTrade(slabAddress));
    await act(async () => {
      await result.current.trade({ lpIdx: 0, userIdx: 7, size: 1_000_000n });
    });
    unmount();
    const ixs = (mocks.sendTx.mock.calls.at(-1)?.[0] as { instructions: TransactionInstruction[] }).instructions;
    return ixs.filter((ix) => ix.programId.equals(MEMO_PROGRAM_ID)).map((ix) => Buffer.from(ix.data).toString("utf8"));
  }

  it("an open from flat with no active leg carries perc:fb1:<counter>", async () => {
    mocks.before.value = { q: 0n, funding: { netPaid: 419_035n, legs: 0 } };
    expect(await sentMemos()).toEqual(["perc:fb1:419035"]);
    // first in the body: the multi-asset refresh reads the trade as the last instruction
    const ixs = (mocks.sendTx.mock.calls.at(-1)?.[0] as { instructions: TransactionInstruction[] }).instructions;
    expect(ixs[0].programId.equals(MEMO_PROGRAM_ID)).toBe(true);
  });
  it("an add, a portfolio holding another leg, or an unread one: no memo", async () => {
    mocks.before.value = { q: 5n, funding: { netPaid: 1n, legs: 1 } };
    expect(await sentMemos()).toEqual([]);
    mocks.before.value = { q: 0n, funding: { netPaid: 1n, legs: 1 } };
    expect(await sentMemos()).toEqual([]);
    mocks.before.value = null;
    expect(await sentMemos()).toEqual([]);
  });
  it("refused 121 first: the rebuilt order (peer crank + body) still carries the memo", async () => {
    mocks.before.value = { q: 0n, funding: { netPaid: 442_997n, legs: 0 } };
    connection.getProgramAccounts.mockResolvedValueOnce([{ pubkey: portfolio, account: { data: Buffer.from([1]) } }]);
    mocks.sendTx.mockReset();
    mocks.sendTx.mockRejectedValueOnce(new Error("LOSS_STALE_121")).mockResolvedValueOnce("sig-refreshed");
    const { result, unmount } = renderHook(() => useTrade(slabAddress));
    await act(async () => {
      await result.current.trade({ lpIdx: 0, userIdx: 7, size: 1_000_000n });
    });
    unmount();
    expect(mocks.sendTx).toHaveBeenCalledTimes(2);
    const ixs = (mocks.sendTx.mock.calls[1][0] as { instructions: TransactionInstruction[] }).instructions;
    expect(ixs.filter((ix) => ix.programId.equals(MEMO_PROGRAM_ID)).map((ix) => Buffer.from(ix.data).toString("utf8"))).toEqual(["perc:fb1:442997"]);
  });
});
