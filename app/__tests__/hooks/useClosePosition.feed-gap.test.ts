import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";

/**
 * Close while the site's price feed disagrees with the chain.
 *
 * Live, the feed has sat 4-17% away from the on-chain mark on several markets. A
 * close sent no limit, so useTrade derived one from the FEED and (a) refused it
 * outright when feed and chain disagreed by >2% (GH#2525 gate), and (b) even with
 * that gate skipped, a short's close (a buy) got feed x 1.05, which is BELOW the
 * price the fill is checked against — it reverts on-chain.
 *
 * On-chain (percolator-prog TradeCpi): the matcher's exec price is
 * effective_price x (1 +/- <=2%) on the playground matchers, and buy requires
 * exec <= limit, sell exec >= limit. So a close limit is only safe if it brackets
 * effective_price +/- 2%. markEwmaE6 (the keeper mark) can lead effective_price
 * by far more than that during a catch-up, so it is not a valid basis either.
 *
 * Real useClosePosition + real useTrade; only RPC, signing and wire identity
 * reads are mocked. The limit is read off the encoded TradeCpi args.
 */

const mocks = vi.hoisted(() => ({
  useConnectionCompat: vi.fn(),
  useWalletCompat: vi.fn(),
  useSlabState: vi.fn(),
  useUserAccount: vi.fn(),
  sendTx: vi.fn(),
  retryOnce: { on: false },
  isV17Account: vi.fn(),
  parsePortfolioV17: vi.fn(),
  deriveMatcherDelegate: vi.fn(),
  encodeTradeCpi: vi.fn(),
  getLivePriceSnapshot: vi.fn(),
}));

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: mocks.useConnectionCompat,
  useWalletCompat: mocks.useWalletCompat,
}));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: mocks.useSlabState }));
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: mocks.useUserAccount }));
// useTrade sends a single-tx trade via sendTxWaiting (string signature).
vi.mock("@/lib/tx", () => ({ sendTx: mocks.sendTx, sendTxWaiting: mocks.sendTx, prewarmTxLanding: vi.fn() }));
vi.mock("@/lib/programAllowlist", () => ({
  isKnownProgram: () => true,
  assertKnownProgram: () => {},
  assertCanonicalMatcher: () => {},
}));
vi.mock("@/lib/priceStore/priceStore", () => ({ getLivePriceSnapshot: mocks.getLivePriceSnapshot }));
vi.mock("@/lib/matcherCaps", () => ({
  getMatcherCaps: vi.fn(async () => null),
  getLpInventoryState: vi.fn(async () => null),
  invalidateMatcherCaps: vi.fn(),
}));
vi.mock("@/lib/errorMessages", async () => {
  const actual = await vi.importActual<typeof import("@/lib/errorMessages")>("@/lib/errorMessages");
  // One retry on failure when a test asks for it, like the real helper on a
  // transient error; otherwise a single attempt.
  return {
    ...actual,
    withTransientRetry: async (op: () => Promise<unknown>) => {
      try {
        return await op();
      } catch (e) {
        if (!mocks.retryOnce.on) throw e;
        return op();
      }
    },
  };
});
vi.mock("@/lib/tradeRejectDiagnosis", () => ({ diagnoseTradeRejection: vi.fn(async () => null) }));
vi.mock("@/lib/v18-wire", async () => {
  const actual = await vi.importActual<typeof import("@/lib/v18-wire")>("@/lib/v18-wire");
  return {
    ...actual,
    fetchPortfolioIdentity: vi.fn(async () => ({ portfolioId: 1n, positionEpoch: 0n, matcherSequence: 0n })),
    fetchAssetMarketId: vi.fn(async () => 1n),
  };
});
// The LP side by on-chain identity (#2776) is not under test here: pin it.
vi.mock("@/lib/market-lp", async () => {
  const { PublicKey: Pk } = await import("@solana/web3.js");
  const k = (n: number) => new Pk(new Uint8Array(32).fill(n));
  return {
    resolveMarketLp: vi.fn(async () => ({
      pubkey: k(43),
      data: new Uint8Array(0),
      owner: k(44),
      portfolioId: 1n,
      matcherProg: k(46),
      matcherCtx: k(47),
      matcherDelegate: k(48),
      reason: "asset-admin",
    })),
  };
});
vi.mock("@/hooks/useTrade", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/useTrade")>("@/hooks/useTrade");
  return { ...actual, prewarmTradeSubmission: vi.fn() };
});
vi.mock("@percolatorct/sdk", async () => {
  const actual = await vi.importActual<typeof import("@percolatorct/sdk")>("@percolatorct/sdk");
  mocks.encodeTradeCpi.mockImplementation(actual.encodeTradeCpi);
  return {
    ...actual,
    isV17Account: mocks.isV17Account,
    parsePortfolioV17: mocks.parsePortfolioV17,
    deriveMatcherDelegate: mocks.deriveMatcherDelegate,
    encodeTradeCpi: mocks.encodeTradeCpi,
  };
});

import { V17_PORTFOLIO_IDENTITY_TRAILER_LEN } from "@percolatorct/sdk";
import * as C from "@/lib/limits/constants";
import { CLOSE_PRICE_UNREADABLE } from "@/lib/close-limit";
import { useClosePosition } from "@/hooks/useClosePosition";

const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const walletPk = key(41);
const programId = key(42);
const lpPortfolioPk = key(43);
const lpOwner = key(44);
const takerPortfolio = key(45);

function lpPortfolioData(): Buffer {
  const data = Buffer.alloc(240 + V17_PORTFOLIO_IDENTITY_TRAILER_LEN);
  lpOwner.toBuffer().copy(data, 80);
  const off = data.length - 104 - V17_PORTFOLIO_IDENTITY_TRAILER_LEN;
  key(46).toBuffer().copy(data, off);
  key(47).toBuffer().copy(data, off + 32);
  key(48).toBuffer().copy(data, off + 64);
  data.writeBigUInt64LE(1n, off + 96);
  return data;
}

function setFeed(priceE6: bigint | null) {
  mocks.getLivePriceSnapshot.mockReturnValue({ priceE6, priceUsd: null, price: null, loading: false });
}

/** Keeper (AUTH_MARK) market: SlabProvider's markEwmaE6 (-> lastEffectivePriceE6). */
function setMark(markE6: bigint) {
  mocks.useSlabState.mockReturnValue({
    config: {
      oracleAuthority: PublicKey.default,
      indexFeedId: PublicKey.default,
      authorityPriceE6: 0n,
      lastEffectivePriceE6: markE6,
    },
    accounts: [],
    raw: Buffer.from([1]),
    programId,
    wrapperConfigV17: { oracleMode: 3, tradeFeeBps: 30n },
    refresh: vi.fn(),
  });
}

/** Engine asset 0 effective_price as stored in the slab; null = slab unreadable. */
let effectiveE6: bigint | null = null;
/**
 * A v18 market account (header magic / version 18 / kind 1) that lib/limits/decode.ts
 * decodes: asset 0 live on both sides (A = ADL_ONE, epoch 0, mode 0 — not reduce-only),
 * effective_price = `effectiveE6`.
 */
function slabData(): Buffer {
  const e = C.assetEngineOff(0);
  const data = Buffer.alloc(e + 1301);
  data.writeBigUInt64LE(C.WRAPPER_MAGIC, 0);
  data.writeUInt16LE(C.WRAPPER_VERSION_V18, 8);
  data[C.HEADER_KIND_OFF] = C.KIND_MARKET_ACCOUNT;
  data.writeBigUInt64LE(1n, e + C.A_MARKET_ID);
  data.writeBigUInt64LE(effectiveE6 ?? 0n, e + C.A_EFFECTIVE_PRICE);
  data.writeBigUInt64LE(C.ADL_ONE, e + C.A_A_LONG); // u128 LE, high half 0
  data.writeBigUInt64LE(C.ADL_ONE, e + C.A_A_SHORT);
  return data;
}

/** Matcher exec band on the playground: effective x (1 +/- 2%). */
const worstBuyExec = (e: bigint) => (e * 10_200n + 9_999n) / 10_000n;
const worstSellExec = (e: bigint) => (e * 9_800n) / 10_000n;

let slabN = 60;
/** Close 100% of a position of `posQ` (>0 long, <0 short). Returns the outcome + the limit sent. */
async function close(posQ: bigint) {
  const slab = key(slabN++).toBase58(); // fresh slab: useTrade caches trade accounts per slab
  mocks.parsePortfolioV17.mockReturnValue({
    owner: walletPk,
    legs: [{ active: true, side: posQ > 0n ? 0 : 1, basisPosQ: posQ, epochSnap: 0n, aBasis: C.ADL_ONE }],
  });
  const connection = {
    // Every scan left is the taker's own portfolio (fresh close read, useTrade's taker lookup).
    getProgramAccounts: vi.fn(async () => [{ pubkey: takerPortfolio, account: { data: Buffer.from([1]) } }]),
    getAccountInfo: vi.fn(async (pk: PublicKey) =>
      pk.toBase58() === slab && effectiveE6 !== null ? { data: slabData() } : null,
    ),
  };
  mocks.useConnectionCompat.mockReturnValue({ connection });
  const { result, unmount } = renderHook(() => useClosePosition(slab));
  let error: unknown = null;
  let shown: string | null = null;
  try {
    await act(async () => {
      await result.current.closePosition(100).catch((e) => { error = e; });
    });
    shown = result.current.error; // what the user actually sees
  } finally {
    unmount();
  }
  const call = mocks.encodeTradeCpi.mock.calls[0]?.[0] as { limitPrice: string; sizeQ: string } | undefined;
  return { error, shown, limitE6: call ? BigInt(call.limitPrice) : null, sizeQ: call?.sizeQ };
}

const CHAIN = 1_000_000n; // $1.00 on-chain (mark and effective agree)
const FEED_17_LOW = 830_000n; // site feed 17% below (KARDASHEV, live)

describe("closing while the feed is 17% off the chain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isV17Account.mockReturnValue(true);
    mocks.deriveMatcherDelegate.mockReturnValue([key(48), 254]);
    mocks.sendTx.mockResolvedValue("sig");
    mocks.retryOnce.on = false;
    mocks.useWalletCompat.mockReturnValue({ publicKey: walletPk, connected: true });
    mocks.useUserAccount.mockReturnValue({ idx: 0, account: { positionSize: 0n } });
    setMark(CHAIN);
    effectiveE6 = CHAIN;
    setFeed(FEED_17_LOW);
  });

  it("closes a SHORT: sent, not refused, buy limit admits the worst exec", async () => {
    const { error, limitE6, sizeQ } = await close(-5_000_000n);
    expect(error).toBeNull();
    expect(mocks.sendTx).toHaveBeenCalledTimes(1);
    expect(sizeQ).toBe("5000000"); // buy back
    // feed x 1.05 = 0.8715 would be below even the effective price.
    expect(limitE6!).toBeGreaterThanOrEqual(worstBuyExec(CHAIN));
    expect(limitE6).toBe(1_050_000n);
  });

  it("closes a LONG: sent, not refused, sell limit admits the worst exec", async () => {
    const { error, limitE6, sizeQ } = await close(5_000_000n);
    expect(error).toBeNull();
    expect(mocks.sendTx).toHaveBeenCalledTimes(1);
    expect(sizeQ).toBe("-5000000");
    expect(limitE6!).toBeLessThanOrEqual(worstSellExec(CHAIN));
    expect(limitE6).toBe(950_000n);
  });

  it("feed 17% ABOVE: a long's close (sell) still gets a limit the exec passes", async () => {
    setFeed(1_170_000n); // feed x 0.95 = 1.1115 would sit above the fill
    const { error, limitE6 } = await close(5_000_000n);
    expect(error).toBeNull();
    expect(limitE6!).toBeLessThanOrEqual(worstSellExec(CHAIN));
  });

  it("mark leads effective (catch-up, live 8XwbXQ6o: 9000 vs 6806): limit is built from effective, not the mark", async () => {
    setMark(9_000n);
    effectiveE6 = 6_806n;
    setFeed(9_000n);
    const long = await close(5_000_000n);
    expect(long.error).toBeNull();
    // A markEwma-based sell limit (9000 x 0.95 = 8550) would revert here.
    expect(long.limitE6!).toBeLessThanOrEqual(worstSellExec(6_806n));
    expect(long.limitE6).toBe(6_465n);
    vi.clearAllMocks();
    mocks.sendTx.mockResolvedValue("sig");
    const short = await close(-5_000_000n);
    expect(short.error).toBeNull();
    expect(short.limitE6!).toBeGreaterThanOrEqual(worstBuyExec(6_806n));
    expect(short.limitE6).toBe(7_147n);
  });

  it("sub-cent market: limits stay non-zero and bracket the exec band", async () => {
    effectiveE6 = 57n; // $0.000057
    setMark(57n);
    setFeed(47n);
    const short = await close(-5_000_000n);
    expect(short.error).toBeNull();
    expect(short.limitE6!).toBeGreaterThanOrEqual(worstBuyExec(57n));
    vi.clearAllMocks();
    mocks.sendTx.mockResolvedValue("sig");
    const long = await close(5_000_000n);
    expect(long.error).toBeNull();
    expect(long.limitE6!).toBeGreaterThan(0n);
    expect(long.limitE6!).toBeLessThanOrEqual(worstSellExec(57n));
  });

  it("feed down: the close still goes through on the on-chain price", async () => {
    setFeed(null);
    const { error, limitE6 } = await close(-5_000_000n);
    expect(error).toBeNull();
    expect(limitE6).toBe(1_050_000n);
  });

  it("market unreadable: refused before anything is sent, never falls back to the feed", async () => {
    effectiveE6 = null; // the fresh market read (position + price) returns nothing
    const { error } = await close(-5_000_000n);
    expect(error).not.toBeNull();
    expect(mocks.sendTx).not.toHaveBeenCalled();
    expect(mocks.encodeTradeCpi).not.toHaveBeenCalled();
  });

  it("retry with the market unreadable: refuses with the calm one-liner instead of reusing the limit", async () => {
    mocks.retryOnce.on = true;
    mocks.sendTx.mockImplementationOnce(async () => {
      effectiveE6 = null; // the re-read before the retry finds nothing
      throw new Error("Blockhash not found");
    });
    const { error, shown } = await close(-5_000_000n);
    expect(String(error)).toContain(CLOSE_PRICE_UNREADABLE);
    expect(shown).toBe(CLOSE_PRICE_UNREADABLE);
    expect(mocks.sendTx).toHaveBeenCalledTimes(1);
  });

  it("effective price zero: same refusal", async () => {
    effectiveE6 = 0n;
    const { error, shown } = await close(5_000_000n);
    expect(String(error)).toContain(CLOSE_PRICE_UNREADABLE);
    expect(shown).toBe(CLOSE_PRICE_UNREADABLE);
    expect(mocks.sendTx).not.toHaveBeenCalled();
  });

  it("retry after a transient failure re-reads the price instead of reusing the limit", async () => {
    mocks.retryOnce.on = true;
    mocks.sendTx
      .mockImplementationOnce(async () => {
        effectiveE6 = 1_100_000n; // price moves +10% before the retry
        throw new Error("Blockhash not found");
      })
      .mockResolvedValue("sig");
    const { error } = await close(-5_000_000n);
    expect(error).toBeNull();
    const limits = mocks.encodeTradeCpi.mock.calls.map((c) => BigInt((c[0] as { limitPrice: string }).limitPrice));
    expect(limits).toEqual([1_050_000n, 1_155_000n]);
  });
});
