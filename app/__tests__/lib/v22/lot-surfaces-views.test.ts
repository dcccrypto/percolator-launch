/**
 * F3 (security review #3235): lot markets, VIEW side. One test per surface; each runs with lotExp = 3 and a lotExp = 0
 * control, flag ON, and FAILS if that surface's lot conversion is dropped (mutations recorded in the PR notes).
 * Money values are lot-invariant (q_lots * mark_lot == tokens * mark_token); only PRICE (/10^k) and SIZE (x10^k) move.
 *
 * "source guard" tests assert a component/hook imports and uses the lot helper at its display sites; they prove the
 * wiring exists (a dropped conversion fails them), the pure maths is covered by the behavioural tests around them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { parseWrapperConfigV17, V17_HEADER_LEN } from "@percolatorct/sdk";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { formatLotPriceE6, formatLotQ, lotExpOf, qToTokenQ, tokenUsdOfLotUsd } from "@/lib/v22/lot";
import { lotMarketNumbers, qToDisplayTokens } from "@/lib/v22/lot-view";
import { syntheticMarket, put128 } from "./_stamp";
import { LAYOUT_V22 } from "@/lib/v22/sdk";
import { readLiveMarketStates } from "@/lib/live-market-state";
import { getSnapshot, seedFromDbIfEmpty, setLotExp, applyOnChainPoll } from "@/lib/priceStore/priceStore";
import { computePnlCardStats, type PnlCardData } from "@/lib/pnl-card";
import { createCandlesApiProvider } from "@/lib/tv/data/candlesApiProvider";
import { formatPrice, formatSize } from "@/components/trade/TradeHistoryTable";

const L = LAYOUT_V22;
const root = path.resolve(__dirname, "../../..");
const src = (rel: string): string => fs.readFileSync(path.join(root, rel), "utf8");

/** A v2.2 market with lot exponent `k`, a per-LOT mark and per-LOT-denominated OI. */
function lotMarket(k: number, markE6: bigint, oiLong: bigint, oiShort: bigint): Uint8Array {
  const d = syntheticMarket(L, 1);
  const slot = L.marketGroupOff + L.marketGroupLen;
  d[slot + L.wrapperSlot.profileLotExp] = k;
  const eng = slot + L.wrapperSlotLen;
  put128(d, eng + L.assetState.oiEffLongQ, oiLong);
  put128(d, eng + L.assetState.oiEffShortQ, oiShort);
  // wrapper config mark: find the offset the installed decoder reads markEwmaE6 from, by probing
  let off = -1;
  for (let o = V17_HEADER_LEN; o < 600 && off < 0; o += 8) {
    const probe = new Uint8Array(d);
    new DataView(probe.buffer).setBigUint64(o, 0x1234_5678n, true);
    try {
      if (parseWrapperConfigV17(probe, V17_HEADER_LEN).markEwmaE6 === 0x1234_5678n) off = o;
    } catch {
      /* keep probing */
    }
  }
  expect(off).toBeGreaterThan(0);
  new DataView(d.buffer).setBigUint64(off, markE6, true);
  return d;
}

beforeEach(() => __setDevnetV22ForTest(true));
afterEach(() => __setDevnetV22ForTest(null));

describe("lotExpOf reads the market's lot exponent", () => {
  it("3 on a lot market, 0 on a market without lots, 0 with the flag off", () => {
    expect(lotExpOf(lotMarket(3, 60_000_000n, 0n, 0n))).toBe(3);
    expect(lotExpOf(lotMarket(0, 60_000_000n, 0n, 0n))).toBe(0);
    __setDevnetV22ForTest(false);
    expect(lotExpOf(lotMarket(3, 60_000_000n, 0n, 0n))).toBe(0);
  });
});

describe("surface: /api/markets row numbers (lotMarketNumbers)", () => {
  // per-lot mark $60 with 1,000-token lots = $0.06 per token; OI 2 and 3 lots = 2,000 and 3,000 tokens
  it("lotExp 3: per-token price and token-scaled OI; USD OI is invariant", () => {
    const n = lotMarketNumbers({ markE6: 60_000_000n, oiLongQ: 2_000_000n, oiShortQ: 3_000_000n }, 3);
    expect(n.priceUsd).toBeCloseTo(0.06, 12);
    expect(n.oiLong).toBe(2_000_000_000);
    expect(n.totalOi).toBe(5_000_000_000);
    expect(n.totalOiUsd).toBeCloseTo(300, 9); // 5 lots x $60 == 5,000 tokens x $0.06
  });
  it("lotExp 0 control: identity", () => {
    const n = lotMarketNumbers({ markE6: 60_000_000n, oiLongQ: 2_000_000n, oiShortQ: 3_000_000n }, 0);
    expect(n).toMatchObject({ priceUsd: 60, oiLong: 2_000_000, oiShort: 3_000_000, totalOi: 5_000_000 });
    expect(n.totalOiUsd).toBeCloseTo(300, 9);
  });
  it("source guard: both market routes convert through lotMarketNumbers", () => {
    for (const f of ["app/api/markets/route.ts", "app/api/markets/[slab]/route.ts"]) {
      const s = src(f);
      expect(s).toContain("lotMarketNumbers(");
      expect(s).toContain("lotExpOf(");
      expect(s).toContain("lot_exp");
    }
    expect(src("app/api/open-interest/[slab]/route.ts")).toContain("lotExp");
  });
});

describe("surface: live market state (the row merged into /api/markets)", () => {
  const key = new PublicKey("11111111111111111111111111111112");
  const read = async (data: Uint8Array) => {
    const connection = { getMultipleAccountsInfo: async () => [{ data: Buffer.from(data), owner: key, lamports: 1, executable: false }] } as never;
    const out = await readLiveMarketStates([key], connection);
    return out.get(key.toBase58()) ?? [...out.values()][0];
  };
  it("lotExp 3: per-token mark and token-scaled OI", async () => {
    const s = await read(lotMarket(3, 60_000_000n, 2_000_000n, 3_000_000n));
    expect(s?.markPriceUsd).toBeCloseTo(0.06, 12);
    expect(s?.oiLongQ).toBe(2_000_000_000);
    expect(s?.totalOiUsd).toBeCloseTo(300, 6);
  });
  it("lotExp 0 control: unchanged", async () => {
    const s = await read(lotMarket(0, 60_000_000n, 2_000_000n, 3_000_000n));
    expect(s?.markPriceUsd).toBe(60);
    expect(s?.oiLongQ).toBe(2_000_000);
  });
});

describe("surface: price store (the app's price unit is per LOT)", () => {
  it("lotExp 3: a per-token DB price is stored per lot, including when the exponent arrives AFTER the seed", () => {
    const a = "LotSlabAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    setLotExp(a, 3);
    seedFromDbIfEmpty(a, 0.06, undefined);
    expect(getSnapshot(a).priceE6).toBe(60_000_000n);
    expect(getSnapshot(a).lotExp).toBe(3);
    const b = "LotSlabBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    seedFromDbIfEmpty(b, 0.06, undefined); // seeded before the exponent is known: held back (review N1), never stored per token
    expect(getSnapshot(b).priceE6).toBeNull();
    setLotExp(b, 3); // applied per lot once known
    expect(getSnapshot(b).priceE6).toBe(60_000_000n);
  });
  it("lotExp 0 control: untouched; an on-chain poll is already per lot and is never scaled", () => {
    const c = "LotSlabCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
    setLotExp(c, 0);
    seedFromDbIfEmpty(c, 0.06, undefined);
    expect(getSnapshot(c).priceE6).toBe(60_000n);
    const d = "LotSlabDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
    setLotExp(d, 3);
    applyOnChainPoll(d, 60_000_000n);
    expect(getSnapshot(d).priceE6).toBe(60_000_000n);
  });
});

describe("surface: PnL share card", () => {
  const data = (lotExp: number): PnlCardData =>
    ({ slab: "s", symbol: "TOK", name: "TOK", nominalSizeQ: 2_000_000n, effectiveSizeQ: 2_000_000n, entryE6: 60_000_000n, initialMarginBps: 1000n, initialMarkE6: 66_000_000n, decimals: 6, lotExp }) as unknown as PnlCardData;
  it("lotExp 3: entry and exit shown per token; PnL unchanged (lot-invariant)", () => {
    const s = computePnlCardStats(data(3), 66_000_000n);
    expect(s.avgEntryUsd).toBeCloseTo(0.06, 12);
    expect(s.avgExitUsd).toBeCloseTo(0.066, 12);
    expect(s.pnlUsd).toBeCloseTo(computePnlCardStats(data(0), 66_000_000n).pnlUsd, 9);
  });
  it("lotExp 0 control", () => {
    expect(computePnlCardStats(data(0), 66_000_000n).avgEntryUsd).toBe(60);
  });
});

describe("surface: chart data provider (history, trades, marks)", () => {
  const SLAB = "HBU9iugdcxdvQ9tNFuTLTtcB1bYXFdh4d5reD8M2dpop";
  const mk = (lotExp: number) => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith("/api/markets/")) return new Response(JSON.stringify({ market: { symbol: "TOK", mark_price: 0.06, ...(lotExp ? { lot_exp: lotExp } : {}) } }), { status: 200 });
      return new Response(JSON.stringify({ s: "ok", t: [1000], o: [60], h: [66], l: [54], c: [63], v: [2] }), { status: 200 });
    });
    const trades = { subscribe: vi.fn() };
    const marks = { subscribe: vi.fn(), latest: vi.fn(() => 60) };
    return { provider: createCandlesApiProvider({ fetchImpl: fetchImpl as never, trades: trades as never, marks: marks as never }), trades, marks };
  };
  it("lotExp 3: candles per token, volume in tokens, reference price from the API (already per token)", async () => {
    const { provider } = mk(3);
    const meta = await provider.resolveSymbol(SLAB);
    expect(meta.referencePrice).toBeCloseTo(0.06, 12);
    const page = await provider.getBars({ slab: SLAB, resolution: "1", fromSec: 0, toSec: 5000, countBack: 1, firstRequest: true } as never);
    expect(page.bars[0].close).toBeCloseTo(0.063, 12);
    expect(page.bars[0].volume).toBe(2000);
  });
  it("lotExp 3: live trades and marks are converted too", async () => {
    const { provider, trades, marks } = mk(3);
    await provider.resolveSymbol(SLAB);
    const bars: Array<{ close: number; volume: number }> = [];
    provider.subscribeBars(SLAB, "1", { onBar: (b: { close: number; volume: number }) => bars.push(b), onReset: () => {} } as never, null, "percolator");
    trades.subscribe.mock.calls[0][1]({ price: 63, size: 2, tsSec: 2000 });
    expect(bars[0].close).toBeCloseTo(0.063, 12);
    expect(bars[0].volume).toBe(2000);
    provider.subscribeBars(SLAB, "1", { onBar: (b: { close: number }) => bars.push(b as never), onReset: () => {} } as never, null, "oracle");
    marks.subscribe.mock.calls[0][1](63, 3000);
    expect(bars[bars.length - 1].close).toBeCloseTo(0.063, 12);
  });
  it("lotExp 0 control: values pass through", async () => {
    const { provider } = mk(0);
    await provider.resolveSymbol(SLAB);
    const page = await provider.getBars({ slab: SLAB, resolution: "1", fromSec: 0, toSec: 5000, countBack: 1, firstRequest: true } as never);
    expect(page.bars[0].close).toBe(63);
  });
});

describe("surface: trade history rows (indexer size in lots, price per lot)", () => {
  it("lotExp 3: size in tokens and price per token", () => {
    expect(formatSize("2000000", 6, 3)).toBe(formatLotQ(2_000_000n, 6, 3));
    expect(formatSize("2000000", 6, 3)).not.toBe(formatSize("2000000", 6, 0));
    expect(formatPrice(60, 3)).toBe(formatPrice(0.06, 0));
  });
  it("lotExp 0 control: identical to the legacy output", () => {
    expect(formatSize("2000000", 6)).toBe(formatLotQ(2_000_000n, 6, 0));
    expect(formatPrice(60)).toBe(formatPrice(60, 0));
  });
});

describe("shared display helpers", () => {
  it("size in tokens = lots x 10^k; price per token = per lot / 10^k; lotExp 0 is the identity", () => {
    expect(qToDisplayTokens(2_000_000n, 3)).toBe(2000);
    expect(qToDisplayTokens(-2_000_000n, 3)).toBe(2000);
    expect(qToTokenQ(5n, 0)).toBe(5n);
    expect(tokenUsdOfLotUsd(60, 3)).toBeCloseTo(0.06, 12);
    expect(formatLotPriceE6(60_000_000n, 3)).not.toBe(formatLotPriceE6(60_000_000n, 0));
  });
});

describe("source guards: every display site converts through lib/v22/lot.ts", () => {
  const sites: Array<[string, RegExp]> = [
    ["components/portfolio/PortfolioPositionsView.tsx", /formatLotQ\(sizeAbs[\s\S]*formatLotPriceE6\(markE6/],
    ["components/dashboard/PositionSummary.tsx", /formatLotQ\(sizeAbs[\s\S]*formatLotPriceE6\(markE6/],
    ["components/trade/OtherMarketPositions.tsx", /formatLotQ\(abs\(posSize\)[\s\S]*formatLotPriceE6\(entryE6/],
    ["components/portfolio/LiquidationRiskItem.tsx", /formatLotPriceE6\(markE6/],
    ["components/trade/PositionNftMenu.tsx", /formatLotQ\(/],
    ["components/trade/MarketStatsCard.tsx", /qToTokenQ\(atoms, lotExp\)/],
    ["components/trade/SystemCapitalCard.tsx", /qToTokenQ\(/],
    ["components/trade/EngineHealthCard.tsx", /qToTokenQ\(s, lotExp\)/],
    ["components/trade/TradeHistory.tsx", /formatLotQ\([\s\S]*tokenUsdOfLotUsd\(/],
    ["components/trade/TradingChart.tsx", /tokenUsdOfLotUsd\(snap\.priceUsd/],
    ["components/trade/MarketSelector.tsx", /formatLotPriceE6\(livePriceE6/],
    ["components/market/LiveRowPrice.tsx", /tokenUsdOfLotUsd\(liveLot/],
    ["components/landing/LiveMarketRail.tsx", /tokenUsdOfLotUsd\(livePriceLotUsd/],
    ["components/my-markets/CreatorMarketRow.tsx", /tokenUsdOfLotUsd\(liveLot[\s\S]*10 \*\* \(snapForOi\.lotExp/],
    ["hooks/usePositionLinePrices.ts", /tokenUsdOfLotUsd\(Number\(pnl\.entry\)[\s\S]*tokenUsdOfLotUsd\(Number\(liq\)/],
    ["hooks/usePortfolio.ts", /lotExp: lotExpOf\(slabData\)[\s\S]*meta\.lotExp \?\? 0/],
    ["hooks/useLivePrice.ts", /observeLotExp\(slabAddr, slabRaw\)/],
  ];
  it.each(sites)("%s", (file, re) => {
    expect(src(file)).toMatch(re);
  });
});
