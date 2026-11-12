/**
 * Council r9 Risk MED: the growth busy-side fee paid at open is stored with the saved entry, blends size-weighted on an add, scales on a
 * reduce, and is unknown (never zero) whenever the entry, the record or the prior amount is unknown or not current.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { applyFill } from "@/lib/trade-book";
import { busyFeeAfterTrade, entryRecordCurrent, getCurrentEntry, getSavedEntry, saveEntryPrice } from "@/lib/entry-price";

const SLAB = "CjdnH8fTmxNMsuUevBt9VjSi87E3ESTcuWuoSrjUjvXE";
const W = "11111111111111111111111111111111";
const Q = 1_000_000n;

beforeEach(() => localStorage.clear());

describe("storage", () => {
  it("round-trips the amount, including a measured zero; absent = null (unknown)", () => {
    saveEntryPrice(SLAB, 0, 83_000_000n, 2, W, 10n * Q, { busyFeeAtoms: 2_989_999n });
    expect(getSavedEntry(SLAB, 0, W)!.busyFeeAtoms).toBe(2_989_999n);
    saveEntryPrice(SLAB, 0, 83_000_000n, 2, W, 10n * Q, { busyFeeAtoms: 0n });
    expect(getSavedEntry(SLAB, 0, W)!.busyFeeAtoms).toBe(0n);
    saveEntryPrice(SLAB, 0, 83_000_000n, 2, W, 10n * Q);
    expect(getSavedEntry(SLAB, 0, W)!.busyFeeAtoms).toBeNull();
    localStorage.setItem(`perc:entry:${SLAB}:0:${W}`, JSON.stringify({ entryPriceE6: "83000000", sizeQ: "5", busyFeeAtoms: "-4", timestamp: Date.now() }));
    expect(getSavedEntry(SLAB, 0, W)!.busyFeeAtoms).toBeNull();
    localStorage.setItem(`perc:entry:${SLAB}:0:${W}`, JSON.stringify({ entryPriceE6: "83000000", sizeQ: "5", busyFeeAtoms: "junk", timestamp: Date.now() }));
    expect(getSavedEntry(SLAB, 0, W)!.busyFeeAtoms).toBeNull();
  });
  it("getCurrentEntry: the amount only while the record is current for the measured size", () => {
    saveEntryPrice(SLAB, 0, 83_000_000n, 2, W, 10n * Q, { busyFeeAtoms: 500n });
    expect(getCurrentEntry(SLAB, 0, W, 10n * Q).busyFeeAtoms).toBe(500n);
    expect(getCurrentEntry(SLAB, 0, W, 11n * Q).busyFeeAtoms).toBeNull(); // another device changed the size
    expect(getCurrentEntry(SLAB, 0, W, null).busyFeeAtoms).toBeNull();
    expect(entryRecordCurrent({ sizeQ: 10n * Q, pending: false }, 10n * Q)).toBe(true);
  });
});

describe("busyFeeAfterTrade", () => {
  const saved = (busy: bigint | null, size = 10n * Q) => ({ entryPriceE6: 83_000_000n, sizeQ: size, busyFeeAtoms: busy });
  it("open from flat / flip: this fill's amount (unknown stays unknown)", () => {
    expect(busyFeeAfterTrade({ beforeQ: 0n, afterQ: 5n * Q, saved: null, fillBusyFeeAtoms: 700n })).toBe(700n);
    expect(busyFeeAfterTrade({ beforeQ: 4n * Q, afterQ: -3n * Q, saved: saved(900n, 4n * Q), fillBusyFeeAtoms: 700n })).not.toBe(900n);
    expect(busyFeeAfterTrade({ beforeQ: 0n, afterQ: 5n * Q, saved: null, fillBusyFeeAtoms: null })).toBeNull();
  });
  it("review LOW-2: on a flip only the OPENING part of the fill's busy fee is stored (matches trade-book's attribution)", () => {
    // long 4 -> short 3: the fill is 7 q, 3 of which open the new side
    const fillBusy = 7_000n;
    const stored = busyFeeAfterTrade({ beforeQ: 4n * Q, afterQ: -3n * Q, saved: saved(900n, 4n * Q), fillBusyFeeAtoms: fillBusy })!;
    expect(stored).toBe(3_000n);
    // the trade book gives the new position fee x openQ/|q| of the same fill
    const flip = applyFill({ q: 4n * Q, avgE6: 1_000_000n, fees: 0n, pnl: 0n }, { q: -7n * Q, bookedPriceE6: 1_100_000n, feeAtoms: fillBusy });
    expect(flip.book!.fees).toBe(stored);
  });
  it("add: the prior amount plus this fill's (size-weighted: nothing is averaged away)", () => {
    expect(busyFeeAfterTrade({ beforeQ: 10n * Q, afterQ: 15n * Q, saved: saved(1_000n), fillBusyFeeAtoms: 300n })).toBe(1_300n);
    expect(busyFeeAfterTrade({ beforeQ: -10n * Q, afterQ: -15n * Q, saved: saved(1_000n, -10n * Q), fillBusyFeeAtoms: 0n })).toBe(1_000n);
  });
  it("add on a record that covers more than the size before (a partial close elsewhere): the prior share scales to the size before", () => {
    expect(busyFeeAfterTrade({ beforeQ: 5n * Q, afterQ: 8n * Q, saved: saved(1_000n, 10n * Q), fillBusyFeeAtoms: 100n })).toBe(600n);
  });
  it("reduce: the remaining position keeps its per-unit rate", () => {
    expect(busyFeeAfterTrade({ beforeQ: 10n * Q, afterQ: 4n * Q, saved: saved(1_000n), fillBusyFeeAtoms: 0n })).toBe(400n);
  });
  it("flat after: nothing", () => {
    expect(busyFeeAfterTrade({ beforeQ: 10n * Q, afterQ: 0n, saved: saved(1_000n), fillBusyFeeAtoms: 0n })).toBeNull();
  });
  it("unknown is never zero: an add/reduce on an unknown prior, an unsized record, a wrong side, or an unknown fill amount", () => {
    expect(busyFeeAfterTrade({ beforeQ: 10n * Q, afterQ: 15n * Q, saved: saved(null), fillBusyFeeAtoms: 300n })).toBeNull();
    expect(busyFeeAfterTrade({ beforeQ: 10n * Q, afterQ: 4n * Q, saved: saved(null), fillBusyFeeAtoms: 0n })).toBeNull();
    expect(busyFeeAfterTrade({ beforeQ: 10n * Q, afterQ: 15n * Q, saved: { entryPriceE6: 1n, sizeQ: null, busyFeeAtoms: 5n }, fillBusyFeeAtoms: 300n })).toBeNull();
    expect(busyFeeAfterTrade({ beforeQ: 10n * Q, afterQ: 15n * Q, saved: saved(1_000n, -10n * Q), fillBusyFeeAtoms: 300n })).toBeNull();
    expect(busyFeeAfterTrade({ beforeQ: 10n * Q, afterQ: 15n * Q, saved: saved(1_000n), fillBusyFeeAtoms: null })).toBeNull();
    expect(busyFeeAfterTrade({ beforeQ: 11n * Q, afterQ: 15n * Q, saved: saved(1_000n), fillBusyFeeAtoms: 1n })).toBeNull(); // grew past the record
  });
});

import { computePositionPnl } from "@/lib/position-pnl";

describe("computePositionPnl threads the amount to every close dialog (dock, panel, portfolio)", () => {
  const base = {
    basisQ: 10n * Q, aBasis: 0n, adlFactors: null, adlApplicable: false, markE6: 84_000_000n, onChainPnl: 0n, initialMarginBps: 1000n, capital: 1_000_000_000n,
    cachedEntryE6: 83_000_000n, cachedRiskEntryE6: 82_900_000n,
  };
  it("current cache record: the amount; not current (size changed elsewhere), no amount, or no cached entry: null (unknown)", () => {
    expect(computePositionPnl({ ...base, cachedBusyFeeAtoms: 777n, cachedEntryCheck: { sizeQ: 10n * Q, pending: false } }).busyFeePaidAtoms).toBe(777n);
    expect(computePositionPnl({ ...base, cachedBusyFeeAtoms: 0n, cachedEntryCheck: { sizeQ: 10n * Q, pending: false } }).busyFeePaidAtoms).toBe(0n);
    expect(computePositionPnl({ ...base, cachedBusyFeeAtoms: 777n, cachedEntryCheck: { sizeQ: 9n * Q, pending: false } }).busyFeePaidAtoms).toBeNull();
    expect(computePositionPnl({ ...base, cachedBusyFeeAtoms: null, cachedEntryCheck: { sizeQ: 10n * Q, pending: false } }).busyFeePaidAtoms).toBeNull();
    expect(computePositionPnl({ ...base, cachedEntryE6: 0n, cachedBusyFeeAtoms: 777n }).busyFeePaidAtoms).toBeNull();
  });
});
