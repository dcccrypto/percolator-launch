/**
 * v2.2 QA FUND-6 / E-121: the app's peer-refresh retry (the stale positioned peers' cranks added to the SAME transaction after a
 * Custom(121)) must run on a deployment that sets ONLY NEXT_PUBLIC_DEVNET_V22 (v2.2 builds on the v2.1 programs), and stay off with neither flag.
 * Harness copied from useTrade.v21-order-alone.test.ts; the refresh planner is mocked (its own planner suite: lib/v22/trade-refresh.test.ts).
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { __setDevnetV21ForTest } from "@/lib/v21/flag";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { __resetLotRegistryForTest, observeLotExp } from "@/lib/v22/lot-registry";
import { LAYOUT_V22, WRAPPER_ACCOUNT_MAGIC, ACCOUNT_KIND } from "@/lib/v22/sdk";

const mocks = vi.hoisted(() => ({
  planTradeRefresh: vi.fn(),
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

vi.mock("@/lib/owner-portfolio", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  findOwnerPortfolio: vi.fn(async () => new PublicKey(new Uint8Array(32).fill(21))),
}));
vi.mock("@/lib/v22/trade-refresh-wire", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  planTradeRefresh: mocks.planTradeRefresh,
}));
vi.mock("@/lib/v22/trade-refresh", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  marketAssetSlots: () => 1,
}));
vi.mock("@/lib/limits/trade-fee-resolve", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  fetchTradeFeeBps: vi.fn(async () => 30n),
  sendWithUtilFeeRetry: async (send: (raised: boolean) => Promise<string>) => send(false),
}));

import { useTrade } from "@/hooks/useTrade";

const programId = new PublicKey(new Uint8Array(32).fill(12));
const walletPk = new PublicKey(new Uint8Array(32).fill(11));
const takerPortfolio = new PublicKey(new Uint8Array(32).fill(21));
const peerCrankProgram = new PublicKey(new Uint8Array(32).fill(99));

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

describe("useTrade: the 121 peer-refresh retry follows the v2.2 flag too (FUND-6 / E-121)", () => {
  let seq = 60;
  let slabAddress = "";
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendTxWaiting.mockReset();
    mocks.planTradeRefresh.mockReset();
    slabAddress = new PublicKey(new Uint8Array(32).fill(seq++)).toBase58();
    __resetLotRegistryForTest();
    mocks.isV17Account.mockReturnValue(true);
    mocks.parsePortfolioV17.mockReturnValue({ owner: walletPk, legs: [{ active: true }] });
    mocks.deriveMatcherDelegate.mockReturnValue([new PublicKey(new Uint8Array(32).fill(17)), 254]);
    mocks.getLivePriceSnapshot.mockReturnValue({ priceUsd: 1, priceE6: 1_000_000n, price: 1, change24h: null, high24h: null, low24h: null, loading: false });
    mocks.simulateForGate.mockResolvedValue({ err: null, rpcFailed: false, logs: [], unitsConsumed: 300_000 });
    mocks.useConnectionCompat.mockReturnValue({ connection: { getProgramAccounts: vi.fn().mockResolvedValue([{ pubkey: takerPortfolio, account: { data: Buffer.from([1]) } }]), getAccountInfo: vi.fn().mockResolvedValue({ data: Buffer.alloc(64), owner: programId }) } });
    mocks.useWalletCompat.mockReturnValue({ publicKey: walletPk, connected: true });
    mocks.useSlabState.mockReturnValue({
      config: { oracleAuthority: PublicKey.default, indexFeedId: PublicKey.default, authorityPriceE6: 1_000_000n },
      accounts: [], raw: Buffer.from(market(0)), programId, wrapperConfigV17: { oracleMode: 0 }, refresh: vi.fn(), slabAddress,
    });
  });
  afterEach(() => { __setDevnetV21ForTest(null); __setDevnetV22ForTest(null); });

  const peerCrank = { programId: peerCrankProgram, keys: [], data: Buffer.from([5]) } as unknown as TransactionInstruction;
  async function runOrder(): Promise<{ sig: string | null; err: unknown }> {
    observeLotExp(slabAddress, market(0)); // only registers with the v2.2 flag on
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { result, unmount } = renderHook(() => useTrade(slabAddress));
      let sig: string | null = null; let err: unknown = null;
      await act(async () => {
        const p = result.current.trade({ lpIdx: 0, userIdx: 0, size: 1_000_000n }).then((s) => { sig = s as string; }, (e) => { err = e; });
        await vi.advanceTimersByTimeAsync(20_000);
        await p;
      });
      unmount();
      return { sig, err };
    } finally {
      vi.useRealTimers();
    }
  }

  it("only NEXT_PUBLIC_DEVNET_V22: a 121 is answered by one retry whose instruction list carries the stale peer's crank", async () => {
    __setDevnetV21ForTest(false);
    __setDevnetV22ForTest(true);
    mocks.planTradeRefresh.mockResolvedValue({ cranks: [{ role: "peer" }], instructions: [peerCrank, { programId, keys: [], data: Buffer.from([10]) } as unknown as TransactionInstruction] });
    mocks.sendTxWaiting.mockRejectedValueOnce(wrapperRefusal(121)).mockResolvedValue("sig-peer");
    const { sig, err } = await runOrder();
    expect(err).toBeNull();
    expect(sig).toBe("sig-peer");
    expect(mocks.planTradeRefresh).toHaveBeenCalledWith(expect.anything(), expect.anything(), { withPeers: true });
    const lists = mocks.sendTxWaiting.mock.calls.map((c) => (c[0] as { instructions: TransactionInstruction[] }).instructions);
    expect(lists[lists.length - 1].some((ix) => ix.programId.equals(peerCrankProgram))).toBe(true);
  });

  it("NEGATIVE CONTROL: neither flag -> a 121 is not retried and no peer crank is planned", async () => {
    __setDevnetV21ForTest(false);
    __setDevnetV22ForTest(false);
    mocks.sendTxWaiting.mockRejectedValue(wrapperRefusal(121));
    const { sig, err } = await runOrder();
    expect(sig).toBeNull();
    expect(String(err)).toMatch(/Custom":121/);
    expect(mocks.planTradeRefresh).not.toHaveBeenCalled();
    expect(mocks.sendTxWaiting).toHaveBeenCalledTimes(1);
  });
});
