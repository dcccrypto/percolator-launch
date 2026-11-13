/**
 * Delta review MED-A (hook level). An order that came through the confirm screen (`confirmedFeeCap` + `busyGuard`) signs the SAME chain cap
 * as before (the matcher fee is adaptive, one tighter cap would refuse honest orders), is never silently re-signed at a raised cap on a 98,
 * and has its busy-side rate re-read right before the wallet (`preSignCheck` on the send): higher than confirmed => refused, nothing signed.
 * Harness from useTrade.v22-only-121.test.ts; the REAL sendWithConfirmedFeeCap and guard run (sendTxWaiting is the mock: the test runs the
 * `preSignCheck` it was handed, exactly where lib/tx.ts sendTx runs it; that placement has its own test, tx-pre-sign-check.test.ts).
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
  fresh: vi.fn(),
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
vi.mock("@/lib/v22/fresh-busy-fee", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  readFreshBusyFeeBps: mocks.fresh,
}));
vi.mock("@/lib/trade-ix", async (orig) => {
  const real = (await orig()) as typeof import("@/lib/trade-ix");
  return { ...real, buildTradeIxs: (p: Parameters<typeof real.buildTradeIxs>[0]) => { mocks.signedFees.push(p.feeBps); return real.buildTradeIxs(p); } };
});


import { useTrade } from "@/hooks/useTrade";
import { FeeChangedAfterReviewError } from "@/lib/limits/trade-fee-resolve";
import { BusyFeeRoseError, BusyFeeUnreadableError } from "@/lib/v22/fresh-busy-fee";

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

const MARKET_MAX = 700n;
const CHAIN_CAP = 135n; // what the live chain read returns (base 30 + worst-case matcher + 5)
const GUARD = { confirmedBusyFeeBps: 99n, direction: "long" as const, takerEffQ: 0n, sizeQ: 1_000_000n };

describe("useTrade: a confirmed order signs the chain cap, never silently raises it, and re-reads the busy-side fee before signing", () => {
  let seq = 90;
  let slabAddress = "";
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendTxWaiting.mockReset();
    mocks.signedFees.length = 0;
    mocks.fetchTradeFeeBps.mockReset();
    // models resolveTradeFeeBps: base + worst-case matcher + margin (135), plus the confirmed busy rate when one is passed, capped at the market max
    mocks.fetchTradeFeeBps.mockImplementation(async (_c: unknown, _m: unknown, _x: unknown, o: { confirmedUtilFeeBps?: bigint }) => {
      const want = CHAIN_CAP + (o.confirmedUtilFeeBps ?? 0n);
      return want < MARKET_MAX ? want : MARKET_MAX;
    });
    mocks.fresh.mockReset();
    mocks.fresh.mockResolvedValue(99n);
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

  async function runOrder(extra: Record<string, unknown>): Promise<{ sig: string | null; err: unknown }> {
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
  const preSign = () => (mocks.sendTxWaiting.mock.calls[0][0] as { preSignCheck?: () => Promise<void> }).preSignCheck;

  it("recheck NEW-1: a confirmed order signs the chain cap PLUS the confirmed busy rate; no busy rate or no confirm screen = exactly the old 135", async () => {
    mocks.sendTxWaiting.mockResolvedValue("sig-ok");
    await runOrder({ confirmedFeeCap: true, busyGuard: { ...GUARD, confirmedBusyFeeBps: 0n } }); // non-busy confirmed order
    await runOrder({ feeBps: 55n }); // no confirm screen
    await runOrder({ confirmedFeeCap: true, busyGuard: GUARD }); // 99 bps busy
    await runOrder({ confirmedFeeCap: true, busyGuard: { ...GUARD, confirmedBusyFeeBps: 500n } });
    await runOrder({ confirmedFeeCap: true, busyGuard: { ...GUARD, confirmedBusyFeeBps: 5_000n } }); // above the market maximum
    expect(mocks.signedFees).toEqual([135n, 135n, 234n, 635n, MARKET_MAX]);
  });
  it("r9 LOW-3 (mutation M7): a busyGuard WITHOUT confirmedFeeCap forwards no confirmed busy rate (signs exactly 135) but is still guarded", async () => {
    mocks.sendTxWaiting.mockResolvedValue("sig-ok");
    await runOrder({ busyGuard: GUARD });
    expect(mocks.signedFees).toEqual([135n]);
    expect(mocks.fetchTradeFeeBps.mock.calls[0][3]).not.toHaveProperty("confirmedUtilFeeBps");
    expect(typeof preSign()).toBe("function");
  });
  it("a 500 bps confirmed busy quote with the rate unchanged lands: the signed cap covers it and the pre-sign read lets it through", async () => {
    mocks.sendTxWaiting.mockResolvedValue("sig-ok");
    mocks.fresh.mockResolvedValue(500n);
    const { sig, err } = await runOrder({ confirmedFeeCap: true, busyGuard: { ...GUARD, confirmedBusyFeeBps: 500n } });
    expect(err).toBeNull();
    expect(sig).toBe("sig-ok");
    expect(mocks.signedFees[0]! >= 30n + 100n + 500n).toBe(true); // base + worst-case matcher + busy: the wrapper's 98 check passes
    await expect(preSign()!()).resolves.toBeUndefined();
  });
  it("a rise above the confirmed 500 bps is refused before the wallet", async () => {
    mocks.sendTxWaiting.mockResolvedValue("sig-ok");
    await runOrder({ confirmedFeeCap: true, busyGuard: { ...GUARD, confirmedBusyFeeBps: 500n } });
    mocks.fresh.mockResolvedValue(501n);
    await expect(preSign()!()).rejects.toBeInstanceOf(BusyFeeRoseError);
  });
  it("f8-like drift (confirm showed 99 bps, the matcher moved 23 -> 30, busy unchanged): lands, not refused", async () => {
    mocks.sendTxWaiting.mockResolvedValue("sig-ok");
    mocks.fresh.mockResolvedValue(46n);
    const { err } = await runOrder({ confirmedFeeCap: true, busyGuard: { ...GUARD, confirmedBusyFeeBps: 46n } });
    expect(err).toBeNull();
    expect(mocks.signedFees[0]! >= 30n + 30n + 46n).toBe(true); // 106
    await expect(preSign()!()).resolves.toBeUndefined();
  });
  it("a confirmed order hands the send a preSignCheck; an unconfirmed one does not (closes etc. are unchanged)", async () => {
    mocks.sendTxWaiting.mockResolvedValue("sig-ok");
    await runOrder({ confirmedFeeCap: true, busyGuard: GUARD });
    expect(typeof preSign()).toBe("function");
    mocks.sendTxWaiting.mockClear();
    await runOrder({});
    expect(preSign()).toBeUndefined();
  });
  it("honest f8-like numbers (the matcher fee moved 23 -> 30 bps, the busy-side rate is unchanged): NOT refused", async () => {
    mocks.sendTxWaiting.mockResolvedValue("sig-ok");
    mocks.fresh.mockResolvedValue(99n);
    const { sig, err } = await runOrder({ confirmedFeeCap: true, busyGuard: GUARD });
    expect(err).toBeNull();
    expect(sig).toBe("sig-ok");
    await expect(preSign()!()).resolves.toBeUndefined();
  });
  it("the busy-side rate rose after the confirm: the check refuses (nothing can be signed), with the busy-side line", async () => {
    mocks.sendTxWaiting.mockResolvedValue("sig-ok");
    await runOrder({ confirmedFeeCap: true, busyGuard: GUARD });
    mocks.fresh.mockResolvedValue(106n);
    await expect(preSign()!()).rejects.toBeInstanceOf(BusyFeeRoseError);
    await expect(preSign()!()).rejects.toThrow("The busy-side fee rose to 1.06% while you were reviewing. Review it again. Nothing was sent.");
  });
  it("busy-side rate equal or lower: proceeds", async () => {
    mocks.sendTxWaiting.mockResolvedValue("sig-ok");
    await runOrder({ confirmedFeeCap: true, busyGuard: GUARD });
    for (const v of [99n, 50n, 0n]) {
      mocks.fresh.mockResolvedValue(v);
      await expect(preSign()!()).resolves.toBeUndefined();
    }
  });
  it("owner decision 3: unreadable (null, error) FAILS CLOSED from the real preSignCheck: BusyFeeUnreadableError, plain message", async () => {
    mocks.sendTxWaiting.mockResolvedValue("sig-ok");
    await runOrder({ confirmedFeeCap: true, busyGuard: GUARD });
    mocks.fresh.mockResolvedValue(null);
    await expect(preSign()!()).rejects.toBeInstanceOf(BusyFeeUnreadableError);
    mocks.fresh.mockRejectedValue(new Error("rpc down"));
    await expect(preSign()!()).rejects.toThrow("We couldn't check the busy-side fee right now, so we didn't send your order. Nothing was signed. Try again in a moment.");
  });
  it("owner decision 3: a confirmed order resolves its fee strictly (no fallback to the base fee); an unconfirmed one keeps the fallback", async () => {
    mocks.sendTxWaiting.mockResolvedValue("sig-ok");
    await runOrder({ confirmedFeeCap: true, busyGuard: GUARD });
    expect(mocks.fetchTradeFeeBps.mock.calls[0][3]).toMatchObject({ strict: true, fallbackIncludesBusy: false });
    await runOrder({ confirmedFeeCap: true, busyGuard: GUARD, feeBps: 200n });
    expect(mocks.fetchTradeFeeBps.mock.calls.at(-1)![3]).toMatchObject({ strict: true, fallbackIncludesBusy: true });
    await runOrder({});
    expect(mocks.fetchTradeFeeBps.mock.calls.at(-1)![3]).not.toHaveProperty("strict");
  });
  it("owner decision 3: the fee terms cannot be read (strict resolve throws): the order is refused before anything is built or sent", async () => {
    mocks.fetchTradeFeeBps.mockRejectedValue(new BusyFeeUnreadableError(new Error("rpc")));
    const { sig, err } = await runOrder({ confirmedFeeCap: true, busyGuard: GUARD });
    expect(sig).toBeNull();
    expect(err).toBeInstanceOf(BusyFeeUnreadableError);
    expect(mocks.sendTxWaiting).not.toHaveBeenCalled();
    expect(mocks.sendTx).not.toHaveBeenCalled();
  });
  it("the guard asks for THIS order: market, side and size", async () => {
    mocks.sendTxWaiting.mockResolvedValue("sig-ok");
    await runOrder({ confirmedFeeCap: true, busyGuard: { ...GUARD, direction: "short", sizeQ: 777n } });
    await preSign()!();
    expect(mocks.fresh.mock.calls.at(-1)![3]).toMatchObject({ direction: "short", sizeQ: 777n });
    expect((mocks.fresh.mock.calls.at(-1)![2] as PublicKey).toBase58()).toBe(slabAddress);
  });
  it("confirmed + a 98: ONE send, no raised cap (no util-max read); generic line when a fresh read shows no busy-side rise", async () => {
    mocks.sendTxWaiting.mockRejectedValue(refusal(98));
    const { sig, err } = await runOrder({ confirmedFeeCap: true, busyGuard: GUARD });
    expect(sig).toBeNull();
    expect(err).toBeInstanceOf(FeeChangedAfterReviewError);
    expect((err as Error).message).toBe("The fee changed while you were reviewing. Review it again. Nothing was charged.");
    expect(mocks.sendTxWaiting).toHaveBeenCalledTimes(1);
    expect(mocks.signedFees).toEqual([CHAIN_CAP + 99n]);
    expect(mocks.fetchTradeFeeBps.mock.calls.some((c) => (c[3] as { withUtilMax?: boolean } | undefined)?.withUtilMax)).toBe(false);
  });
  it("confirmed + a 98 and the fresh read shows the busy-side rate rose: the busy-side line", async () => {
    mocks.sendTxWaiting.mockRejectedValue(refusal(98));
    mocks.fresh.mockResolvedValue(130n);
    const { err } = await runOrder({ confirmedFeeCap: true, busyGuard: GUARD });
    expect(err).toBeInstanceOf(BusyFeeRoseError);
    expect(mocks.sendTxWaiting).toHaveBeenCalledTimes(1);
  });
  it("confirmed + a Custom 9: NOT remapped (the existing diagnosis runs on the original error)", async () => {
    const e9 = refusal(9);
    mocks.sendTxWaiting.mockRejectedValue(e9);
    const { err } = await runOrder({ confirmedFeeCap: true, busyGuard: GUARD });
    expect(err).toBe(e9);
    expect(err).not.toBeInstanceOf(FeeChangedAfterReviewError);
  });
  it("control (no confirm screen) + a 98: the silent raise-and-retry stands (two sends, the second at the util-max cap)", async () => {
    mocks.fetchTradeFeeBps.mockImplementation(async (_c: unknown, _m: unknown, _x: unknown, o: { withUtilMax?: boolean }) => (o.withUtilMax ? 400n : CHAIN_CAP));
    mocks.sendTxWaiting.mockRejectedValueOnce(refusal(98)).mockResolvedValue("sig-raised");
    const { sig } = await runOrder({});
    expect(sig).toBe("sig-raised");
    expect(mocks.sendTxWaiting).toHaveBeenCalledTimes(2);
  });
});
