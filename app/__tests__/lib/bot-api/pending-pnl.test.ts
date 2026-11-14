// @vitest-environment node
/**
 * risk-2: the cap equity and GET /v1/account count the K/F loss a leg has accrued since its snapshot. Real devnet SOL market
 * + its LP portfolio (a short, basis -555540, a_basis = ADL_ONE); only the market's K_short / F_short / effective price are
 * patched. Nothing here is mocked: parsePortfolio, decodePortfolioRisk, maxLeverageFromSlab and the caps all run on bytes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkOrderCaps, resolveCaps } from "@/lib/bot-api/builders/caps";
import { openLegsValuePnl, portfolioView } from "@/lib/bot-api/reads/account";
import { pendingKfPnl } from "@/lib/bot-api/reads/pending-pnl";
import { conservativeEquity } from "@/lib/bot-api/builders/equity";
import { ApiError } from "@/lib/bot-api/errors";
import { parsePortfolio } from "@/lib/v22/layout";
import { decodePortfolioRisk, decodeMarketEngineView } from "@/lib/limits/decode";
import { marketOffsets } from "@/lib/v22/market-offsets";
import { parseAssetSettleState } from "@/lib/risk-entry";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import type { TradePreflight } from "@/lib/v22/trade-build";
import { SOL, SOL_DATA, LP, LP_DATA, WRAPPER, pk } from "./fake-chain";

const ADL_ONE = 1_000_000_000_000_000n;
const POS = 1_000_000n;
beforeEach(() => __setDevnetV22ForTest(true));
afterEach(() => __setDevnetV22ForTest(null));

const I128 = 1n << 128n;
function addI128(d: DataView, off: number, delta: bigint) {
  const lo = d.getBigUint64(off, true);
  const hi = d.getBigInt64(off + 8, true);
  const v = BigInt.asIntN(128, (hi << 64n) + lo + delta);
  const u = BigInt.asUintN(128, v);
  d.setBigUint64(off, u & ((1n << 64n) - 1n), true);
  d.setBigUint64(off + 8, u >> 64n, true);
  void I128;
}
/** The SOL market with K_short / F_short moved by the given deltas (offsets 97 / 129 within the asset slot, lib/risk-entry.ts). */
function market(o: { kShort?: bigint; fShort?: bigint } = {}): Uint8Array {
  const d = new Uint8Array(SOL_DATA);
  const e = marketOffsets(d, "t").engineOff(0);
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (o.kShort) addI128(v, e + 97, o.kShort);
  if (o.fShort) addI128(v, e + 129, o.fShort);
  return d;
}
const lpData = () => new Uint8Array(LP_DATA);
const lpLeg = () => parsePortfolio(lpData()).legs.find((l) => l.active)!;
/** K_short delta that makes the short's pending PnL exactly `atoms` (negative = a loss): atoms x ADL_ONE x POS / |basis|. */
const kForPending = (atoms: bigint) => {
  const basis = lpLeg().basisPosQ < 0n ? -lpLeg().basisPosQ : lpLeg().basisPosQ;
  return (atoms * lpLeg().aBasis * POS) / basis;
};

describe("pendingKfPnl on real bytes", () => {
  it("fixture: the LP short is settled (nothing pending) at the stored K/F", () => {
    const leg = lpLeg();
    expect(leg.side).toBe(1);
    expect(leg.aBasis).toBe(ADL_ONE);
    const st = parseAssetSettleState(market(), 0)!;
    expect(st.kShort).toBe(leg.kSnap);
    expect(pendingKfPnl(st, leg, leg.basisPosQ, leg.aBasis)).toEqual({ k: 0n, f: 0n, net: 0n });
  });
  it("K_short moved: pending = floor(|basis| x dK / (a_basis x POS_SCALE)), the engine's settle formula", () => {
    const leg = lpLeg();
    const dK = -kForPending(400_000_000n); // a 400 USD loss
    const st = parseAssetSettleState(market({ kShort: dK }), 0)!;
    const p = pendingKfPnl(st, leg, leg.basisPosQ, leg.aBasis)!;
    const basis = leg.basisPosQ < 0n ? -leg.basisPosQ : leg.basisPosQ;
    const exact = (basis * dK) / (leg.aBasis * POS);
    expect(p.k).toBeLessThanOrEqual(exact);
    expect(p.k).toBeGreaterThanOrEqual(exact - 1n); // BigInt division truncates toward zero; the port floors
    expect(p.k).toBeLessThan(-399_999_000n);
    expect(p.f).toBe(0n);
    // F accrues too: a paid funding adds to the loss
    const st2 = parseAssetSettleState(market({ kShort: dK, fShort: -kForPending(10_000_000n) }), 0)!;
    const p2 = pendingKfPnl(st2, leg, leg.basisPosQ, leg.aBasis)!;
    expect(p2.f).toBeLessThan(-9_999_000n);
    expect(p2.net).toBe(p2.k + p2.f);
  });
  it("a leg on an older ADL epoch, a stale leg or a missing asset has no pending figure (never guessed)", () => {
    const leg = lpLeg();
    const st = parseAssetSettleState(market(), 0)!;
    expect(pendingKfPnl(st, { ...leg, epochSnap: leg.epochSnap + 1n } as never, leg.basisPosQ, leg.aBasis)).toBeNull();
    expect(pendingKfPnl(st, { ...leg, stale: true } as never, leg.basisPosQ, leg.aBasis)).toBeNull();
    expect(pendingKfPnl(null, leg as never, leg.basisPosQ, leg.aBasis)).toBeNull();
  });
});

describe("risk-2: value pnl, /v1/account and the leverage cap see the pending loss", () => {
  // The v2.2 layout flag is set in beforeEach, so the fixture is decoded lazily.
  let pf: ReturnType<typeof parsePortfolio>;
  let risk: NonNullable<ReturnType<typeof decodePortfolioRisk>>;
  let eng: NonNullable<ReturnType<typeof decodeMarketEngineView>>;
  beforeEach(() => {
    pf = parsePortfolio(lpData());
    risk = decodePortfolioRisk(lpData())!;
    eng = decodeMarketEngineView(new Uint8Array(SOL_DATA))!;
  });
  const view = (m: Uint8Array) => portfolioView({ pubkey: LP, account: { data: Buffer.from(LP_DATA) } }, pf.owner, WRAPPER, { raw: m, programId: WRAPPER }, 1)!;

  it("settled: value pnl == stored pnl (the pnl of the account is a valid pnl, whatever its size)", () => {
    expect(openLegsValuePnl(market(), lpData())).toEqual({ kind: "open", valuePnl: risk.pnl });
    expect(view(market()).pendingPnl).toBe(0n);
  });
  it("K moved against the short: valuePnl = stored pnl + pending, and /v1/account equity moves with it", () => {
    const loss = 3n * (risk.capital + (risk.pnl > 0n ? risk.pnl : 0n));
    const m = market({ kShort: -kForPending(loss) });
    const r = openLegsValuePnl(m, lpData());
    expect(r.kind).toBe("open");
    const v = (r as { valuePnl: bigint }).valuePnl;
    expect(v).toBeLessThan(risk.pnl - loss + 2n);
    expect(v).toBeGreaterThan(risk.pnl - loss - 2n);
    const a = view(m);
    expect(a.pendingPnl).toBe(v - risk.pnl);
    expect(a.valuePnl).toBe(v);
    expect(a.equity).toBe(risk.capital + v);
    expect(a.leverageEquity).toBe(conservativeEquity(risk.capital, v, risk.feeCredits));
    expect(a.positions[0].unrealizedPnl).toBe(v); // single leg: stored pnl + pending
    expect(view(market()).equity).toBe(risk.capital + risk.pnl); // unmoved K: the old figure
  });
  it("a K GAIN lifts the account equity but never the cap's equity (unrealized profit is not margin)", () => {
    const m = market({ kShort: kForPending(1_000_000_000n) });
    expect(view(m).equity).toBeGreaterThan(risk.capital + risk.pnl);
    expect(view(m).leverageEquity).toBe(conservativeEquity(risk.capital, risk.pnl + 1_000_000_000n, risk.feeCredits));
  });

  const order = (m: Uint8Array, size: bigint): TradePreflight => ({
    size,
    limitPriceE6: eng.effectivePriceE6,
    effectivePriceE6: eng.effectivePriceE6,
    positionBeforeQ: -555_540n,
    positionLegReset: false,
    reducing: false,
    marketData: m,
    portfolioData: lpData(),
    programId: WRAPPER,
    market: SOL,
    lp: { accountB: LP, matcherCtx: pk(4) },
  });
  const run = (m: Uint8Array, cap: number) => {
    try {
      return checkOrderCaps(resolveCaps({ explicitLimit: true, maxLeverage: cap, maxNotionalUsd: 1e9 }), order(m, -100_000n));
    } catch (e) {
      return e instanceof ApiError ? e.code : String(e);
    }
  };
  it("the cap refuses once the pending loss has eaten the equity, and passes the same order on the settled market", () => {
    // leverage after = (555540+100000) q x price / equity. Pick the cap just above the settled leverage.
    const px = eng.effectivePriceE6;
    const after = (655_540n * px) / POS;
    const equity0 = conservativeEquity(risk.capital, risk.pnl, risk.feeCredits);
    const capLev = (Number((after * 10_000n) / equity0) / 10_000) * 1.5;
    const settled = run(market(), capLev);
    expect(typeof settled).toBe("object"); // passes
    // lose 80% of the equity in pending K: leverage x5 vs the cap at x1.5 of the settled figure
    const m = market({ kShort: -kForPending((equity0 * 8n) / 10n) });
    expect(run(m, capLev)).toBe("leverage_cap_exceeded");
    // lose more than all of it: no equity
    expect(run(market({ kShort: -kForPending(equity0 * 2n) }), capLev)).toBe("insufficient_margin");
  });
  it("stored pnl == 0 on an open leg is a valid pnl, not market_unreadable", () => {
    const d = lpData();
    const dv = new DataView(d.buffer);
    const offs: number[] = [];
    for (let i = 0; i + 16 <= d.length; i++) if (dv.getBigUint64(i, true) === BigInt.asUintN(64, risk.pnl) && dv.getBigUint64(i + 8, true) === 0n) offs.push(i);
    expect(offs.length).toBeGreaterThan(0);
    const z = new Uint8Array(d);
    new DataView(z.buffer).setBigUint64(offs[0], 0n, true);
    expect(parsePortfolio(z).pnl).toBe(0n);
    expect(openLegsValuePnl(market(), z)).toEqual({ kind: "open", valuePnl: 0n });
    const res = checkOrderCaps(resolveCaps({ explicitLimit: true, maxLeverage: 10, maxNotionalUsd: 1e9 }), { ...order(market(), -100_000n), portfolioData: z });
    expect(res.leverageAfter).not.toBeNull();
  });
});
