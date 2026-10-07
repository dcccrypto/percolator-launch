/**
 * (harness copied from useTrade.v21-order-alone.test.ts)
 * Devnet v2.1 (useTrade): an opening order is sent ALONE (compute budget aside, which sendTx adds),
 * with no push / crank / refresh prefix, and a Custom(121) EngineLossStale refusal is retried with
 * the SAME single-order instruction list while the ticket says "Refreshing positions…".
 * Harness: the portfolio-selection suite's mocks (LP resolver, v18 wire, oracle, price store).
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { __setDevnetV21ForTest } from "@/lib/v21/flag";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { __resetLotRegistryForTest, observeLotExp } from "@/lib/v22/lot-registry";
import { LAYOUT_V22, WRAPPER_ACCOUNT_MAGIC, ACCOUNT_KIND } from "@/lib/v22/sdk";

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


function market(lotExp: number): Uint8Array {
  const L = LAYOUT_V22;
  const d = new Uint8Array(L.marketGroupOff + L.marketGroupLen + L.assetSlotStride);
  const v = new DataView(d.buffer);
  v.setBigUint64(0, WRAPPER_ACCOUNT_MAGIC, true);
  v.setUint16(8, L.version, true);
  d[10] = ACCOUNT_KIND.Market;
  d[L.marketGroupOff + L.marketGroupLen + L.wrapperSlot.profileLotExp] = lotExp;
  return d;
}

describe("useTrade, v2.2 (review N1/N2): a market with lots, or with an unknown exponent, is refused before anything is built or sent", () => {
  let slabAddress = "";
  let seq = 90;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendTxWaiting.mockReset();
    __resetLotRegistryForTest();
    __setDevnetV21ForTest(true);
    __setDevnetV22ForTest(true);
    slabAddress = new PublicKey(new Uint8Array(32).fill(seq++)).toBase58();
    mocks.isV17Account.mockReturnValue(true);
    mocks.parsePortfolioV17.mockReturnValue({ owner: walletPk, legs: [{ active: true }] });
    mocks.deriveMatcherDelegate.mockReturnValue([new PublicKey(new Uint8Array(32).fill(17)), 254]);
    mocks.getLivePriceSnapshot.mockReturnValue({ priceUsd: 1, priceE6: 1_000_000n, price: 1, change24h: null, high24h: null, low24h: null, loading: false });
    mocks.simulateForGate.mockResolvedValue({ err: null, rpcFailed: false, logs: [], unitsConsumed: 300_000 });
    mocks.useConnectionCompat.mockReturnValue({ connection: { getProgramAccounts: vi.fn().mockResolvedValue([{ pubkey: takerPortfolio, account: { data: Buffer.from([1]) } }]), getAccountInfo: vi.fn().mockResolvedValue({ data: Buffer.alloc(64), owner: programId }) } });
    mocks.useWalletCompat.mockReturnValue({ publicKey: walletPk, connected: true });
    mocks.useSlabState.mockReturnValue({
      config: { oracleAuthority: PublicKey.default, indexFeedId: PublicKey.default, authorityPriceE6: 1_000_000n },
      accounts: [], raw: Buffer.from([1]), programId, wrapperConfigV17: { oracleMode: 0 }, refresh: vi.fn(), slabAddress,
    });
  });
  afterEach(() => {
    __setDevnetV21ForTest(null);
    __setDevnetV22ForTest(null);
  });

  it("lotExp 3 (known): refused with the calm line; nothing is sent; no limit is derived from the store price", async () => {
    observeLotExp(slabAddress, market(3));
    const { result, unmount } = renderHook(() => useTrade(slabAddress));
    await act(async () => {
      await expect(result.current.trade({ lpIdx: 0, userIdx: 0, size: 1_000_000n })).rejects.toThrow("Trading this market isn't available in the app yet.");
    });
    expect(mocks.sendTxWaiting).not.toHaveBeenCalled();
    expect(mocks.sendTx).not.toHaveBeenCalled();
    unmount();
  });

  it("unknown exponent (e.g. a close from a row whose market was never read): refused, nothing sent", async () => {
    const { result, unmount } = renderHook(() => useTrade(slabAddress));
    await act(async () => {
      await expect(result.current.trade({ lpIdx: 0, userIdx: 0, size: -1_000_000n })).rejects.toThrow("Checking this market's price. Try again in a moment.");
    });
    expect(mocks.sendTxWaiting).not.toHaveBeenCalled();
    unmount();
  });

  it("CONTROL: lotExp 0 (known): the guard does not refuse (whatever the rest of the harness does)", async () => {
    observeLotExp(slabAddress, market(0));
    mocks.sendTxWaiting.mockResolvedValue("sig");
    const { result, unmount } = renderHook(() => useTrade(slabAddress));
    let msg = "";
    await act(async () => {
      try {
        await result.current.trade({ lpIdx: 0, userIdx: 0, size: 1_000_000n });
      } catch (e) {
        msg = e instanceof Error ? e.message : String(e);
      }
    });
    expect(msg).not.toMatch(/isn't available in the app yet|Try again in a moment/);
    unmount();
  });

  it("CONTROL: flag off: no guard at all", async () => {
    __setDevnetV22ForTest(false);
    mocks.sendTxWaiting.mockResolvedValue("sig");
    const { result, unmount } = renderHook(() => useTrade(slabAddress));
    await act(async () => {
      await result.current.trade({ lpIdx: 0, userIdx: 0, size: 1_000_000n });
    });
    expect(mocks.sendTxWaiting).toHaveBeenCalledTimes(1);
    unmount();
  });
});
