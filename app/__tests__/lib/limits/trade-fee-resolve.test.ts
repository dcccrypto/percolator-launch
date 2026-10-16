/**
 * Q-1 / SOL-1 (v2.2 QA 2026-10-11): every app trade failed Custom(9) because the app signed only the base
 * fee (30) while the wrapper requires base + the matcher's requested fee (~23) <= the signed cap <= max.
 * The app now signs the SDK rule (bd79448 computeTradeFeeBpsToSignV22, ported): base + worst-case matcher
 * fee + 5, capped at max_trading_fee_bps. Bytes: the REAL v2.2 devnet SOL / JUP / CHILLHOUSE market + LP
 * matcher context accounts (fixtures/v22-fee-channel-2026-10-11.json, read via RPC).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import fixture from "../../fixtures/v22-fee-channel-2026-10-11.json";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { marketOffsets } from "@/lib/v22/market-offsets";
import * as C from "@/lib/limits/constants";
import { decodeMarketEngineView, decodeMatcherCtx } from "@/lib/limits/decode";
import { requestedFeeBps, requestedFeePermitted, tradeFeeBpsToSign } from "@/lib/limits/fee-channel";
import { preTradeQuote } from "@/lib/limits/matcher-quote";
import { fetchTradeFeeBps, readTradeFeeInputsApp, resolveTradeFeeBps } from "@/lib/limits/trade-fee-resolve";
import { computeTradeFeeBpsToSignV22, matcherFeeWorstCaseBpsV22 } from "@/lib/v22/sdk/v22-trade-fee";

type Mkt = { market: string; matcherCtx: string; marketB64: string; matcherCtxB64: string };
const MARKETS = fixture.markets as Record<string, Mkt>;
const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));
const PROTOCOL_MAX = 100; // AssetRiskLimits.max_requested_fee_bps on all three (read on chain)

/** What the wrapper (RC 6c078a0e handle_trade_cpi) accepts on the fee checks, for a matcher request `req`. */
function programAccepts(d: Uint8Array, signed: bigint, req: bigint): boolean {
  const e = decodeMarketEngineView(d)!;
  if (e.tradeFeeBaseBps > signed) return false;
  if ((signed > e.tradeFeeBaseBps ? signed : e.tradeFeeBaseBps) > e.maxTradingFeeBps) return false;
  return requestedFeePermitted(req, e.tradeFeeBaseBps, signed, PROTOCOL_MAX, e.maxTradingFeeBps);
}
/** The matcher's real request for a fill of `size` (port of matcher 2b08537a, decoded ctx). */
function liveRequest(d: Uint8Array, ctx: Uint8Array, size: bigint, buy: boolean): bigint {
  const e = decodeMarketEngineView(d)!;
  const q = preTradeQuote(decodeMatcherCtx(ctx)!, e.effectivePriceE6, size, buy)!;
  return requestedFeeBps(e.effectivePriceE6, q.quotePriceE6!);
}

describe("Q-1: fee_bps a v2.2 trade signs (real SOL / JUP / CHILLHOUSE bytes)", () => {
  beforeEach(() => __setDevnetV22ForTest(true));
  afterEach(() => __setDevnetV22ForTest(null));

  for (const sym of ["SOL", "JUP", "CHILLHOUSE"]) {
    const m = MARKETS[sym];
    it(`${sym}: reads base 30 / max 700 / max_requested 100 / matcher max_total 100 and signs 135 (the SDK rule)`, () => {
      const d = bytes(m.marketB64);
      const ctx = bytes(m.matcherCtxB64);
      expect(readTradeFeeInputsApp(d, 0, ctx)).toEqual({ tradeFeeBaseBps: 30n, maxTradingFeeBps: 700n, maxRequestedFeeBps: 100, matcherExtMode: 1, matcherMaxTotalBps: 100 });
      const r = resolveTradeFeeBps({ marketData: d, matcherCtxData: ctx })!;
      expect(r.feeBps).toBe(135n);
      expect(r.coversWorstCase).toBe(true);
      // Every request the program can accept on this asset (0..100) lands; so do the live quotes.
      for (const req of [0n, 23n, 25n, 100n]) expect(programAccepts(d, r.feeBps, req)).toBe(true);
      for (const buy of [true, false]) expect(programAccepts(d, r.feeBps, liveRequest(d, ctx, 1_000_000n, buy))).toBe(true);
    });
    it(`${sym} NEGATIVE CONTROLS: base only (the pre-fix value) and 50 are refused; 701 is refused; 700 lands`, () => {
      const d = bytes(m.marketB64);
      const ctx = bytes(m.matcherCtxB64);
      const req = liveRequest(d, ctx, 1_000_000n, true);
      const legacy = tradeFeeBpsToSign(undefined, decodeMarketEngineView(d)!.tradeFeeBaseBps);
      expect(legacy).toBe(30n);
      expect(programAccepts(d, legacy, req)).toBe(false);
      expect(programAccepts(d, 50n, req)).toBe(false);
      expect(programAccepts(d, 701n, req)).toBe(false);
      expect(programAccepts(d, 700n, req)).toBe(true);
    });
  }

  it("parity with the SDK's own examples (bd79448 doc + devnet numbers)", () => {
    expect(matcherFeeWorstCaseBpsV22({ tradeFeeBaseBps: 30n, maxTradingFeeBps: 500n, maxRequestedFeeBps: 100, matcherMaxTotalBps: 60 })).toBe(61);
    expect(computeTradeFeeBpsToSignV22({ tradeFeeBaseBps: 30n, maxTradingFeeBps: 700n, maxRequestedFeeBps: 100, matcherExtMode: 1, matcherMaxTotalBps: 100 }).feeBps).toBe(135n);
    expect(computeTradeFeeBpsToSignV22({ tradeFeeBaseBps: 30n, maxTradingFeeBps: 700n, maxRequestedFeeBps: 100, matcherExtMode: 0 }).feeBps).toBe(35n);
  });

  it("clamps to the market's max_trading_fee_bps", () => {
    const d = bytes(MARKETS.SOL.marketB64);
    const M = marketOffsets(d);
    new DataView(d.buffer, d.byteOffset).setBigUint64(M.g + C.H_CONFIG + C.CFG_MAX_TRADING_FEE_BPS, 40n, true);
    expect(resolveTradeFeeBps({ marketData: d, matcherCtxData: bytes(MARKETS.SOL.matcherCtxB64) })!.feeBps).toBe(40n);
  });

  it("channel off (matcher_ext_mode 0) => base + margin only", () => {
    const d = bytes(MARKETS.JUP.marketB64);
    const M = marketOffsets(d);
    d[M.wrapperOff(0) + C.ASSET_RISK_LIMITS_OFF + C.RL_MATCHER_EXT_MODE] = 0;
    const r = resolveTradeFeeBps({ marketData: d, matcherCtxData: bytes(MARKETS.JUP.matcherCtxB64) })!;
    expect(r).toMatchObject({ feeBps: 35n, matcherFeeWorstCaseBps: 0 });
  });

  it("undecodable market bytes => null (the caller keeps its legacy value)", () => {
    expect(resolveTradeFeeBps({ marketData: new Uint8Array(100), matcherCtxData: null })).toBeNull();
  });

  describe("fetchTradeFeeBps", () => {
    const conn = (rows: Array<Uint8Array | null> | Error) => ({
      getMultipleAccountsInfo: async () => {
        if (rows instanceof Error) throw rows;
        return rows.map((r) => (r ? { data: Buffer.from(r), executable: false, lamports: 1, owner: PublicKey.default } : null));
      },
    });
    const mk = new PublicKey(MARKETS.SOL.market);
    const cx = new PublicKey(MARKETS.SOL.matcherCtx);
    it("chain value", async () => {
      expect(await fetchTradeFeeBps(conn([bytes(MARKETS.SOL.marketB64), bytes(MARKETS.SOL.matcherCtxB64)]), mk, cx, { fallback: 30n })).toBe(135n);
    });
    it("RPC failure => fallback (never blocks)", async () => {
      expect(await fetchTradeFeeBps(conn(new Error("429")), mk, cx, { fallback: 30n })).toBe(30n);
    });
  });
});
