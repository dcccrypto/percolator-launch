/**
 * #2560: useClosePosition's explicit portfolio target and the isolated rent reclaim, as BEHAVIOUR
 * (replaces the source-grep reclaim test of the first PR, and covers what #3137 never tested):
 *  - the opts object: { skipSweep?, portfolioPk?, reclaimOnClose? } (v2.1 #3148 adds skipSweep; the
 *    shapes compose, a call with only { skipSweep } behaves exactly as there);
 *  - the freshness read hits EXACTLY the target, and refuses an account that is not the program's,
 *    this wallet's and this market's;
 *  - the RebalanceReduce route, the matcher trade and the post-close sweep withdraw all get the target;
 *  - the isolated rent reclaim runs for a full close when asked (also when capital is 0, i.e. a
 *    fully lost position), says so BEFORE the extra wallet prompt, is best-effort, and never
 *    runs for a cross account or after a declined sweep.
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MARKET_BYTES = Buffer.from(
  JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "5bVTTMRc.ansem.market.json"), "utf8")).dataBase64,
  "base64",
);
// F-3: the same market with a_short = 0.8617 * ADL_ONE => the engine is reduce-only => close routes to tag 44.
const ENGINE = 592 + 758 + 1024;
const ADL_ONE = 1_000_000_000_000_000n;
function withAShort(d: Uint8Array, aShort: bigint) {
  const out = new Uint8Array(d); // a COPY (Buffer#slice would be a view onto the shared fixture)
  const v = new DataView(out.buffer);
  v.setBigUint64(ENGINE + 65, aShort & 0xffff_ffff_ffff_ffffn, true);
  v.setBigUint64(ENGINE + 65 + 8, aShort >> 64n, true);
  return out;
}
const F3_MARKET = Buffer.from(withAShort(MARKET_BYTES, (ADL_ONE * 8617n) / 10_000n));

const mocks = vi.hoisted(() => ({
  trade: vi.fn(),
  rebalance: vi.fn(),
  parsePortfolioV17: vi.fn(),
  getProgramAccounts: vi.fn(),
  getAccountInfo: vi.fn(),
  findV17Portfolio: vi.fn(),
  withdraw: vi.fn(),
  sendTx: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/hooks/useWalletCompat", () => ({ useConnectionCompat: vi.fn(), useWalletCompat: vi.fn() }));
vi.mock("@/hooks/useTrade", () => ({
  useTrade: vi.fn(),
  prewarmTradeSubmission: vi.fn(),
  findV17Portfolio: (...a: unknown[]) => mocks.findV17Portfolio(...a),
}));
vi.mock("@/hooks/useWithdraw", () => ({ useWithdraw: () => ({ withdraw: mocks.withdraw }) }));
vi.mock("@/hooks/useToast", () => ({ useOptionalToast: () => mocks.toast }));
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: vi.fn() }));
vi.mock("@/hooks/useMarketHealth", () => ({ useSingleMarketHealth: () => null }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: vi.fn() }));
vi.mock("@/lib/priceStore/priceStore", () => ({ getLivePriceSnapshot: () => ({ priceE6: 100_000_000n }) }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false }));
vi.mock("@/lib/lpPortfolio", () => ({ isLpPortfolio: () => false }));
vi.mock("@/lib/portfolio-invalidation", () => ({ invalidatePortfolio: vi.fn() }));
vi.mock("@/lib/matcherCaps", () => ({ getMatcherCaps: vi.fn(async () => null), getLpInventoryState: vi.fn(async () => null) }));
vi.mock("@/lib/limits/rebalance-close", () => ({ closeViaRebalanceReduce: (p: unknown) => mocks.rebalance(p) }));
vi.mock("@/lib/tx", async (orig) => ({ ...(await orig<typeof import("@/lib/tx")>()), sendTx: (...a: unknown[]) => mocks.sendTx(...a) }));
vi.mock("@/lib/errorMessages", async (orig) => ({
  ...(await orig<typeof import("@/lib/errorMessages")>()),
  withTransientRetry: async (op: () => Promise<unknown>) => op(),
}));
vi.mock("@percolatorct/sdk", async (orig) => ({
  ...(await orig<typeof import("@percolatorct/sdk")>()),
  isV17Account: () => true,
  parsePortfolioV17: mocks.parsePortfolioV17,
}));

import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { useTrade } from "@/hooks/useTrade";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useClosePosition } from "@/hooks/useClosePosition";
import { RECLAIM_COPY, SWEEP_COPY } from "@/lib/close-sweep";
import { formatTokenAmount } from "@/lib/format";

const SLAB = new PublicKey(new Uint8Array(32).fill(33));
const SLAB_STR = SLAB.toBase58();
const WALLET = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
const PROGRAM = new PublicKey("5BZWY6XWPxuWFxs2nPCLLsVaKRWZVnzZh3FkJDLJBkJf");
const OTHER_PROGRAM = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const TARGET = Keypair.generate().publicKey; // the isolated portfolio
const PRIMARY = Keypair.generate().publicKey; // the cross portfolio
// v18 anti-replay identity the tag-8 wire binds (read via readPortfolioIdentity)
const IDENTITY = { portfolioId: 42n, matcherSequence: 7n, matcherPositionEpoch: 1n };
const openLeg = { active: true, side: 0, aBasis: 1_000_000_000_000_000n, epochSnap: 0n, basisPosQ: 2n };

let closed = false;
let postCloseCapital = 487_250_000n;
let slabRaw: Buffer = MARKET_BYTES;
let chainMarket: Buffer = MARKET_BYTES;
let targetInfoOwner: PublicKey = PROGRAM;
let parsedOwner: PublicKey = WALLET;
let parsedMarket: PublicKey = SLAB;

beforeEach(() => {
  vi.clearAllMocks();
  closed = false;
  postCloseCapital = 487_250_000n;
  slabRaw = MARKET_BYTES;
  chainMarket = MARKET_BYTES;
  targetInfoOwner = PROGRAM;
  parsedOwner = WALLET;
  parsedMarket = SLAB;
  mocks.trade.mockImplementation(async () => { closed = true; return "close-sig"; });
  mocks.rebalance.mockImplementation(async () => { closed = true; return { signature: "SIG44", fill: { kind: "full", filledQ: -2n } }; });
  // a successful sweep empties the account
  mocks.withdraw.mockImplementation(async () => { postCloseCapital = 0n; return "withdraw-sig"; });
  mocks.sendTx.mockResolvedValue({ signature: "reclaim-sig" });
  mocks.findV17Portfolio.mockResolvedValue(PRIMARY);
  mocks.getProgramAccounts.mockResolvedValue([{ pubkey: PRIMARY, account: { data: Buffer.alloc(9563) } }]);
  mocks.getAccountInfo.mockImplementation(async (pk: PublicKey) =>
    pk.equals(SLAB) ? { owner: PROGRAM, data: chainMarket } : { owner: pk.equals(TARGET) ? targetInfoOwner : PROGRAM, data: Buffer.alloc(9563) },
  );
  mocks.parsePortfolioV17.mockImplementation(() =>
    closed
      ? { owner: parsedOwner, marketGroupId: parsedMarket, capital: postCloseCapital, legs: [{ ...openLeg, active: false }], ...IDENTITY }
      : { owner: parsedOwner, marketGroupId: parsedMarket, capital: 500_000_000n, legs: [openLeg], ...IDENTITY },
  );
  vi.mocked(useConnectionCompat).mockReturnValue({
    connection: { getProgramAccounts: mocks.getProgramAccounts, getAccountInfo: mocks.getAccountInfo },
  } as unknown as ReturnType<typeof useConnectionCompat>);
  vi.mocked(useWalletCompat).mockReturnValue({ publicKey: WALLET, connected: true } as ReturnType<typeof useWalletCompat>);
  vi.mocked(useTrade).mockReturnValue({ trade: mocks.trade } as unknown as ReturnType<typeof useTrade>);
  vi.mocked(useUserAccount).mockReturnValue({ idx: 7, account: { positionSize: 2n } } as ReturnType<typeof useUserAccount>);
  vi.mocked(useSlabState).mockImplementation(() => ({
    accounts: [{ idx: 3, account: { kind: "LP" } }], raw: slabRaw, programId: PROGRAM, config: null, wrapperConfigV17: null,
  }) as unknown as ReturnType<typeof useSlabState>);
});

async function close(percent: number, opts?: Parameters<ReturnType<typeof useClosePosition>["closePosition"]>[1]) {
  const { result } = renderHook(() => useClosePosition(SLAB_STR));
  let thrown: unknown = null;
  let r: unknown;
  await act(async () => {
    try {
      r = await result.current.closePosition(percent, opts);
    } catch (e) {
      thrown = e;
    }
  });
  return { r, thrown, result };
}

const reclaimCalls = () => mocks.sendTx.mock.calls.map((c) => c[0] as { instructions: { keys: { pubkey: PublicKey }[]; data: Buffer }[]; simulateBeforeSign?: boolean });

describe("explicit target: every resolution point acts on EXACTLY that portfolio", () => {
  it("the fresh read, the matcher trade and the post-close sweep withdraw all get the target; no owner scan", async () => {
    const { r } = await close(100, { portfolioPk: TARGET });
    expect((r as { signature: string }).signature).toBe("close-sig");
    expect(mocks.getAccountInfo).toHaveBeenCalledWith(TARGET, "confirmed");
    expect(mocks.getProgramAccounts).not.toHaveBeenCalled(); // never fell back to the wallet-wide scan
    expect(mocks.trade.mock.calls[0][0].portfolioPk.equals(TARGET)).toBe(true);
    await vi.waitFor(() => expect(mocks.withdraw).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const w = mocks.withdraw.mock.calls[0][0];
    expect(w.amount).toBe(487_250_000n);
    expect(w.portfolioPk.equals(TARGET)).toBe(true);
  });

  it("the RebalanceReduce (tag 44) route closes the target, never the primary", async () => {
    slabRaw = F3_MARKET;
    chainMarket = F3_MARKET;
    const { r } = await close(100, { portfolioPk: TARGET });
    expect(mocks.trade).not.toHaveBeenCalled();
    expect(mocks.rebalance).toHaveBeenCalledTimes(1);
    expect((mocks.rebalance.mock.calls[0][0].portfolio as PublicKey).equals(TARGET)).toBe(true);
    expect(mocks.findV17Portfolio).not.toHaveBeenCalled(); // did not resolve a different pick
    expect((r as { signature: string }).signature).toBe("SIG44");
  });

  it("CONTROL: with no target it resolves the primary exactly as before (scan, no portfolioPk on the trade)", async () => {
    mocks.getAccountInfo.mockImplementation(async () => ({ owner: PROGRAM, data: chainMarket }));
    await close(100);
    expect(mocks.getProgramAccounts).toHaveBeenCalled();
    expect(mocks.trade.mock.calls[0][0].portfolioPk).toBeUndefined();
    await vi.waitFor(() => expect(mocks.withdraw).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(mocks.withdraw.mock.calls[0][0].portfolioPk).toBeUndefined();
  });

  const refusals: [string, () => void][] = [
    ["owned by another program", () => { targetInfoOwner = OTHER_PROGRAM; }],
    ["a portfolio of another market", () => { parsedMarket = new PublicKey(new Uint8Array(32).fill(99)); }],
    ["a portfolio of another wallet", () => { parsedOwner = new PublicKey(new Uint8Array(32).fill(7)); }],
  ];
  for (const [name, arrange] of refusals) {
    it(`REFUSES a target that is ${name}: nothing is closed`, async () => {
      arrange();
      const { thrown } = await close(100, { portfolioPk: TARGET });
      expect(thrown).toBeInstanceOf(Error);
      expect(mocks.trade).not.toHaveBeenCalled();
      expect(mocks.rebalance).not.toHaveBeenCalled();
      expect(mocks.withdraw).not.toHaveBeenCalled();
    });
  }
});

describe("a prewarmed read of the target is spent by the close (no stale pre-close size)", () => {
  it("a second close of the same isolated position re-reads the chain instead of reusing the first read", async () => {
    const targetReads = () => mocks.getAccountInfo.mock.calls.filter((c) => (c[0] as PublicKey).equals(TARGET)).length;
    await close(50, { portfolioPk: TARGET });
    const afterFirst = targetReads();
    expect(afterFirst).toBeGreaterThanOrEqual(1);
    await close(50, { portfolioPk: TARGET }); // well inside the 4 s read TTL
    expect(targetReads()).toBeGreaterThan(afterFirst);
  });
});

describe("opts object composes with the v2.1 Move flow's { skipSweep }", () => {
  it("{ skipSweep } alone (the #3148 call shape): closes the default account and never sweeps", async () => {
    mocks.getAccountInfo.mockImplementation(async () => ({ owner: PROGRAM, data: chainMarket }));
    const { r } = await close(100, { skipSweep: true });
    expect((r as { signature: string }).signature).toBe("close-sig");
    await new Promise((res) => setTimeout(res, 150));
    expect(mocks.withdraw).not.toHaveBeenCalled();
    expect(mocks.sendTx).not.toHaveBeenCalled();
  });

  it("{ skipSweep, portfolioPk }: closes the target, still no sweep and no reclaim unless asked", async () => {
    await close(100, { skipSweep: true, portfolioPk: TARGET });
    await new Promise((res) => setTimeout(res, 150));
    expect(mocks.trade.mock.calls[0][0].portfolioPk.equals(TARGET)).toBe(true);
    expect(mocks.withdraw).not.toHaveBeenCalled();
    expect(mocks.sendTx).not.toHaveBeenCalled();
  });
});

describe("isolated rent reclaim (tag 8 ClosePortfolio)", () => {
  const label = `${formatTokenAmount(487_250_000n, 6, 2)} USDC`;

  it("after the sweep, sends ONE sim-gated tag-8 tx for the isolated portfolio, announced BEFORE the wallet opens", async () => {
    await close(100, { portfolioPk: TARGET, reclaimOnClose: true });
    await vi.waitFor(() => expect(mocks.sendTx).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const call = reclaimCalls()[0];
    expect(call.simulateBeforeSign).toBe(true);
    expect(call.instructions).toHaveLength(1);
    const ix = call.instructions[0];
    expect(ix.data[0]).toBe(8); // tag 8
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([WALLET.toBase58(), SLAB_STR, TARGET.toBase58()]); // [closer, market, portfolio]
    expect(mocks.toast).toHaveBeenCalledWith(SWEEP_COPY.prompt(label), "info");
    expect(mocks.toast).toHaveBeenCalledWith(RECLAIM_COPY.prompt, "info");
    // the user is told before the extra prompt: the toast precedes the send
    const told = mocks.toast.mock.invocationCallOrder[mocks.toast.mock.calls.findIndex((c) => c[0] === RECLAIM_COPY.prompt)];
    expect(told).toBeLessThan(mocks.sendTx.mock.invocationCallOrder[0]);
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(RECLAIM_COPY.done, "success"));
  });

  it("a fully LOST position (capital 0, nothing to sweep) is still reclaimed, and the user is told first", async () => {
    postCloseCapital = 0n;
    await close(100, { portfolioPk: TARGET, reclaimOnClose: true });
    await vi.waitFor(() => expect(mocks.sendTx).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(mocks.withdraw).not.toHaveBeenCalled(); // nothing to move back
    expect(reclaimCalls()[0].instructions[0].data[0]).toBe(8);
    expect(mocks.toast).toHaveBeenCalledWith(RECLAIM_COPY.prompt, "info");
  });

  it("CONTROL: without reclaimOnClose (a cross account) nothing is ever reclaimed, even at capital 0", async () => {
    postCloseCapital = 0n;
    await close(100, { portfolioPk: TARGET });
    await new Promise((res) => setTimeout(res, 200));
    expect(mocks.sendTx).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalledWith(RECLAIM_COPY.prompt, "info");
  });

  it("CONTROL: a partial close never reclaims", async () => {
    await close(50, { portfolioPk: TARGET, reclaimOnClose: true });
    await new Promise((res) => setTimeout(res, 200));
    expect(mocks.sendTx).not.toHaveBeenCalled();
  });

  it("a declined sweep leaves the capital on the account: no reclaim, no second prompt", async () => {
    mocks.withdraw.mockRejectedValue(new Error("User rejected the request."));
    await close(100, { portfolioPk: TARGET, reclaimOnClose: true });
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(SWEEP_COPY.kept(label), "info"), { timeout: 3000 });
    await new Promise((res) => setTimeout(res, 100));
    expect(mocks.sendTx).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalledWith(RECLAIM_COPY.prompt, "info");
  });

  it("a declined / failed reclaim never fails the completed close (it is said to stay open)", async () => {
    mocks.sendTx.mockRejectedValue(new Error("User rejected the request."));
    const { r, thrown, result } = await close(100, { portfolioPk: TARGET, reclaimOnClose: true });
    expect(thrown).toBeNull();
    expect((r as { signature: string }).signature).toBe("close-sig");
    expect(result.current.error).toBeNull();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(RECLAIM_COPY.kept, "info"), { timeout: 3000 });
  });

  it("never reclaims an account this wallet does not own, even if asked", async () => {
    // after the close the account reads as someone else's
    mocks.parsePortfolioV17.mockImplementation(() =>
      closed
        ? { owner: new PublicKey(new Uint8Array(32).fill(7)), marketGroupId: SLAB, capital: 0n, legs: [{ ...openLeg, active: false }] }
        : { owner: WALLET, marketGroupId: SLAB, capital: 500_000_000n, legs: [openLeg] },
    );
    await close(100, { portfolioPk: TARGET, reclaimOnClose: true });
    await new Promise((res) => setTimeout(res, 200));
    expect(mocks.sendTx).not.toHaveBeenCalled();
  });
});
