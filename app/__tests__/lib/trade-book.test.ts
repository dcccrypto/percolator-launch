/** M7 (M-2): the result of a trade over its WHOLE lifetime: price PnL on booked prices minus every fee_atoms (which carry the spread). */
import { beforeEach, describe, expect, it } from "vitest";
import { applyFill as applyFillRaw, loadBook, loadBookByWallet, recordFill as recordFillRaw, reconcile, type Book, type FillIn } from "@/lib/trade-book";

const TOKEN = 1_000_000n; // 1 token in engine units

// The funding counters AFTER a fill as the app samples them: flat = no leg, otherwise one. Zero funding unless a test says otherwise, so the
// price/fee tests below keep their figures; the funding tests further down pass an explicit sample.
const withFunding = (before: bigint, f: FillIn, netPaid = 0n): FillIn => ({ ...f, funding: f.funding ?? { netPaid, legs: before + f.q === 0n ? 0 : 1 } });
const applyFill = (b: Book | null, f: FillIn) => applyFillRaw(b, withFunding(b?.q ?? 0n, f));
const recordFill = (w: string, sl: string, p: string, f: FillIn, before: bigint) => recordFillRaw(w, sl, p, withFunding(before, f), before);

describe("applyFill: lifetime result", () => {
  it("reviewer counter-example 1: deposit 100, open costs 0.106 (live-like), the mark gains +0.150, the close costs 0.100 => -0.056, NOT +0.05", () => {
    const open = applyFill(null, { q: TOKEN, bookedPriceE6: 100_000_000n, feeAtoms: 106_043n });
    expect(open.closedResult).toBeNull();
    const close = applyFill(open.book, { q: -TOKEN, bookedPriceE6: 100_150_000n, feeAtoms: 100_000n });
    expect(close.book).toBeNull();
    expect(close.closedResult).toBe(150_000n - 106_043n - 100_000n); // -56,043
    expect(close.closedResult! < 0n).toBe(true);
  });
  it("reviewer counter-example 2: a crank had already settled a -10 loss, then the mark rebounds +2 before the close: booked prices say -8 minus fees, not +1.9", () => {
    const open = applyFill(null, { q: TOKEN, bookedPriceE6: 100_000_000n, feeAtoms: 100_000n });
    // the close books at the mark 92 (100 - 10 + 2); the crank's interim settlement of -10 is irrelevant to booked-price PnL
    const close = applyFill(open.book, { q: -TOKEN, bookedPriceE6: 92_000_000n, feeAtoms: 100_000n });
    expect(close.closedResult).toBe(-8_000_000n - 200_000n);
  });
  it("a short: price falling is a gain", () => {
    const o = applyFill(null, { q: -2n * TOKEN, bookedPriceE6: 50_000_000n, feeAtoms: 10_000n });
    const c = applyFill(o.book, { q: 2n * TOKEN, bookedPriceE6: 49_000_000n, feeAtoms: 10_000n });
    expect(c.closedResult).toBe(2_000_000n - 20_000n);
  });
  it("adds average the booked price and keep every fee; a partial close leaves the rest open, the final close reports the whole trade", () => {
    let b = applyFill(null, { q: TOKEN, bookedPriceE6: 100_000_000n, feeAtoms: 1_000n }).book;
    b = applyFill(b, { q: TOKEN, bookedPriceE6: 110_000_000n, feeAtoms: 1_000n }).book;
    expect(b).toMatchObject({ q: 2n * TOKEN, avgE6: 105_000_000n, fees: 2_000n });
    const part = applyFill(b, { q: -TOKEN, bookedPriceE6: 120_000_000n, feeAtoms: 1_000n });
    expect(part.closedResult).toBeNull();
    expect(part.book).toMatchObject({ q: TOKEN, pnl: 15_000_000n, fees: 3_000n });
    const fin = applyFill(part.book, { q: -TOKEN, bookedPriceE6: 100_000_000n, feeAtoms: 1_000n });
    expect(fin.closedResult).toBe(15_000_000n - 5_000_000n - 4_000n);
  });
  it("a flip closes one trade and opens the next with the rest of the fee", () => {
    const o = applyFill(null, { q: TOKEN, bookedPriceE6: 100_000_000n, feeAtoms: 1_000n });
    const f = applyFill(o.book, { q: -3n * TOKEN, bookedPriceE6: 101_000_000n, feeAtoms: 3_000n });
    expect(f.closedResult).toBe(1_000_000n - 1_000n - 1_000n);
    expect(f.book).toMatchObject({ q: -2n * TOKEN, avgE6: 101_000_000n, fees: 2_000n, pnl: 0n });
  });
});

describe("reconcile / recordFill: a result is only claimed for a trade whose whole life was seen (size match)", () => {
  beforeEach(() => localStorage.clear());
  const open = () => recordFill("W", "S", "P", { q: TOKEN, bookedPriceE6: 100_000_000n, feeAtoms: 106_043n }, 0n);
  it("open then close through the stored book", () => {
    expect(open()).toBeNull();
    expect(loadBook("W", "S", "P")?.q).toBe(TOKEN);
    expect(recordFill("W", "S", "P", { q: -TOKEN, bookedPriceE6: 100_150_000n, feeAtoms: 100_000n }, TOKEN)).toBe(-56_043n);
    expect(loadBook("W", "S", "P")).toBeNull();
  });
  it("probe A: open 1, ADD 1 from existing capital (no deposit, so the wrapper's matcher sequence does not move), then close 2: the WHOLE trade is reported", () => {
    open();
    expect(recordFill("W", "S", "P", { q: TOKEN, bookedPriceE6: 110_000_000n, feeAtoms: 1_000n }, TOKEN)).toBeNull();
    expect(loadBook("W", "S", "P")).toMatchObject({ q: 2n * TOKEN, avgE6: 105_000_000n, fees: 107_043n });
    // 2 tokens from 105 avg to 108: +6.0 price PnL, minus 106,043 + 1,000 + 2,000 fees
    expect(recordFill("W", "S", "P", { q: -2n * TOKEN, bookedPriceE6: 108_000_000n, feeAtoms: 2_000n }, 2n * TOKEN)).toBe(6_000_000n - 109_043n);
  });
  it("probe C / F3: the long on the book was closed on another device and this ticket still RENDERS +1, but the MEASURED size before the trade is 0: no fabricated result, and the new short gets its own fresh book", () => {
    open();
    expect(recordFill("W", "S", "P", { q: -TOKEN, bookedPriceE6: 99_000_000n, feeAtoms: 1_000n }, 0n)).toBeNull();
    expect(loadBook("W", "S", "P")).toMatchObject({ q: -TOKEN, avgE6: 99_000_000n, fees: 1_000n });
  });
  it("DOCUMENTED RESIDUAL (probe B): a same-size close + reopen made elsewhere cannot be told apart from the size alone, so the result is computed on the stale book. The copy says the figure counts trades made on this device and another device can make it wrong. (The wrapper's portfolio matcher sequence moves only on deposit / withdraw, so it cannot detect trades.)", () => {
    open();
    expect(recordFill("W", "S", "P", { q: -TOKEN, bookedPriceE6: 61_000_000n, feeAtoms: 1_000n }, TOKEN)).toBe(-39_000_000n - 107_043n);
  });
  it("NEGATIVE: the position was opened elsewhere (no book, chain not flat): no result, nothing claimed", () => {
    expect(recordFill("W", "S", "P", { q: -TOKEN, bookedPriceE6: 100_000_000n, feeAtoms: 1n }, TOKEN)).toBeNull();
  });
  it("NEGATIVE: the stored book no longer matches the chain size (ADL / another device): dropped, no result", () => {
    recordFill("W", "S", "P", { q: 2n * TOKEN, bookedPriceE6: 100_000_000n, feeAtoms: 1n }, 0n);
    expect(reconcile(loadBook("W", "S", "P"), TOKEN)).toBeNull();
    expect(recordFill("W", "S", "P", { q: -TOKEN, bookedPriceE6: 1n, feeAtoms: 1n }, TOKEN)).toBeNull();
    expect(loadBook("W", "S", "P")).toBeNull();
  });
  it("books are per wallet, market and portfolio", () => {
    recordFill("W", "S", "P1", { q: TOKEN, bookedPriceE6: 1n, feeAtoms: 0n }, 0n);
    expect(loadBook("W", "S", "P2")).toBeNull();
    expect(loadBook("W2", "S", "P1")).toBeNull();
  });
});


describe("r10 owner decision 1: the trade result includes funding", () => {
  const open = (netPaid: bigint) => applyFillRaw(null, { q: TOKEN, bookedPriceE6: 100_000_000n, feeAtoms: 1_000n, funding: { netPaid, legs: 1 } });
  it("the funding counter at open is the base; the close subtracts what the chain moved since (paid reduces the result)", () => {
    const o = open(5_000n);
    expect(o.book?.fundingBase).toBe(5_000n);
    const c = applyFillRaw(o.book, { q: -TOKEN, bookedPriceE6: 100_000_000n, feeAtoms: 1_000n, funding: { netPaid: 5_000n + 3_007n, legs: 0 } });
    expect(c.closedFunding).toBe(3_007n);
    expect(c.closedResult).toBe(-2_000n - 3_007n);
  });
  it("funding RECEIVED (the counter fell) adds to the result", () => {
    const o = open(5_000n);
    const c = applyFillRaw(o.book, { q: -TOKEN, bookedPriceE6: 100_000_000n, feeAtoms: 1_000n, funding: { netPaid: 4_000n, legs: 0 } });
    expect(c.closedFunding).toBe(-1_000n);
    expect(c.closedResult).toBe(-2_000n + 1_000n);
  });
  it("adds and a partial close carry the base; only the finishing fill reads the counter", () => {
    let b = open(10n).book;
    b = applyFillRaw(b, { q: TOKEN, bookedPriceE6: 100_000_000n, feeAtoms: 0n, funding: { netPaid: 400n, legs: 1 } }).book;
    expect(b?.fundingBase).toBe(10n);
    const part = applyFillRaw(b, { q: -TOKEN, bookedPriceE6: 100_000_000n, feeAtoms: 0n });
    expect(part.closedResult).toBeNull();
    expect(part.book?.fundingBase).toBe(10n);
    const fin = applyFillRaw(part.book, { q: -TOKEN, bookedPriceE6: 100_000_000n, feeAtoms: 0n, funding: { netPaid: 910n, legs: 0 } });
    expect(fin.closedFunding).toBe(900n);
    expect(fin.closedResult).toBe(-1_000n - 900n);
  });
  it("a flip ends the old trade with its funding and starts the new one from the same sample", () => {
    const o = open(0n);
    const f = applyFillRaw(o.book, { q: -3n * TOKEN, bookedPriceE6: 100_000_000n, feeAtoms: 3_000n, funding: { netPaid: 250n, legs: 1 } });
    expect(f.closedFunding).toBe(250n);
    expect(f.closedResult).toBe(-1_000n - 1_000n - 250n);
    expect(f.book?.fundingBase).toBe(250n);
  });
  it("NEGATIVE: the counters were not read at the close (or at the open): the result is UNKNOWN, never one that leaves funding out", () => {
    const o = open(0n);
    expect(applyFillRaw(o.book, { q: -TOKEN, bookedPriceE6: 101_000_000n, feeAtoms: 1_000n }).closedResult).toBeNull();
    const noBase = applyFillRaw(null, { q: TOKEN, bookedPriceE6: 100_000_000n, feeAtoms: 1_000n });
    expect(noBase.book?.fundingBase).toBeNull();
    expect(applyFillRaw(noBase.book, { q: -TOKEN, bookedPriceE6: 101_000_000n, feeAtoms: 1_000n, funding: { netPaid: 9n, legs: 0 } }).closedResult).toBeNull();
  });
  it("NEGATIVE: a sample showing another leg open in the portfolio (leg count does not match) is not used", () => {
    const o = open(0n);
    expect(applyFillRaw(o.book, { q: -TOKEN, bookedPriceE6: 101_000_000n, feeAtoms: 1_000n, funding: { netPaid: 9n, legs: 1 } }).closedResult).toBeNull();
  });
  it("persists the base; a book saved before r10 (no base) loads with a null base; loadBookByWallet finds the one book", () => {
    localStorage.clear();
    recordFillRaw("W", "S", "P", { q: TOKEN, bookedPriceE6: 1n, feeAtoms: 0n, funding: { netPaid: 77n, legs: 1 } }, 0n);
    expect(loadBook("W", "S", "P")?.fundingBase).toBe(77n);
    expect(loadBookByWallet("W", "S")).toMatchObject({ q: TOKEN, fundingBase: 77n });
    expect(loadBookByWallet("W", "OTHER")).toBeNull();
    localStorage.setItem("perc:tradebook:v1:W:S:P", JSON.stringify({ q: "1", avgE6: "1", fees: "0", pnl: "0" }));
    expect(loadBook("W", "S", "P")?.fundingBase).toBeNull();
  });
});
