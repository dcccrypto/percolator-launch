/**
 * Round 10 (owner decision 4): the spread quote follows the ORDER'S SIZE.
 *
 * Round 9 found 0.30-0.38% charged on large orders against ~0.23% shown. Cause: the app priced the matcher's impact term on the matcher
 * context's own depth (1e16 on a growth market: ~0 at every size), but the wrapper hands the matcher its capital-derived depth
 * (`liquidity_notional_e6 = 4 x LP capital x lambda`, ext v3) and the matcher prices `impact = ceil(k*n/(D-n))` on `min(ctx, ext)`.
 *
 * Real-shaped state: the live devnet preview SOL market, its vault LP portfolio and matcher context (fixture). `golden` is what the DEPLOYED
 * matcher math (release/v22-matcher 7d5aa26, DfTxJUT5) charges for each size/side, produced by running that source against the same context
 * bytes (scripts/v22-spread-oracle). The r9 live fills ($650 -> 30.0 bps, $1,255 -> 38.0 bps) are the same two points.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import fixture from "../../fixtures/v22-spread-size-aware-sol.json";
import { decodeAssetVaultLp, decodeMarketEngineView, decodeMatcherCtx, decodePortfolioRisk, signedPositionForAsset } from "@/lib/limits/decode";
import { lpEffectiveSignedQ } from "@/lib/limits/lp-inventory-room";
import { preTradeQuote } from "@/lib/limits/matcher-quote";
import { growthFor } from "@/hooks/useMarketLimits";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { matcherExtCapsFromGrowth } from "@/lib/v22/matcher-ext-caps";
import { quotedFillPriceE6, spreadEstimateFromCtx } from "@/lib/v22/spread-estimate";

const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));
const market = bytes(fixture.marketB64);
const lpBytes = bytes(fixture.lpB64);
const PX = BigInt(fixture.oracle.priceE6);
const SLOT = BigInt(fixture.oracle.slot);

interface Golden { side: "buy" | "sell"; reducing: boolean; usd: number; sizeQ: string; execPriceE6?: string; execSize?: string; err?: string }
const golden = fixture.golden as Golden[];
/** Charged spread in bps (the matcher's quoted price over the mark, floored to a whole bp; the price is rounded toward the LP by under 1e-6). */
const bpsOf = (price: bigint): number => {
  const d = price > PX ? price - PX : PX - price;
  return Number((d * 10_000n) / PX);
};
const abs = (n: bigint) => (n < 0n ? -n : n);

function setup() {
  const engine = decodeMarketEngineView(market, 0)!;
  const ctx0 = decodeMatcherCtx(bytes(fixture.ctxB64))!;
  const lpRealQ = lpEffectiveSignedQ(lpBytes, engine, 0, engine.marketId);
  const risk = decodePortfolioRisk(lpBytes)!;
  const lp = { ...risk, address: new PublicKey(fixture.lp), posQ: signedPositionForAsset(lpBytes, 0, engine.marketId) };
  const view = growthFor({ engine, vaultLp: decodeAssetVaultLp(market, 0) }, { lp }, lpRealQ, market, 0, SLOT);
  return { engine, ctx: { ...ctx0, inventoryBase: lpRealQ ?? ctx0.inventoryBase }, lpRealQ, view };
}

describe("size-aware spread quote vs the deployed matcher", () => {
  beforeEach(() => __setDevnetV22ForTest(true));
  afterEach(() => __setDevnetV22ForTest(null));

  it("reads the same inputs the oracle used: price, LP position and the wrapper's ext-v3 caps (rebuilt from the growth view)", () => {
    const { engine, lpRealQ, view } = setup();
    expect(engine.effectivePriceE6).toBe(PX);
    expect(lpRealQ).toBe(BigInt(fixture.oracle.lpPositionQ));
    expect(view).not.toBeNull();
    expect(matcherExtCapsFromGrowth(view, PX)).toEqual({ inventoryCapQ: BigInt(fixture.oracle.inventoryCapQ), liquidityNotionalE6: BigInt(fixture.oracle.liquidityNotionalE6) });
  });

  it("the context alone prices every size at the same ~0.23% (the round 9 bug): impact reads ~0 on the context's 1e16 depth", () => {
    const { ctx } = setup();
    const bps = [20, 400, 650, 1255, 2000].map((usd) => {
      const q = BigInt(Math.round((usd / (Number(PX) / 1e6)) * 1e6));
      return Number(preTradeQuote(ctx, PX, q, true)!.totalBps);
    });
    expect(new Set(bps).size).toBe(1);
    expect(bps[0]).toBe(23);
  });

  it("matches the deployed matcher exactly for every golden size and side (price and filled size)", () => {
    const { ctx, view } = setup();
    const ext = matcherExtCapsFromGrowth(view, PX);
    let checked = 0;
    for (const g of golden) {
      if (g.err) continue;
      const q = preTradeQuote(ctx, PX, BigInt(g.sizeQ), g.side === "buy", { ext, takerReducing: g.reducing, nowSlot: SLOT })!;
      expect(q.quotePriceE6, `${g.side} reducing=${g.reducing} $${g.usd}`).toBe(BigInt(g.execPriceE6!));
      expect(q.fillQ, `${g.side} reducing=${g.reducing} $${g.usd} fill`).toBe(abs(BigInt(g.execSize!)));
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(30);
  });

  it("reproduces the r9 gap: $650 and $1,255 longs are charged 30 and 38 bps (the old quote said 23); the new quote is never below the charge", () => {
    const { ctx, view } = setup();
    const ext = matcherExtCapsFromGrowth(view, PX);
    const rows = [20, 100, 400, 650, 1000, 1255].map((usd) => {
      const g = golden.find((x) => x.side === "buy" && !x.reducing && x.usd === usd)!;
      const q = BigInt(g.sizeQ);
      const oldBps = Number(preTradeQuote(ctx, PX, q, true)!.totalBps);
      const e = spreadEstimateFromCtx(ctx, PX, q, true, true, { ext, takerReducing: false, nowSlot: SLOT })!;
      const newBps = e.kind === "quote" ? e.bps : -1;
      return { usd, oldBps, newBps, charged: bpsOf(BigInt(g.execPriceE6!)) };
    });
    // eslint-disable-next-line no-console
    console.log("size  old  new  charged\n" + rows.map((r) => `$${r.usd}  ${r.oldBps}  ${r.newBps}  ${r.charged}`).join("\n"));
    expect(rows.find((r) => r.usd === 650)).toMatchObject({ oldBps: 23, newBps: 30, charged: 30 });
    expect(rows.find((r) => r.usd === 1255)).toMatchObject({ oldBps: 23, newBps: 38, charged: 38 });
    for (const r of rows) {
      expect(r.newBps).toBeGreaterThanOrEqual(r.charged);
      if (r.usd >= 400) expect(r.oldBps).toBeLessThan(r.charged);
    }
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.newBps).toBeGreaterThanOrEqual(rows[i - 1]!.newBps);
  });

  it("sells and reduce-only closes are priced the same way (a close dialog quotes the CLOSE size, as a reduce)", () => {
    const { ctx, view } = setup();
    const ext = matcherExtCapsFromGrowth(view, PX);
    const rows = golden.filter((x) => x.side === "sell" && x.reducing && !x.err);
    expect(rows.length).toBeGreaterThan(5);
    for (const g of rows) {
      const e = spreadEstimateFromCtx(ctx, PX, BigInt(g.sizeQ), false, true, { ext, takerReducing: true, nowSlot: SLOT })!;
      expect(e.kind === "quote" ? e.bps : -1, `sell close $${g.usd}`).toBe(bpsOf(BigInt(g.execPriceE6!)));
    }
  });

  it("a reduce-only close bigger than the quote budget is priced at the max-total clamp (100 bps), as the matcher does", () => {
    const { ctx, view } = setup();
    const g = golden.find((x) => x.side === "buy" && x.reducing && x.usd === 4000)!;
    const e = spreadEstimateFromCtx(ctx, PX, BigInt(g.sizeQ), true, true, { ext: matcherExtCapsFromGrowth(view, PX), takerReducing: true, nowSlot: SLOT })!;
    expect(e).toMatchObject({ kind: "quote", bps: 100 });
  });

  it("the est. fill is the mark moved by that size's spread, rounded toward the LP; unknown / not-in-fee gives null", () => {
    const { ctx, view } = setup();
    const g = golden.find((x) => x.side === "buy" && !x.reducing && x.usd === 1255)!;
    const e = spreadEstimateFromCtx(ctx, PX, BigInt(g.sizeQ), true, true, { ext: matcherExtCapsFromGrowth(view, PX), nowSlot: SLOT })!;
    expect(quotedFillPriceE6(PX, e, true)).toBe(BigInt(g.execPriceE6!));
    expect(quotedFillPriceE6(PX, { ...e, inFee: false }, true)).toBeNull();
    expect(quotedFillPriceE6(PX, null, true)).toBeNull();
  });

  it("no growth view gives no caps (null): the hook then reports unknown for a growth asset instead of a context-depth quote", () => {
    expect(matcherExtCapsFromGrowth(null, PX)).toBeNull();
  });
});
