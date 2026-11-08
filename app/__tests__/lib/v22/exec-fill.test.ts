/**
 * M7: what a v2.2 fill COST. FILL `price_e6` is the BOOKED price = the asset's effective_price (the MARK); the matcher's spread is
 * charged through fee_atoms (fee channel). The price the trader effectively paid is booked +/- (fee - base fee)/|q|. Real decoded
 * council transactions (seats/trader/out): open 27o3fM4W and close 3fcYeu1m.
 */
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import clipped from "../../fixtures/v22-clipped-fill-tx.json";
import open from "../../fixtures/v22-sol-open-27o3fM4W.json";
import close from "../../fixtures/v22-sol-close-3fcYeu1m.json";
import { fillEventLogs } from "../../helpers/fill-event-fixture";
import { effectivePriceE6, execFillFromLogs, readExecFill, spreadFeeAtoms } from "@/lib/v22/exec-fill";

const WRAPPER = new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM");
const SWORDCAT = new PublicKey("6fonYScxUpeN8782wm1DQMPJVZj5vUGXnKg75GTRSBUF");
const OTHER = new PublicKey("11111111111111111111111111111111");
const SOL_WRAPPER = new PublicKey("5NGgnU2j315Ci2tso8VJDEthaVExuiKG3tn4xnur28xe");
const SOL_MARKET = new PublicKey("G2wipz3k28TyVqdKnzpTcEGWkB4bHJXwNrCbi4DVgPez");
const SOL_PORTFOLIO = new PublicKey("5dsrhZiXunvXcFbCzdJ9Qg5Lv3eX4SGyaBA6NZ3SaoKh");
const BASE_BPS = 30n;

describe("real council transactions: the effective price is NOT the bare mark", () => {
  it("open 27o3fM4W: booked 89.535739 (mark), fee 106,043 on 20.0088 USDC = 30 base + ~23 spread bps => effective 89.7416 (~ the 89.741672 the council measured)", () => {
    const f = execFillFromLogs(open.logMessages, SOL_WRAPPER, { market: SOL_MARKET, taker: SOL_PORTFOLIO })!;
    expect(f.bookedPriceE6).toBe(89_535_739n);
    expect(f.quotedPriceE6).toBe(89_741_672n); // the matcher's own quote: labelled data, never the price
    expect(f.feeAtoms).toBe(106_043n);
    expect(f.executedQ).toBe(223_463n);
    expect(spreadFeeAtoms(f, BASE_BPS)).toBe(46_020n);
    const eff = effectivePriceE6(f, BASE_BPS)!;
    expect(eff).not.toBe(f.bookedPriceE6);
    expect(eff).toBe(89_741_679n);
    // within 0.1 cent of the quoted 89.741672 (the fee is rounded to whole atoms)
    expect(Number(eff - 89_741_672n)).toBeGreaterThan(-100);
    expect(Number(eff - 89_741_672n)).toBeLessThan(100);
  });
  it("close 3fcYeu1m (a sell): booked 89.607382, fee 102,123 => the trader RECEIVED less, ~89.4192 (matcher quote 89.419206)", () => {
    const f = execFillFromLogs(close.logMessages, SOL_WRAPPER, { market: SOL_MARKET, taker: SOL_PORTFOLIO })!;
    expect(f.bookedPriceE6).toBe(89_607_382n);
    expect(f.executedQ).toBe(-223_463n);
    const eff = effectivePriceE6(f, BASE_BPS)!;
    expect(eff < f.bookedPriceE6).toBe(true);
    expect(Number(eff - 89_419_206n)).toBeGreaterThan(-100);
    expect(Number(eff - 89_419_206n)).toBeLessThan(100);
  });
  it("without a known base fee there is no honest split: null, never the mark", () => {
    const f = execFillFromLogs(open.logMessages, SOL_WRAPPER, { market: SOL_MARKET })!;
    expect(effectivePriceE6(f, null)).toBeNull();
    expect(effectivePriceE6(f, undefined)).toBeNull();
  });
  it("a fee at or under the base fee adds no spread: effective = booked", () => {
    const f = execFillFromLogs(open.logMessages, SOL_WRAPPER, { market: SOL_MARKET })!;
    expect(effectivePriceE6(f, 100n)).toBe(f.bookedPriceE6);
  });
});

describe("L-2: only the user's own portfolio's FILL", () => {
  it("another taker's fill in the same tx is not averaged in; naming the right taker keeps ours", () => {
    expect(execFillFromLogs(open.logMessages, SOL_WRAPPER, { market: SOL_MARKET, taker: OTHER })).toBeNull();
    expect(execFillFromLogs(open.logMessages, SOL_WRAPPER, { market: SOL_MARKET, taker: SOL_PORTFOLIO })?.taker.toBase58()).toBe(SOL_PORTFOLIO.toBase58());
  });
});

describe("execFillFromLogs (decoder behaviour)", () => {
  it("real devnet clipped tx: reads the booked price, the matcher quote separately, and the executed size", () => {
    const f = execFillFromLogs(clipped.logMessages, WRAPPER, { market: SWORDCAT });
    expect(f).toMatchObject({ bookedPriceE6: 26_999_002n, quotedPriceE6: 27_115_098n, executedQ: 9_525_082n, feeAtoms: 2_545_961n });
  });
  it("a short fill keeps its sign; the booked price is the price_e6 slot, the quote the quoted slot", () => {
    const logs = fillEventLogs(WRAPPER, SWORDCAT, [{ flags: 8, requestedQ: -2_000_000n, executedQ: -2_000_000n, priceE6: 89_535_739n, quotedPriceE6: 89_741_672n }]);
    expect(execFillFromLogs(logs, WRAPPER, { market: SWORDCAT })).toMatchObject({ bookedPriceE6: 89_535_739n, quotedPriceE6: 89_741_672n, executedQ: -2_000_000n });
  });
  it("several legs of one batch average by executed size; zero-size records do not count", () => {
    const logs = fillEventLogs(WRAPPER, SWORDCAT, [
      { flags: 8, requestedQ: 1_000_000n, executedQ: 1_000_000n, priceE6: 90_000_000n },
      { flags: 8, requestedQ: 3_000_000n, executedQ: 3_000_000n, priceE6: 94_000_000n },
      { flags: 12, requestedQ: 5_000_000n, executedQ: 0n, priceE6: 1n },
    ]);
    expect(execFillFromLogs(logs, WRAPPER, { market: SWORDCAT })?.bookedPriceE6).toBe(93_000_000n);
  });
  it("NEGATIVE: another market, another wrapper, a failed tx, missing logs, an all-zero fill: null", () => {
    expect(execFillFromLogs(clipped.logMessages, WRAPPER, { market: OTHER })).toBeNull();
    expect(execFillFromLogs(clipped.logMessages, new PublicKey("11111111111111111111111111111112"), { market: SWORDCAT })).toBeNull();
    expect(execFillFromLogs(clipped.logMessages, WRAPPER, { market: SWORDCAT, succeeded: false })).toBeNull();
    expect(execFillFromLogs(null, WRAPPER, { market: SWORDCAT })).toBeNull();
    expect(execFillFromLogs(fillEventLogs(WRAPPER, SWORDCAT, [{ flags: 12, requestedQ: 1n, executedQ: 0n }]), WRAPPER, { market: SWORDCAT })).toBeNull();
  });
  it("two assets in one tx and no asset named: ambiguous, null; with the asset named: that asset's price", () => {
    const logs = fillEventLogs(WRAPPER, SWORDCAT, [
      { flags: 8, requestedQ: 1_000_000n, executedQ: 1_000_000n, priceE6: 90_000_000n, assetIndex: 0 },
      { flags: 8, requestedQ: 1_000_000n, executedQ: 1_000_000n, priceE6: 5_000_000n, assetIndex: 1 },
    ]);
    expect(execFillFromLogs(logs, WRAPPER, { market: SWORDCAT })).toBeNull();
    expect(execFillFromLogs(logs, WRAPPER, { market: SWORDCAT, assetIndex: 1 })?.bookedPriceE6).toBe(5_000_000n);
  });
});

describe("readExecFill", () => {
  it("retries a read that is not there yet", async () => {
    const getTransaction = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ meta: { err: null, logMessages: clipped.logMessages } });
    const r = await readExecFill({ getTransaction } as never, clipped.sig, WRAPPER, { market: SWORDCAT }, async () => {});
    expect(r?.bookedPriceE6).toBe(26_999_002n);
    expect(getTransaction).toHaveBeenCalledTimes(2);
  });
  it("null (unknown) when the RPC never answers: never a guess", async () => {
    const getTransaction = vi.fn().mockRejectedValue(new Error("boom"));
    expect(await readExecFill({ getTransaction } as never, "sigX", WRAPPER, { market: SWORDCAT }, async () => {}, 3)).toBeNull();
  });
});
