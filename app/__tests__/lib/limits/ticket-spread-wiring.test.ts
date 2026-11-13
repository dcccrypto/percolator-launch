/**
 * Review of #3820 (HIGH 1): the size-aware quote must reach the ticket's Fee row inputs, the signed fee cap and the close fee, not only the pure
 * quote. Real-shaped state: the live devnet SOL market + LP + matcher context fixture (v22-spread-size-aware-sol.json). Each test fails if its
 * wiring is reverted (ext caps not passed, reducing flag dropped, close input without the growth view, unknown view priced on the context).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import fixture from "../../fixtures/v22-spread-size-aware-sol.json";
import { decodeAssetRiskLimits, decodeAssetVaultLp, decodeMarketEngineView, decodeMatcherCtx, decodePortfolioRisk, signedPositionForAsset } from "@/lib/limits/decode";
import { lpEffectiveSignedQ } from "@/lib/limits/lp-inventory-room";
import { effectiveExecBandBps } from "@/lib/limits/risk-limits";
import { growthFor, type MarketLimits } from "@/hooks/useMarketLimits";
import { closeOrderInput } from "@/hooks/useCloseFeeEstimate";
import { closeFeeBps } from "@/lib/limits/estimated-fee";
import { deriveTicketLimits } from "@/lib/limits/ticket";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";

const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));
const market = bytes(fixture.marketB64);
const lpBytes = bytes(fixture.lpB64);
const PX = BigInt(fixture.oracle.priceE6);
const SLOT = BigInt(fixture.oracle.slot);
const sizeQ = (usd: number) => BigInt(Math.round((usd / (Number(PX) / 1e6)) * 1e6));

function limitsFor(opts: { growth?: boolean; growthRoom?: MarketLimits["growthRoom"] } = {}): MarketLimits {
  const engine = decodeMarketEngineView(market, 0)!;
  const ctx = decodeMatcherCtx(bytes(fixture.ctxB64))!;
  const lpRealQ = lpEffectiveSignedQ(lpBytes, engine, 0, engine.marketId);
  const risk = decodePortfolioRisk(lpBytes)!;
  const lp = { ...risk, address: new PublicKey(fixture.lp), posQ: signedPositionForAsset(lpBytes, 0, engine.marketId) };
  const vaultLp = decodeAssetVaultLp(market, 0);
  const riskLimits = decodeAssetRiskLimits(market, 0);
  return {
    state: "ready",
    flags: { p1: false, p2: true, p2FeeCharged: false, p3: false },
    engine,
    riskLimits,
    bandBps: riskLimits ? effectiveExecBandBps(riskLimits.execBandBps) : null,
    vaultLp,
    lp,
    matcher: ctx,
    lpRealQ,
    matcherSyncLive: true,
    vaultState: null,
    registryShares: null,
    assetAdmin: null,
    growth: opts.growth === false ? null : growthFor({ engine, vaultLp }, { lp }, lpRealQ, market, 0, SLOT),
    ...(opts.growthRoom ? { growthRoom: opts.growthRoom } : {}),
  };
}
const input = (limits: MarketLimits, usd: number, extra: Partial<Parameters<typeof deriveTicketLimits>[0]> = {}) => ({
  limits, direction: "long" as const, sizeQ: sizeQ(usd), takerPosQ: 0n, takerOwner: null, leverage: 1, limitPriceE6: 0n, growth: limits.growth ?? null, ...extra,
});

describe("ticket quote wiring (fee row inputs, signed cap, Max sizing)", () => {
  beforeEach(() => __setDevnetV22ForTest(true));
  afterEach(() => __setDevnetV22ForTest(null));

  it("the fee channel is on for this market and the quote is charged (the fixture is a real fee-channel market)", () => {
    const t = deriveTicketLimits(input(limitsFor(), 100));
    expect(t.fee?.channel.enabled).toBe(true);
  });

  it("$1,255 long: the quote is 38 bps and the fee parts follow it (requestedBps rounds the quoted price UP: 39, never below the charge); $100: 24 -> 25 (the old quote said 23 for both)", () => {
    const L = limitsFor();
    const base = L.engine!.tradeFeeBaseBps;
    const big = deriveTicketLimits(input(L, 1255));
    expect(big.quote?.totalBps).toBe(38n);
    expect(big.fee?.requestedBps).toBe(39n);
    // the busy-side fee is its own part (this $1,255 order is on the crowded side of the LP): signed = base + quote + busy + margin
    expect(big.fee?.signedFeeBps).toBe(base + 39n + (big.fee?.utilFeeBps ?? 0n) + 2n);
    const small = deriveTicketLimits(input(L, 100));
    expect(small.quote?.totalBps).toBe(24n);
    expect(small.fee?.requestedBps).toBe(25n);
    expect(small.fee?.signedFeeBps).toBe(base + 25n + (small.fee?.utilFeeBps ?? 0n) + 2n);
  });

  it("the fee grows with size, so Max sizing's fee probe at a larger size is never below a smaller order's", () => {
    const L = limitsFor();
    const at = (usd: number) => deriveTicketLimits(input(L, usd)).fee!.requestedBps;
    expect(at(1255)).toBeGreaterThan(at(400));
    expect(at(400)).toBeGreaterThan(at(20) - 1n);
  });

  it("a reduce-only $2,000 close is priced as a REDUCE (quote 52 bps), the same order from flat is not (41)", () => {
    const L = limitsFor();
    const q = sizeQ(2000);
    // a long of 2x the size closing half... position long q, selling q (reduce): the matcher exempts it, so it prices the whole size
    const reduce = deriveTicketLimits(input(L, 2000, { direction: "short", takerPosQ: q }));
    expect(reduce.quote?.totalBps).toBe(52n);
    const flat = deriveTicketLimits(input(L, 2000, { direction: "short", takerPosQ: 0n }));
    expect(flat.quote?.totalBps).toBe(41n);
  });

  it("closeFeeBps (the close dialogs' fee) passes the growth view and the reduce flag: base + 53 (the 52 bp quote rounded up) for a $2,000 close", () => {
    const L = limitsFor();
    const base = L.engine!.tradeFeeBaseBps;
    const q = sizeQ(2000);
    expect(closeFeeBps(base, closeOrderInput(L, q, q, null, PX))).toBe(base + 53n);
    // without the growth view in the close input it would fall back to the context's depth (23 bps): the wiring is what this pins
    expect(closeFeeBps(base, closeOrderInput(L, q, q, null, PX))).toBeGreaterThan(base + 23n);
  });

  it("a growth asset whose view is not built yet (room loading / error) has NO quote: unknown, never the context's depth (LOW 4)", () => {
    for (const room of ["loading", "error"] as const) {
      const L = { ...limitsFor({ growth: false }), growthRoom: room };
      const t = deriveTicketLimits(input(L, 1255, { growth: null }));
      expect(t.quote).toBeNull();
      expect(t.fee).toBeNull();
      expect(closeFeeBps(L.engine!.tradeFeeBaseBps, closeOrderInput(L, sizeQ(1255), sizeQ(1255), null, PX))).toBe(L.engine!.tradeFeeBaseBps);
    }
    // a market with no growth record ("none") still quotes on the context, as before
    const none = { ...limitsFor({ growth: false }), growthRoom: "none" as const };
    expect(deriveTicketLimits(input(none, 100, { growth: null })).quote).not.toBeNull();
  });
});
