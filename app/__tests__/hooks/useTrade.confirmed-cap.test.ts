/**
 * Council r9 review MED-1 (hook level): an order that came through the confirm screen (`confirmedFeeCap`) signs EXACTLY the cap it was handed,
 * never the on-chain read (135 bps on v2.2), and a 98 / 9 refusal is surfaced, never answered with a raised cap or a second send.
 * Harness from useTrade.v22-only-121.test.ts; the REAL sendWithConfirmedFeeCap and buildTradeIxs run (buildTradeIxs is only spied).
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
  fetchTradeFeeBps: vi.fn(),
  signedFees: [] as Array<bigint | undefined>,
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
  fetchTradeFeeBps: mocks.fetchTradeFeeBps,
}));
vi.mock("@/lib/trade-ix", async (orig) => {
  const real = (await orig()) as typeof import("@/lib/trade-ix");
  return { ...real, buildTradeIxs: (p: Parameters<typeof real.buildTradeIxs>[0]) => { mocks.signedFees.push(p.feeBps); return real.buildTradeIxs(p); } };
});


import { useTrade } from "@/hooks/useTrade";
import { FeeChangedAfterReviewError } from "@/lib/limits/trade-fee-resolve";

const programId = new PublicKey(new Uint8Array(32).fill(12));
const walletPk = new PublicKey(new Uint8Array(32).fill(11));
const takerPortfolio = new PublicKey(new Uint8Array(32).fill(21));

function refusal(code: number): Error & { programId: string; code: number } {
  const e = new Error(`Transaction simulation failed: {"InstructionError":[2,{"Custom":${code}}]}`) as Error & { programId: string; code: number };
  e.programId = programId.toBase58();
  e.code = code;
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

const CHAIN_CAP = 135n; // what the live chain read returns (base 30 + worst-case matcher + 5)
const REVIEWED_CAP = 55n; // base 30 + 23 quote + 2 margin: what the confirm screen showed

describe("useTrade: a confirmed order signs the reviewed cap and refuses instead of raising it", () => {
  let seq = 90;
  let slabAddress = "";
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendTxWaiting.mockReset();
    mocks.signedFees.length = 0;
    mocks.fetchTradeFeeBps.mockReset();
    mocks.fetchTradeFeeBps.mockResolvedValue(CHAIN_CAP);
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
      accounts: [], raw: Buffer.from(market(0)), programId, wrapperConfigV17: { oracleMode: 0, tradeFeeBps: 30n }, refresh: vi.fn(), slabAddress,
    });
    __setDevnetV21ForTest(false);
    __setDevnetV22ForTest(true);
  });
  afterEach(() => { __setDevnetV21ForTest(null); __setDevnetV22ForTest(null); });

  async function runOrder(extra: { feeBps?: bigint; confirmedFeeCap?: boolean }): Promise<{ sig: string | null; err: unknown }> {
    observeLotExp(slabAddress, market(0));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { result, unmount } = renderHook(() => useTrade(slabAddress));
      let sig: string | null = null; let err: unknown = null;
      await act(async () => {
        const p = result.current.trade({ lpIdx: 0, userIdx: 0, size: 1_000_000n, ...extra }).then((s) => { sig = s as string; }, (e) => { err = e; });
        await vi.advanceTimersByTimeAsync(20_000);
        await p;
      });
      unmount();
      return { sig, err };
    } finally {
      vi.useRealTimers();
    }
  }

  it("confirmed: signs exactly the reviewed cap (55), not the chain read (135), and never raises", async () => {
    mocks.sendTxWaiting.mockResolvedValue("sig-ok");
    const { sig, err } = await runOrder({ feeBps: REVIEWED_CAP, confirmedFeeCap: true });
    expect(err).toBeNull();
    expect(sig).toBe("sig-ok");
    expect(mocks.signedFees).toEqual([REVIEWED_CAP]);
    expect(mocks.fetchTradeFeeBps).not.toHaveBeenCalled(); // the chain read is not consulted at all
  });
  it("control (no confirm screen): the live chain read is signed as before", async () => {
    mocks.sendTxWaiting.mockResolvedValue("sig-ok");
    await runOrder({ feeBps: REVIEWED_CAP });
    expect(mocks.signedFees).toEqual([CHAIN_CAP]);
  });
  it("confirmed + a 98: ONE send, no raised cap (no util-max read), the busy-side line", async () => {
    mocks.sendTxWaiting.mockRejectedValue(refusal(98));
    const { sig, err } = await runOrder({ feeBps: REVIEWED_CAP, confirmedFeeCap: true });
    expect(sig).toBeNull();
    expect(err).toBeInstanceOf(FeeChangedAfterReviewError);
    expect((err as Error).message).toBe("The busy-side fee changed while you were reviewing: it is now higher than the one you saw. Review it again. Nothing was charged.");
    expect(mocks.sendTxWaiting).toHaveBeenCalledTimes(1);
    expect(mocks.signedFees).toEqual([REVIEWED_CAP]);
    expect(mocks.fetchTradeFeeBps.mock.calls.some((c) => (c[3] as { withUtilMax?: boolean } | undefined)?.withUtilMax)).toBe(false);
  });
  it("confirmed + a 9: ONE send, the market maker's fee line", async () => {
    mocks.sendTxWaiting.mockRejectedValue(refusal(9));
    const { err } = await runOrder({ feeBps: REVIEWED_CAP, confirmedFeeCap: true });
    expect(err).toBeInstanceOf(FeeChangedAfterReviewError);
    expect((err as Error).message).toMatch(/^The market maker's fee changed while you were reviewing.*Nothing was charged\.$/);
    expect(mocks.sendTxWaiting).toHaveBeenCalledTimes(1);
  });
  it("control (no confirm screen) + a 98: the silent raise-and-retry stands (two sends, the second at the util-max cap)", async () => {
    mocks.fetchTradeFeeBps.mockImplementation(async (_c: unknown, _m: unknown, _x: unknown, o: { withUtilMax?: boolean }) => (o.withUtilMax ? 400n : CHAIN_CAP));
    mocks.sendTxWaiting.mockRejectedValueOnce(refusal(98)).mockResolvedValue("sig-raised");
    const { sig } = await runOrder({});
    expect(sig).toBe("sig-raised");
    expect(mocks.sendTxWaiting).toHaveBeenCalledTimes(2);
  });
});
