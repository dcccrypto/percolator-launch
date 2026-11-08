/** M7 (M-2): the result of a trade over its WHOLE lifetime: price PnL on booked prices minus every fee_atoms (which carry the spread). */
import { beforeEach, describe, expect, it } from "vitest";
import { applyFill, loadBook, recordFill, reconcile } from "@/lib/trade-book";

const TOKEN = 1_000_000n; // 1 token in engine units

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

describe("reconcile / recordFill: a result is only claimed for a trade whose whole life was seen (size AND chain anchor)", () => {
  beforeEach(() => localStorage.clear());
  const open = (seq: bigint | null) => recordFill("W", "S", "P", { q: TOKEN, bookedPriceE6: 100_000_000n, feeAtoms: 106_043n }, 0n, { preSeq: null, postSeq: seq });
  it("open then close through the stored book: the close finds exactly the sequence the open left", () => {
    expect(open(5n)).toBeNull();
    expect(loadBook("W", "S", "P")).toMatchObject({ q: TOKEN, seq: 5n });
    expect(recordFill("W", "S", "P", { q: -TOKEN, bookedPriceE6: 100_150_000n, feeAtoms: 100_000n }, TOKEN, { preSeq: 5n, postSeq: 6n })).toBe(-56_043n);
    expect(loadBook("W", "S", "P")).toBeNull();
  });
  it("N-4 probe: the position was closed and REOPENED at the same size elsewhere (the sequence moved): size matches, the anchor does not: no result", () => {
    open(5n);
    // unseen: close (seq 6) and reopen 1 @ 60 (seq 7); here it is closed @ 61 and the chain shows preSeq 7
    expect(recordFill("W", "S", "P", { q: -TOKEN, bookedPriceE6: 61_000_000n, feeAtoms: 1_000n }, TOKEN, { preSeq: 7n, postSeq: 8n })).toBeNull();
    expect(loadBook("W", "S", "P")).toBeNull();
  });
  it("an unknown anchor on either side is not trusted", () => {
    open(5n);
    expect(reconcile(loadBook("W", "S", "P"), TOKEN, null)).toBeNull();
    open(null);
    expect(reconcile(loadBook("W", "S", "P"), TOKEN, 5n)).toBeNull();
  });
  it("NEGATIVE: the position was opened elsewhere (no book, chain not flat): no result, nothing claimed", () => {
    expect(recordFill("W", "S", "P", { q: -TOKEN, bookedPriceE6: 100_000_000n, feeAtoms: 1n }, TOKEN, { preSeq: 5n, postSeq: 6n })).toBeNull();
  });
  it("NEGATIVE: the stored book no longer matches the chain size (ADL / another device): dropped, no result", () => {
    recordFill("W", "S", "P", { q: 2n * TOKEN, bookedPriceE6: 100_000_000n, feeAtoms: 1n }, 0n, { preSeq: null, postSeq: 5n });
    expect(reconcile(loadBook("W", "S", "P"), TOKEN, 5n)).toBeNull();
    expect(recordFill("W", "S", "P", { q: -TOKEN, bookedPriceE6: 1n, feeAtoms: 1n }, TOKEN, { preSeq: 5n, postSeq: 6n })).toBeNull();
    expect(loadBook("W", "S", "P")).toBeNull();
  });
  it("books are per wallet, market and portfolio", () => {
    recordFill("W", "S", "P1", { q: TOKEN, bookedPriceE6: 1n, feeAtoms: 0n }, 0n, { preSeq: null, postSeq: 1n });
    expect(loadBook("W", "S", "P2")).toBeNull();
    expect(loadBook("W2", "S", "P1")).toBeNull();
  });
  it("F3: the render-time position is stale (the long on the book was closed on another device; this ticket still shows it) and a short is opened here: the anchor moved, so the book is dropped and NO fabricated result is recorded", () => {
    open(5n); // long 1 on the book, sequence 5
    // elsewhere: the long is closed (sequence 6). Here: a short 1 opens (sequence 7). The ticket's stale existingPositionSize is still +1.
    // The open path derives preSeq = postSeq - legs = 6, not the 5 the book holds.
    expect(recordFill("W", "S", "P", { q: -TOKEN, bookedPriceE6: 99_000_000n, feeAtoms: 1_000n }, TOKEN, { preSeq: 6n, postSeq: 7n })).toBeNull();
    expect(loadBook("W", "S", "P")).toBeNull();
  });
});
