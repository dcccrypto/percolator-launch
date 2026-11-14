// @vitest-environment node
/**
 * Council round 2, trader / first-timer (low): the all-in cost, a quote beyond the per-side maximum, a market that cannot be
 * traded (no LP) reported without a retry loop, and an address that is not a market. Real SOL market + LP + matcher context bytes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, SystemProgram, type Connection } from "@solana/web3.js";

const lpState = vi.hoisted(() => ({ missing: false }));
vi.mock("@/lib/programAllowlist", () => ({ assertKnownProgram: () => undefined, isKnownProgram: (p: unknown) => String(p) === "5NGgnU2j315Ci2tso8VJDEthaVExuiKG3tn4xnur28xe" }));
vi.mock("@/lib/config", async (orig) => ({
  ...(await orig<typeof import("@/lib/config")>()),
  getMarketDiscoveryProgramIds: () => ["5NGgnU2j315Ci2tso8VJDEthaVExuiKG3tn4xnur28xe"],
  getAllProgramIds: () => ["5NGgnU2j315Ci2tso8VJDEthaVExuiKG3tn4xnur28xe"],
}));
vi.mock("@/lib/v22/trade-accounts", async (orig) => {
  const real = await orig<typeof import("@/lib/v22/trade-accounts")>();
  const f = await import("./fake-chain");
  return {
    ...real,
    resolveLpTradeAccounts: vi.fn(async () => {
      if (lpState.missing) throw new Error("no LP portfolio found for this market"); // the scan's own "no usable LP" wording
      return { accountB: f.LP, matcherProg: f.pk(5), matcherCtx: f.CTX, matcherDelegate: f.pk(6) };
    }),
  };
});

import { buildQuoteSource, quoteView, loadQuoteSource, expectedFee, matcherQuote, __clearQuoteCacheForTest } from "@/lib/bot-api/reads/quote";
import { loadMarket } from "@/lib/bot-api/reads/market-source";
import { buildOrder, buildClose } from "@/lib/bot-api/builders/order";
import { ApiError } from "@/lib/bot-api/errors";
import { __clearTradeBuildCacheForTest } from "@/lib/v22/trade-build";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { SOL, SOL_DATA, LP, LP_DATA, CTX, CTX_DATA, WRAPPER, SOL_SLOT, pk } from "./fake-chain";

const SIM = "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC";
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const raw = (b: Uint8Array | Buffer) => new Uint8Array(b);
const src = () => buildQuoteSource(raw(SOL_DATA), raw(CTX_DATA), raw(LP_DATA), LP, { market: SOL, programId: WRAPPER, slot: SOL_SLOT });
beforeEach(() => {
  __setDevnetV22ForTest(true);
  lpState.missing = false;
  __clearQuoteCacheForTest();
  __clearTradeBuildCacheForTest();
});
afterEach(() => __setDevnetV22ForTest(null));

const ceilBps = (exec: bigint, mark: bigint) => ((exec > mark ? exec - mark : mark - exec) * 10_000n + mark - 1n) / mark;

describe("trader-2: one all-in cost, the quoted spread counted once", () => {
  it("fee-channel market: expectedFee = base + requested (the spread), and the all-in cost is the same sum, not spread + expectedFee", () => {
    const q = quoteView(src(), 25_000n, 100);
    expect(q.feeChargedInPrice).toBe(true);
    const spread = ceilBps(q.estExecPriceE6!, q.effectivePriceE6);
    expect(q.allInCostBps).toBe(q.baseFeeBps + Number(spread));
    expect(q.expectedFeeBps).toBe(q.allInCostBps);
    expect(q.allInCostAtoms).toBe(q.expectedFeeAtoms);
    // the adaptive fee is inside totalSpreadBps: the all-in cost is NOT base + adaptive + totalSpread
    expect(q.allInCostBps!).toBeLessThan(q.baseFeeBps + q.matcher.adaptiveFeeBps! + q.totalSpreadBps! + 1);
    expect(q.allInCostBps!).toBeLessThanOrEqual(q.feeCapBps!);
  });
  it("fee channel off: the fee is the base fee alone; the all-in cost still adds the spread paid in the price (once)", () => {
    const s = { ...src(), feeInPrice: false };
    const m = matcherQuote(s, 25_000n)!;
    const f = expectedFee(s, m, 1_000_000n);
    const spread = Number(ceilBps(m.quotePriceE6!, s.effectivePriceE6));
    expect(f.bps).toBe(Number(s.baseFeeBps));
    expect(f.allInBps).toBe(Number(s.baseFeeBps) + spread);
    expect(f.allInAtoms).toBe((1_000_000n * BigInt(f.allInBps!) + 9_999n) / 10_000n);
  });
  it("a matcher with no exact quote has a fee but no all-in figure", () => {
    const s = src();
    const f = expectedFee(s, { ...matcherQuote(s, 25_000n)!, quotePriceE6: null }, 1_000_000n);
    expect(f.bps).toBe(Number(s.baseFeeBps));
    expect(f.allInBps).toBeNull();
  });
});

describe("a quote beyond maxSizePerSide is priced on the fillable size", () => {
  it("fee, impact and withinLimit are those of maxQ; exceedsMaxSize and fillableQ say so", () => {
    const s = src();
    const max = s.maxSizePerSide.long.maxQ;
    const capped = { ...s, maxSizePerSide: { ...s.maxSizePerSide, long: { ...s.maxSizePerSide.long, maxQ: 100_000n } } };
    const over = quoteView(capped, 10_000_000n, 100);
    const atMax = quoteView(capped, 100_000n, 100);
    expect(over.exceedsMaxSize).toBe(true);
    expect(over.fillableQ).toBe(100_000n);
    expect(over.expectedFeeAtoms).toBe(atMax.expectedFeeAtoms); // not the fee on 10,000,000 q
    expect(over.estExecPriceE6).toBe(atMax.estExecPriceE6);
    expect(over.withinLimit).toBe(atMax.withinLimit);
    expect(over.matcher.clipped).toBe(true);
    expect(over.notionalAtoms).toBeGreaterThan(atMax.notionalAtoms); // the request itself is still reported as asked
    void max;
  });
  it("a side with no room at all has no price, fee or limit check (null, not a number for an unfillable size)", () => {
    const s = src();
    const none = { ...s, maxSizePerSide: { ...s.maxSizePerSide, long: { ...s.maxSizePerSide.long, maxQ: 0n } } };
    const q = quoteView(none, 1_000n, 100);
    expect(q).toMatchObject({ exceedsMaxSize: true, estExecPriceE6: null, withinLimit: null, expectedFeeBps: null, expectedFeeAtoms: null, allInCostBps: null, fillableQ: 0n });
  });
  it("within the maximum nothing changes", () => {
    const q = quoteView(src(), 25_000n, 100);
    expect([q.exceedsMaxSize, q.fillableQ]).toEqual([false, 25_000n]);
  });
});

/** A market account whose collateral mint is `mint` and whose oracle is as old as `ageSecs` at the read slot. */
function market(mint: PublicKey | null): Uint8Array {
  const d = new Uint8Array(SOL_DATA);
  if (mint) {
    const at = Buffer.from(d).indexOf(Buffer.from(new PublicKey(SIM).toBytes()));
    d.set(mint.toBytes(), at);
  }
  return d;
}
/** The slot at which the fixture's oracle push is `ageSecs` older than at its own slot (400 ms slots). */
const slotFor = (ageSecs: number) => SOL_SLOT + Math.round((ageSecs * 1000) / 400);
const readConn = (m: Uint8Array, slot: number) =>
  ({
    getAccountInfoAndContext: async (k: PublicKey) => ({ context: { slot }, value: k.equals(SOL) ? { owner: WRAPPER, data: Buffer.from(m), lamports: 1, executable: false } : null }),
    getAccountInfo: async (k: PublicKey) => (k.equals(SOL) ? { owner: WRAPPER, data: Buffer.from(m), lamports: 1, executable: false } : k.equals(LP) ? { owner: WRAPPER, data: Buffer.from(LP_DATA), lamports: 1, executable: false } : null),
    getMultipleAccountsInfoAndContext: async () => ({ context: { slot }, value: [m, CTX_DATA, LP_DATA].map((data) => ({ data: Buffer.from(data), owner: WRAPPER, lamports: 1, executable: false })) }),
  }) as unknown as Connection;
const meta = () => ({ rpcCalls: 0, sims: 0 });
const err = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(ApiError);
  return e as ApiError;
};

describe("trader-4: a market that cannot be traded is not a retryable no_lp", () => {
  const fresh = SOL_SLOT; // the fixture is fresh at its own slot
  const stale = slotFor(10 * 24 * 3600);
  it("quote: wSOL collateral and a stale oracle with no LP -> market_unsupported, retryable false, with the reasons", async () => {
    lpState.missing = true;
    const e = await err(loadQuoteSource(readConn(market(WSOL), stale), meta(), SOL));
    expect([e.code, e.status, e.retryable]).toEqual(["market_unsupported", 422, false]);
    expect(e.extra.details).toMatchObject({ reason: "no_usable_lp", oracleStale: true, collateralSupported: false, collateralMint: WSOL.toBase58() });
    expect(e.message).toContain("stale");
    expect(e.message).toContain("will not change by retrying");
  });
  it("quote: a stale oracle alone, or unsupported collateral alone, with no LP is also final", async () => {
    lpState.missing = true;
    expect((await err(loadQuoteSource(readConn(market(null), stale), meta(), SOL))).code).toBe("market_unsupported");
    expect((await err(loadQuoteSource(readConn(market(WSOL), fresh), meta(), SOL))).extra.details).toMatchObject({ oracleStale: false, collateralSupported: false });
  });
  it("quote: a healthy market with no LP keeps the retryable no_lp (an LP may appear)", async () => {
    lpState.missing = true;
    const e = await err(loadQuoteSource(readConn(market(null), fresh), meta(), SOL));
    expect([e.code, e.retryable]).toEqual(["no_lp", true]);
  });
  it("order and close on the same dormant market: market_unsupported with the reason, not a retry loop", async () => {
    lpState.missing = true;
    const owner = Keypair.generate().publicKey;
    const c = readConn(market(WSOL), stale);
    const o = await err(buildOrder(c, { owner, market: SOL, size: 1_000n, portfolio: LP }, meta()));
    expect([o.code, o.retryable]).toEqual(["market_unsupported", false]);
    expect(o.extra.details).toMatchObject({ reason: "no_usable_lp" });
    const healthy = await err(buildOrder(readConn(market(null), fresh), { owner, market: SOL, size: 1_000n, portfolio: LP }, meta()));
    expect([healthy.code, healthy.retryable]).toEqual(["no_lp", true]);
    // a close needs an LP too: the same final answer, so a bot holding a position there is told why it cannot close through the API
    const cl = await err(buildClose(c, { owner: owner.toBase58(), market: SOL.toBase58(), portfolio: LP.toBase58() }, meta()));
    expect([cl.code, cl.retryable]).toEqual(["market_unsupported", false]);
  });
});

describe("first-timer: an address that is not a Percolator market is market_not_found", () => {
  const conn = (owner: PublicKey) => ({ getAccountInfoAndContext: async () => ({ context: { slot: 1 }, value: { owner, data: Buffer.alloc(0), lamports: 1, executable: true } }) }) as unknown as Parameters<typeof loadMarket>[0];
  it("the system program, a random program-owned account", async () => {
    for (const owner of [SystemProgram.programId, pk(8)]) {
      const e = await err(loadMarket(conn(owner), { rpcCalls: 0 }, SystemProgram.programId));
      expect([e.code, e.status]).toEqual(["market_not_found", 404]);
    }
  });
  it("a wrapper-owned account is still read", async () => {
    const r = await loadMarket(conn(WRAPPER), { rpcCalls: 0 }, SOL);
    expect(r.programId.equals(WRAPPER)).toBe(true);
  });
});
