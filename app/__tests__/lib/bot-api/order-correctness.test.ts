// @vitest-environment node
/**
 * Council round 2, money-path correctness:
 *  - risk-3: the order summary carries the ADL-effective position and the reducing flag the caps used (rawBasisQ kept apart);
 *  - trader-1: a slippage below the matcher's estimated fill is refused up front, with the number that would pass;
 *  - first-timer-6: a nonexistent or wrong `portfolio` is bad_portfolio (400), not a retryable rpc_unavailable.
 * Real SOL market + LP portfolio + matcher context bytes; the real caps, the real shared builder (for bad_portfolio).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, SystemProgram, Transaction, type Connection, type PublicKey } from "@solana/web3.js";

const boundary = vi.hoisted(() => ({ market: null as Uint8Array | null, calls: 0 }));
vi.mock("@/lib/programAllowlist", () => ({ assertKnownProgram: () => undefined }));
vi.mock("@/lib/v22/trade-accounts", async (orig) => ({
  ...(await orig<typeof import("@/lib/v22/trade-accounts")>()),
  resolveLpTradeAccounts: vi.fn(async () => ({ accountB: (await import("./fake-chain")).LP, matcherProg: (await import("./fake-chain")).pk(5), matcherCtx: (await import("./fake-chain")).CTX, matcherDelegate: (await import("./fake-chain")).pk(6) })),
}));
// Only the shared builder is a boundary stub in the summary test (it would otherwise need a signed-fee, blockhash and simulation stack):
// it runs the REAL effectiveTakerPosition and hands the REAL caps their preflight, exactly as buildV22Trade does, then returns a raw-basis summary.
vi.mock("@/lib/v22/trade-build", async (orig) => {
  const real = await orig<typeof import("@/lib/v22/trade-build")>();
  return {
    ...real,
    buildV22Trade: vi.fn(async (c: Connection, req: import("@/lib/v22/trade-build").TradeBuildRequest) => {
      if (!boundary.market) return real.buildV22Trade(c, req);
      const { LP, LP_DATA, WRAPPER } = await import("./fake-chain");
      const { decodeMarketEngineView, signedPositionForAsset } = await import("@/lib/limits/decode");
      const { isReducingOrder } = await import("@/lib/v22/trade-accounts");
      const { sanitizePriceE6 } = await import("@/lib/oraclePrice");
      const engine = decodeMarketEngineView(boundary.market)!;
      const data = new Uint8Array(LP_DATA);
      const eff = real.effectiveTakerPosition(data, engine);
      const raw = signedPositionForAsset(data, 0, engine.marketId)!;
      const px = sanitizePriceE6(engine.effectivePriceE6);
      const limit = req.limitPriceE6 ?? (req.size > 0n ? px * 2n : px / 2n);
      await req.preflight!({ size: req.size, limitPriceE6: limit, effectivePriceE6: px, positionBeforeQ: eff.q, positionLegReset: eff.reset, reducing: isReducingOrder(eff.q, req.size, 1), marketData: boundary.market, portfolioData: data, programId: WRAPPER, market: req.slab, lp: { accountB: LP, matcherCtx: (await import("./fake-chain")).CTX } });
      const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: req.owner, toPubkey: req.slab, lamports: 1 }));
      tx.feePayer = req.owner;
      tx.recentBlockhash = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";
      return {
        transactions: [{ purpose: "order", transaction: tx, computeUnitLimit: 400_000, unitsConsumed: 100_000 }],
        resubmitAfter: false,
        blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi",
        lastValidBlockHeight: 1,
        summary: { market: req.slab.toBase58(), size: req.size.toString(), limitPriceE6: limit.toString(), effectivePriceE6: px.toString(), feeBps: "135", lotExp: 0, positionBeforeQ: raw.toString(), reducing: isReducingOrder(raw, req.size, 1), repairs: [] },
      };
    }),
  };
});

import { buildOrder, buildClose, orderSummary } from "@/lib/bot-api/builders/order";
import { checkOpenMarketGuards, checkOrderCaps, minSlippageBpsFor, resolveCaps } from "@/lib/bot-api/builders/caps";
import { ApiError } from "@/lib/bot-api/errors";
import { marketOffsets } from "@/lib/v22/market-offsets";
import { A_A_SHORT } from "@/lib/limits/constants";
import { computeLimitPriceE6 } from "@/lib/slippage";
import { decodeMarketEngineView } from "@/lib/limits/decode";
import { buildQuoteSource, matcherQuote } from "@/lib/bot-api/reads/quote";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import type { TradePreflight } from "@/lib/v22/trade-build";
import { SOL, SOL_DATA, LP, LP_DATA, CTX, CTX_DATA, WRAPPER, SOL_SLOT } from "./fake-chain";

const ADL_ONE = 1_000_000_000_000_000n;
const OWNER = Keypair.generate().publicKey;
const meta = () => ({ rpcCalls: 0, sims: 0 });
beforeEach(() => {
  __setDevnetV22ForTest(true);
  boundary.market = null;
});
afterEach(() => __setDevnetV22ForTest(null));

const err = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(ApiError);
  return e as ApiError;
};

describe("risk-3: summary carries the effective position and the reducing flag the caps used", () => {
  const conn = (market: Uint8Array) =>
    ({
      getAccountInfo: async (k: PublicKey) => (k.equals(SOL) ? { owner: WRAPPER, data: Buffer.from(market), lamports: 1, executable: false } : null),
      getMultipleAccountsInfoAndContext: async () => ({ context: { slot: SOL_SLOT }, value: [market, CTX_DATA, LP_DATA].map((data) => ({ data: Buffer.from(data), owner: WRAPPER, lamports: 1, executable: false })) }),
      simulateTransaction: async () => ({ context: { slot: 1 }, value: { err: null, logs: [], unitsConsumed: 1000 } }),
    }) as unknown as Connection;
  it("after an ADL the raw basis -555540 is not the position: positionBeforeQ is the effective one, rawBasisQ the raw", async () => {
    const m = new Uint8Array(SOL_DATA);
    const e = marketOffsets(m, "t").engineOff(0);
    const dv = new DataView(m.buffer, m.byteOffset, m.byteLength);
    const a = (ADL_ONE * 9n) / 10n;
    dv.setBigUint64(e + A_A_SHORT, a & ((1n << 64n) - 1n), true);
    dv.setBigUint64(e + A_A_SHORT + 8, a >> 64n, true);
    boundary.market = m;
    // buy 520000: above the effective 499986 (a flip), below the raw 555540 (which the raw reading calls reducing)
    const flip = await buildOrder(conn(m), { owner: OWNER, market: SOL, size: 520_000n, reduceOnly: true, portfolio: LP }, meta()).then(() => null, (x) => x as ApiError);
    expect(flip?.code).toBe("reduce_only_violation");
    // buy exactly the effective position: reducing, and the summary says so with the effective numbers
    const ok = await buildOrder(conn(m), { owner: OWNER, market: SOL, size: 499_986n, reduceOnly: true, portfolio: LP }, meta());
    expect(ok.summary).toMatchObject({ positionBeforeQ: "-499986", reducing: true, rawBasisQ: "-555540", side: "buy" });
    // without ADL effective == raw
    boundary.market = new Uint8Array(SOL_DATA);
    const plain = await buildOrder(conn(new Uint8Array(SOL_DATA)), { owner: OWNER, market: SOL, size: 100_000n, portfolio: LP }, meta());
    expect(plain.summary).toMatchObject({ positionBeforeQ: "-555540", rawBasisQ: "-555540", reducing: true });
  });
  it("orderSummary keeps /api/v22/trade's own shape when no position is given", () => {
    const s = orderSummary({ feeBps: "135", positionBeforeQ: "5", reducing: true }, 1n, { expectedFeeBps: null, expectedFeeAtoms: null });
    expect(s).toMatchObject({ positionBeforeQ: "5", reducing: true });
    expect(s).not.toHaveProperty("rawBasisQ");
  });
});

describe("trader-1: slippage below the matcher's estimate is refused before simulating", () => {
  const conn = () => ({ getMultipleAccountsInfoAndContext: async () => ({ context: { slot: SOL_SLOT }, value: [SOL_DATA, CTX_DATA, LP_DATA].map((data) => ({ data, owner: WRAPPER, lamports: 1, executable: false })) }) }) as unknown as Connection;
  const eng = () => decodeMarketEngineView(new Uint8Array(SOL_DATA))!;
  const pre = (size: bigint, slippageBps: bigint, o: Partial<TradePreflight> = {}): TradePreflight => {
    const px = eng().effectivePriceE6;
    return { size, limitPriceE6: computeLimitPriceE6({ markE6: px, size, slippageBps }), effectivePriceE6: px, positionBeforeQ: 0n, positionLegReset: false, reducing: false, marketData: new Uint8Array(SOL_DATA), portfolioData: null, programId: WRAPPER, market: SOL, lp: { accountB: LP, matcherCtx: CTX }, ...o };
  };
  const estimate = (size: bigint) => matcherQuote(buildQuoteSource(new Uint8Array(SOL_DATA), new Uint8Array(CTX_DATA), new Uint8Array(LP_DATA), LP, { market: SOL, programId: WRAPPER, slot: SOL_SLOT }), size)!;

  for (const size of [25_000n, -25_000n]) {
    const side = size > 0n ? "buy" : "sell";
    it(`${side}: slippageBps 1 is slippage_cap_exceeded with {limitPriceE6, estExecPriceE6, minSlippageBps}; that minimum passes, one less does not`, async () => {
      const q = estimate(size);
      expect(q.quotePriceE6).not.toBeNull();
      const e = await err(checkOpenMarketGuards(conn(), pre(size, 1n)));
      expect(e.code).toBe("slippage_cap_exceeded");
      const d = e.extra.details as { limitPriceE6: string; estExecPriceE6: string; minSlippageBps: number };
      expect(d.estExecPriceE6).toBe(q.quotePriceE6!.toString());
      expect(d.limitPriceE6).toBe(pre(size, 1n).limitPriceE6.toString());
      expect(d.minSlippageBps).toBeGreaterThan(1);
      expect(e.message).toContain("measured from the mark");
      expect((await checkOpenMarketGuards(conn(), pre(size, BigInt(d.minSlippageBps)))).expectedFeeBps).not.toBeNull();
      const below = await err(checkOpenMarketGuards(conn(), pre(size, BigInt(d.minSlippageBps - 1))));
      expect(below.code).toBe("slippage_cap_exceeded");
    });
  }
  it("an explicit limit on the wrong side of the estimate is refused the same way; one past it passes", async () => {
    const q = estimate(25_000n);
    const exec = q.quotePriceE6!;
    expect((await err(checkOpenMarketGuards(conn(), pre(25_000n, 1n, { limitPriceE6: exec - 1n })))).code).toBe("slippage_cap_exceeded");
    await expect(checkOpenMarketGuards(conn(), pre(25_000n, 1n, { limitPriceE6: exec }))).resolves.toBeDefined();
  });
  it("a reducing order is never refused on the estimate (it does not model the close exemption)", async () => {
    await expect(checkOpenMarketGuards(conn(), pre(25_000n, 1n, { reducing: true, positionBeforeQ: -555_540n }))).resolves.toBeDefined();
  });
  it("minSlippageBpsFor: smallest whole bps whose builder limit accepts the fill", () => {
    const mark = 2_000_000n;
    expect(minSlippageBpsFor(mark, 2_000_000n, true)).toBe(1);
    expect(minSlippageBpsFor(mark, 2_005_000n, true)).toBe(25);
    expect(minSlippageBpsFor(mark, 2_005_001n, true)).toBe(26);
    expect(minSlippageBpsFor(mark, 1_995_000n, false)).toBe(25);
    expect(minSlippageBpsFor(mark, 1_994_999n, false)).toBe(26);
  });
  it("the cap check alone is unchanged: an in-band explicit limit still passes checkOrderCaps", () => {
    expect(() => checkOrderCaps(resolveCaps({ explicitLimit: false }), { ...pre(25_000n, 100n), positionBeforeQ: -555_540n, reducing: true, portfolioData: new Uint8Array(LP_DATA) })).not.toThrow();
  });
});

describe("first-timer-6: a wrong or missing `portfolio` is bad_portfolio, not retryable rpc_unavailable", () => {
  // Real buildV22Trade + the real fetchPortfolioIdentity: the named account either does not exist or is not a portfolio.
  const conn = (extra: Record<string, { owner: PublicKey; data: Buffer }> = {}) =>
    ({
      getAccountInfo: async (k: PublicKey) => {
        if (k.equals(SOL)) return { owner: WRAPPER, data: Buffer.from(SOL_DATA), lamports: 1, executable: false };
        const x = extra[k.toBase58()];
        return x ? { ...x, lamports: 1, executable: false } : null;
      },
      getMultipleAccountsInfoAndContext: async () => ({ context: { slot: 1 }, value: [] }),
    }) as unknown as Connection;
  const nowhere = Keypair.generate().publicKey;
  it("order naming a portfolio that does not exist: 400 bad_portfolio, retryable false", async () => {
    const e = await err(buildOrder(conn(), { owner: OWNER, market: SOL, size: 1_000n, portfolio: nowhere }, meta()));
    expect([e.code, e.status, e.retryable]).toEqual(["bad_portfolio", 400, false]);
  });
  it("order naming the market account, or a random account, as the portfolio: bad_portfolio", async () => {
    for (const k of [SOL, nowhere]) {
      const c = k.equals(SOL) ? conn() : conn({ [k.toBase58()]: { owner: WRAPPER, data: Buffer.alloc(64) } });
      const e = await err(buildOrder(c, { owner: OWNER, market: SOL, size: 1_000n, portfolio: k }, meta()));
      expect(e.code).toBe("bad_portfolio");
    }
  });
  it("order naming another wallet's portfolio (the LP's): bad_portfolio", async () => {
    const e = await err(buildOrder(conn({ [LP.toBase58()]: { owner: WRAPPER, data: Buffer.from(LP_DATA) } }), { owner: OWNER, market: SOL, size: 1_000n, portfolio: LP }, meta()));
    expect(e.code).toBe("bad_portfolio");
  });
  it("close naming a portfolio that does not exist: bad_portfolio (not no_portfolio, not rpc_unavailable)", async () => {
    const e = await err(buildClose(conn(), { owner: OWNER.toBase58(), market: SOL.toBase58(), portfolio: nowhere.toBase58() }, meta()));
    expect(e.code).toBe("bad_portfolio");
    const e2 = await err(buildClose(conn({ [nowhere.toBase58()]: { owner: WRAPPER, data: Buffer.alloc(64) } }), { owner: OWNER.toBase58(), market: SOL.toBase58(), portfolio: nowhere.toBase58() }, meta()));
    expect(e2.code).toBe("bad_portfolio");
  });
});
