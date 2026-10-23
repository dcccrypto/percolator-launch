import { describe, it, expect } from "vitest";
import { tradableMarginAtoms, firstTradeDepositAtoms, fundDepositAtoms, engineOpenNeedAtoms, engineGateBps, type EngineGate } from "@/lib/first-trade";
import { computeTradingFee } from "@/lib/trading";
import { computeNotionalNative } from "@/lib/notional";
import { computeLimitPriceE6 } from "@/lib/slippage";

const U = 1_000_000n;
// The deposit the ticket would bundle for margin M on an account with A available (OrderTicket marginShort/fundNeededAtoms).
function bundledDeposit(M: bigint, A: bigint, lev: number, feeBps: bigint, W: bigint): bigint {
  const fee = computeTradingFee(computeNotionalNative(M, lev), feeBps);
  const short = M > A ? M - A : 0n;
  return short > 0n ? fundDepositAtoms(short, fee, W) : 0n;
}

describe("tradableMarginAtoms (Squid 2026-10-01: Available ignored wallet sim-USDC)", () => {
  it("an account with 200 in-market and 5,000 in the wallet can offer far more than 200", () => {
    const m = tradableMarginAtoms({ inMarketAvailable: 200n * U, walletAtoms: 5_000n * U, leverage100: 300, feeBps: 30n });
    expect(m).toBeGreaterThan(4_000n * U);
  });
  it("Max never asks for a deposit larger than the wallet (all leverages, fees, balances)", () => {
    for (const lev of [1, 2, 3, 5, 6.66, 10, 20])
      for (const feeBps of [0n, 5n, 20n, 30n, 100n])
        for (const A of [0n, 1n, 50n * U, 200n * U, 1_121_010_000n])
          for (const W of [0n, 1n, 10_000n, 3n * U, 500n * U, 9_999_990_000n]) {
            const M = tradableMarginAtoms({ inMarketAvailable: A, walletAtoms: W, leverage100: lev * 100, feeBps });
            expect(M).toBeGreaterThanOrEqual(A);
            if (M > A) expect(bundledDeposit(M, A, lev, feeBps, W)).toBeLessThanOrEqual(W);
          }
  });
  it("an empty wallet leaves exactly the in-market available", () => {
    expect(tradableMarginAtoms({ inMarketAvailable: 200n * U, walletAtoms: 0n, leverage100: 300, feeBps: 30n })).toBe(200n * U);
  });
  it("no account yet: the whole wallet (less a cent) backs margin; the buffer never shrinks it", () => {
    const m = tradableMarginAtoms({ inMarketAvailable: 0n, walletAtoms: 1_000n * U, leverage100: 100, feeBps: 0n });
    expect(m).toBeGreaterThanOrEqual(999_990_000n);
    expect(fundDepositAtoms(m, 0n, 1_000n * U)).toBeLessThanOrEqual(1_000n * U);
  });
  it("live 2026-10-02: a 10.1k wallet offers ~10.1k, not 10.1k / 1.1 = 9.18k", () => {
    const m = tradableMarginAtoms({ inMarketAvailable: 0n, walletAtoms: 10_100n * U, leverage100: 100, feeBps: 5n });
    expect(m).toBeGreaterThan(10_090n * U);
  });
  it("fundDepositAtoms: buffer only from spare wallet, never below the need, never above the wallet", () => {
    expect(fundDepositAtoms(100n * U, 1n * U, 1_000n * U)).toBe(firstTradeDepositAtoms(100n * U, 1n * U));
    expect(fundDepositAtoms(100n * U, 1n * U, 105n * U)).toBe(105n * U);
    expect(fundDepositAtoms(100n * U, 1n * U, 101n * U)).toBe(101n * U);
    expect(fundDepositAtoms(100n * U, 1n * U, 50n * U)).toBe(101n * U); // over wallet → ticket refuses
  });
});

// N1: Max at the market's max leverage must pass the ENGINE's gate, not just the ticket's margin.
// The engine charges the taker fee first, then needs equity >= max(ceil(notional x IM), floor) +
// the target-lag penalty, all on size x ITS effective price, while the ticket sizes off the feed.
describe("tradableMarginAtoms vs the engine's IM gate (fee, engine price, target lag)", () => {
  const D = 150_000_000n; // display price, e6
  const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
  type Px = { eff: bigint; target: bigint };
  // What the ticket bundles for margin M (OrderTicket marginNeed / engineNeed / marginShort / fundFee).
  function ticketDeposit(M: bigint, A: bigint, lev: number, imBps: bigint, feeBps: bigint, gate: EngineGate, W: bigint): bigint {
    const notional = computeNotionalNative(M, lev);
    const need = engineOpenNeedAtoms(notional, imBps, feeBps, gate);
    const marginNeed = need.im + need.lag > M ? need.im + need.lag : M;
    const engineNeed = need.im + need.lag + need.fee;
    if (marginNeed <= A && engineNeed <= A) return 0n;
    const short = marginNeed > A ? marginNeed - A : 0n;
    const fee = computeTradingFee(notional, feeBps);
    return fundDepositAtoms(short, need.fee > fee ? need.fee : fee, W);
  }
  // The engine (v16): Q from the display feed; fee = checked_fee_bps(trade_fee_notional_ceil(Q, exec));
  // IM = margin_requirement(risk_notional_ceil(Q, eff)) + risk_notional_ceil(Q, adverse lag).
  // `exec`: the matcher's fill price, which the fee is charged on (v16.rs:18667); default the effective price.
  function enginePasses(M: bigint, account: bigint, lev: number, imBps: bigint, feeBps: bigint, px: Px, side: "long" | "short", exec: bigint = px.eff): boolean {
    const Q = (computeNotionalNative(M, lev) * 1_000_000n) / D;
    const fee = ceilDiv(ceilDiv(Q * exec, 1_000_000n) * feeBps, 10_000n);
    const im = ceilDiv(ceilDiv(Q * px.eff, 1_000_000n) * imBps, 10_000n);
    const adverse = side === "long" ? (px.target < px.eff ? px.eff - px.target : 0n) : px.target > px.eff ? px.target - px.eff : 0n;
    return account - fee >= im + ceilDiv(Q * adverse, 1_000_000n);
  }
  const maxLev = (imBps: bigint) => Math.floor((10000 / Number(imBps)) * 100) / 100; // OrderTicket :443
  const at = (effBps: bigint, targetBps: bigint): Px => ({ eff: (D * effBps) / 10_000n, target: (D * targetBps) / 10_000n });
  const PRICES: Px[] = [
    at(10_000n, 10_000n), // engine = feed
    at(10_020n, 10_020n), // engine 0.2% above the feed
    at(10_050n, 10_000n), // effective above, catching DOWN to the feed (a long pays the lag)
    at(10_000n, 10_050n), // effective at the feed, catching UP (a short pays the lag; it can step up)
    at(9_980n, 9_900n), // engine below the feed
    at(10_010n, 9_950n),
  ];

  it("Max at max leverage is never refused: every live IM / fee, both sides, engine price above / below / lagging", () => {
    for (const imBps of [1000n, 1250n, 1500n, 2000n, 2500n, 4000n])
      for (const feeBps of [5n, 10n, 20n, 30n])
        for (const px of PRICES)
          for (const side of ["long", "short"] as const)
            for (const A of [0n, 2n * U, 100n * U, 9_154_321_987n])
              for (const W of [0n, 3n * U, 500n * U]) {
                const lev = maxLev(imBps);
                const gate = engineGateBps(D, { effectivePriceE6: px.eff, targetPriceE6: px.target }, side);
                const M = tradableMarginAtoms({ inMarketAvailable: A, walletAtoms: W, leverage100: lev * 100, feeBps, initialMarginBps: imBps, gate });
                if (M === 0n) continue;
                const dep = ticketDeposit(M, A, lev, imBps, feeBps, gate, W);
                const ctx = `IM ${imBps} fee ${feeBps} eff ${px.eff} target ${px.target} ${side} A ${A} W ${W} M ${M} dep ${dep}`;
                expect(dep, ctx).toBeLessThanOrEqual(W);
                expect(enginePasses(M, A + dep, lev, imBps, feeBps, px, side), ctx).toBe(true);
                // ...and still once the effective price has stepped to its target before landing.
                expect(enginePasses(M, A + dep, lev, imBps, feeBps, { eff: px.target, target: px.target }, side), ctx).toBe(true);
                // #3554 review: a long's fee is charged at the fill, which the matcher may put anywhere up to the limit the
                // ticket sends (effective x 1.05, lib/open-limit.ts). Max must survive the worst one.
                if (side === "long") {
                  const worstExec = computeLimitPriceE6({ markE6: px.eff, size: 1n });
                  expect(enginePasses(M, A + dep, lev, imBps, feeBps, px, side, worstExec), `${ctx} exec ${worstExec}`).toBe(true);
                }
              }
  });

  it("#3554 review: a long Max at max leverage survives the matcher filling above the effective price (fee on exec, up to the limit)", () => {
    // 10x (IM 10%), fee 30 bps, engine = feed, in-market only. The limit the ticket sends is effective x 1.05 (#3462).
    const imBps = 1000n, feeBps = 30n, lev = maxLev(imBps), A = 100n * U;
    const px = at(10_000n, 10_000n);
    const limit = computeLimitPriceE6({ markE6: px.eff, size: 1n });
    expect(limit).toBe((D * 10_500n) / 10_000n);
    const gate = engineGateBps(D, { effectivePriceE6: px.eff, targetPriceE6: px.target }, "long");
    expect(gate.feeRatioBps).toBe(10_500n);
    const M = tradableMarginAtoms({ inMarketAvailable: A, walletAtoms: 0n, leverage100: lev * 100, feeBps, initialMarginBps: imBps, gate });
    for (const exec of [px.eff, (px.eff * 10_200n) / 10_000n, limit])
      expect(enginePasses(M, A, lev, imBps, feeBps, px, "long", exec), `exec ${exec}`).toBe(true);
    // Control: the fee priced at the effective price only (the PR as submitted) is refused 49 by a fill at the limit.
    const atEff = tradableMarginAtoms({ inMarketAvailable: A, walletAtoms: 0n, leverage100: lev * 100, feeBps, initialMarginBps: imBps, gate: { ratioBps: gate.ratioBps, lagBps: gate.lagBps } });
    expect(atEff).toBeGreaterThan(M);
    expect(enginePasses(atEff, A, lev, imBps, feeBps, px, "long", limit)).toBe(false);
    // A short's exec is bounded below by its limit, not above: its fee keeps the engine ratio.
    expect(engineGateBps(D, { effectivePriceE6: px.eff, targetPriceE6: px.target }, "short").feeRatioBps).toBe(10_000n);
  });

  it("the live case: 100 free, empty wallet, 10x, fee 30 bps — Max fits the fee instead of using all 100", () => {
    const M = tradableMarginAtoms({ inMarketAvailable: 100n * U, walletAtoms: 0n, leverage100: 1000, feeBps: 30n, initialMarginBps: 1000n });
    expect(M).toBe(97_087_369n); // (100 - 9 atoms) / (1 + 10 x 0.003): the fee is on 10x the margin
    expect(enginePasses(100n * U, 100n * U, 10, 1000n, 30n, at(10_000n, 10_000n), "long")).toBe(false); // the old Max
    expect(enginePasses(M, 100n * U, 10, 1000n, 30n, at(10_000n, 10_000n), "long")).toBe(true);
  });

  it("below max leverage nothing shrinks: the engine's slack already covers the fee and the price gap", () => {
    const gate = engineGateBps(D, { effectivePriceE6: (D * 10_200n) / 10_000n, targetPriceE6: (D * 10_200n) / 10_000n }, "long");
    for (const g of [undefined, gate])
      expect(tradableMarginAtoms({ inMarketAvailable: 100n * U, walletAtoms: 0n, leverage100: 500, feeBps: 30n, initialMarginBps: 1000n, gate: g })).toBe(100n * U);
  });
});

describe("engineGateBps", () => {
  const eng = (eff: bigint, target: bigint) => ({ effectivePriceE6: eff, targetPriceE6: target });
  it("an engine price at or below the feed with no lag adds nothing", () => {
    // A long's fee still prices at its limit (effective x 1.05); a short's at the ratio.
    expect(engineGateBps(150_000_000n, eng(150_000_000n, 150_000_000n), "long")).toEqual({ ratioBps: 10_000n, lagBps: 0n, feeRatioBps: 10_500n });
    expect(engineGateBps(150_000_000n, eng(140_000_000n, 140_000_000n), "short")).toEqual({ ratioBps: 10_000n, lagBps: 0n, feeRatioBps: 10_000n });
    // An engine 10% under the feed: the long's limit (0.9 x 1.05 = 0.945 of the feed) is below the feed too.
    expect(engineGateBps(150_000_000n, eng(135_000_000n, 135_000_000n), "long").feeRatioBps).toBe(10_000n);
  });
  it("above the feed: the ratio, rounded up, from the higher of effective and target", () => {
    expect(engineGateBps(150_000_000n, eng(150_150_000n, 150_150_000n), "long").ratioBps).toBe(10_010n);
    expect(engineGateBps(150_000_000n, eng(150_000_000n, 150_000_001n), "long").ratioBps).toBe(10_001n);
  });
  it("target lag is charged to the side it hurts, as the whole gap: a long when the target is below, a short when above", () => {
    expect(engineGateBps(150_000_000n, eng(150_000_000n, 148_500_000n), "long").lagBps).toBe(100n);
    expect(engineGateBps(150_000_000n, eng(150_000_000n, 148_500_000n), "short").lagBps).toBe(0n);
    expect(engineGateBps(150_000_000n, eng(150_000_000n, 151_500_000n), "short").lagBps).toBe(100n);
    expect(engineGateBps(150_000_000n, eng(150_000_000n, 151_500_000n), "long").lagBps).toBe(0n);
  });
  it("no engine view, no feed price, or a garbage engine price: nothing", () => {
    const none = { ratioBps: 10_000n, lagBps: 0n };
    expect(engineGateBps(150_000_000n, null, "long")).toEqual(none);
    expect(engineGateBps(null, eng(160_000_000n, 160_000_000n), "long")).toEqual(none);
    expect(engineGateBps(150_000_000n, eng(0n, 0n), "short")).toEqual(none);
    expect(engineGateBps(150_000_000n, {} as never, "long")).toEqual(none);
  });
});
