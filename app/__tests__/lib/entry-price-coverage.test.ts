/**
 * Coverage for lib/entry-price.ts (the entry price shown for open positions on the trade and portfolio pages:
 * PositionPanel, usePortfolio, position-pnl). Every test asserts the price (or fee) returned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PENDING_ENTRY_WINDOW_MS,
  busyFeeAfterTrade,
  clearEntryPrice,
  clearEntryUnknownMark,
  entryAfterTrade,
  entryRecordCurrent,
  getCurrentEntry,
  getEntryLeverage,
  getEntryPrice,
  getEntryUnknownMark,
  getSavedEntry,
  isEntryMarkedUnknown,
  keepEntryAfterReduce,
  markEntryUnknown,
  markUnpricedFill,
  saveEntryPrice,
  tradeGrewPosition,
} from "../../lib/entry-price";

const SLAB = "6ka35xxxfLE5GttGNX7ZDZZz3d1VM2spSWSjArMKxe8o";
const W = "4bXx1ioqZ5XLC86DCwuCtu8mPfS9MT9EEY12SxH1FEGa";
const KEY = `perc:entry:${SLAB}:0:${W}`;
const UKEY = `perc:entry-unknown:${SLAB}:0:${W}`;

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("saveEntryPrice record fields", () => {
  it("stores booked price only when it differs and is positive; fill price stays the entry", () => {
    saveEntryPrice(SLAB, 0, 148_250_000n, 5, W, 10n, { bookedPriceE6: 148_000_000n, busyFeeAtoms: 0n, chainSig: "cs", lastSig: "ls" });
    const s = getSavedEntry(SLAB, 0, W)!;
    expect(s.entryPriceE6).toBe(148_250_000n);
    expect(s.bookedPriceE6).toBe(148_000_000n);
    expect(s.busyFeeAtoms).toBe(0n);
    expect(s.chainSig).toBe("cs");
    expect(s.lastSig).toBe("ls");
    expect(s.leverage).toBe(5);
    expect(s.sizeQ).toBe(10n);
    expect(getEntryPrice(SLAB, 0, W)).toBe(148_250_000n);
  });

  it("ignores a booked price equal to the entry, a zero one, and a negative busy fee", () => {
    saveEntryPrice(SLAB, 0, 148_250_000n, undefined, undefined, 10n, { bookedPriceE6: 148_250_000n, busyFeeAtoms: -1n });
    const s = getSavedEntry(SLAB, 0)!;
    expect(s.bookedPriceE6).toBe(148_250_000n);
    expect(s.busyFeeAtoms).toBeNull();
    saveEntryPrice(SLAB, 0, 148_250_000n, undefined, undefined, 10n, { bookedPriceE6: 0n });
    expect(getSavedEntry(SLAB, 0)!.bookedPriceE6).toBe(148_250_000n);
  });

  it("drops invalid leverage and a zero size; a pending save without size is pending", () => {
    saveEntryPrice(SLAB, 0, 150_000_000n, Number.NaN, W, 0n, { pending: true });
    expect(getEntryLeverage(SLAB, 0, W)).toBeNull();
    const s = getSavedEntry(SLAB, 0, W)!;
    expect(s.sizeQ).toBeNull();
    expect(s.pending).toBe(true);
    expect(s.entryPriceE6).toBe(150_000_000n);
    saveEntryPrice(SLAB, 0, 150_000_000n, 3, W, 5n, { pending: true });
    expect(getSavedEntry(SLAB, 0, W)!.pending).toBe(false);
  });

  it("a real save replaces an unknown marker", () => {
    markEntryUnknown(SLAB, 0, W, 7n);
    expect(isEntryMarkedUnknown(SLAB, 0, W, 7n)).toBe(true);
    saveEntryPrice(SLAB, 0, 151_000_000n, 2, W, 7n);
    expect(localStorage.getItem(UKEY)).toBeNull();
  });

  it("swallows a throwing localStorage", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => saveEntryPrice(SLAB, 0, 1n)).not.toThrow();
    expect(() => markEntryUnknown(SLAB, 0, W, 1n)).not.toThrow();
  });
});

describe("getEntryPrice / getEntryLeverage", () => {
  it("returns 0 when missing, corrupt, or negative", () => {
    expect(getEntryPrice(SLAB, 0, W)).toBe(0n);
    localStorage.setItem(KEY, "{not json");
    expect(getEntryPrice(SLAB, 0, W)).toBe(0n);
    localStorage.setItem(KEY, JSON.stringify({ entryPriceE6: "-5", timestamp: 1 }));
    expect(getEntryPrice(SLAB, 0, W)).toBe(0n);
  });

  it("leverage: null when missing, corrupt, or not positive; the number otherwise", () => {
    expect(getEntryLeverage(SLAB, 0, W)).toBeNull();
    localStorage.setItem(KEY, "garbage");
    expect(getEntryLeverage(SLAB, 0, W)).toBeNull();
    localStorage.setItem(KEY, JSON.stringify({ entryPriceE6: "1", leverage: 0, timestamp: 1 }));
    expect(getEntryLeverage(SLAB, 0, W)).toBeNull();
    localStorage.setItem(KEY, JSON.stringify({ entryPriceE6: "1", leverage: 7, timestamp: 1 }));
    expect(getEntryLeverage(SLAB, 0, W)).toBe(7);
  });
});

describe("getSavedEntry edge records", () => {
  it("null when missing, corrupt, or entry <= 0", () => {
    expect(getSavedEntry(SLAB, 0, W)).toBeNull();
    localStorage.setItem(KEY, "x");
    expect(getSavedEntry(SLAB, 0, W)).toBeNull();
    localStorage.setItem(KEY, JSON.stringify({ entryPriceE6: "0", timestamp: 1 }));
    expect(getSavedEntry(SLAB, 0, W)).toBeNull();
  });

  it("falls back on malformed size / booked / busy fields, keeping the entry price", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ entryPriceE6: "148250000", sizeQ: "abc", bookedPriceE6: "zz", busyFeeAtoms: "q", leverage: -2, timestamp: "no" }),
    );
    const s = getSavedEntry(SLAB, 0, W)!;
    expect(s.entryPriceE6).toBe(148_250_000n);
    expect(s.sizeQ).toBeNull();
    expect(s.bookedPriceE6).toBe(148_250_000n);
    expect(s.busyFeeAtoms).toBeNull();
    expect(s.leverage).toBeNull();
    expect(s.savedAt).toBe(0);
    expect(s.chainSig).toBeNull();
    expect(s.lastSig).toBeNull();
    expect(s.pending).toBe(false);
  });

  it("negative busy fee reads as unknown; empty lastSig reads as null", () => {
    localStorage.setItem(KEY, JSON.stringify({ entryPriceE6: "5", busyFeeAtoms: "-3", lastSig: "", timestamp: Date.now() }));
    const s = getSavedEntry(SLAB, 0, W)!;
    expect(s.busyFeeAtoms).toBeNull();
    expect(s.lastSig).toBeNull();
  });

  it("a pending record stops counting after the window", () => {
    localStorage.setItem(KEY, JSON.stringify({ entryPriceE6: "5", pending: true, timestamp: Date.now() - PENDING_ENTRY_WINDOW_MS - 1 }));
    expect(getSavedEntry(SLAB, 0, W)!.pending).toBe(false);
    localStorage.setItem(KEY, JSON.stringify({ entryPriceE6: "5", pending: true, timestamp: Date.now() + 60_000 }));
    expect(getSavedEntry(SLAB, 0, W)!.pending).toBe(false);
  });
});

describe("entryRecordCurrent / getCurrentEntry", () => {
  it("compares signed sizes; unknown effective size only passes a pending save", () => {
    expect(entryRecordCurrent({ sizeQ: 5n, pending: false }, 5n)).toBe(true);
    expect(entryRecordCurrent({ sizeQ: 5n, pending: false }, 6n)).toBe(false);
    expect(entryRecordCurrent({ sizeQ: 5n, pending: false }, null)).toBe(false);
    expect(entryRecordCurrent({ sizeQ: null, pending: true }, null)).toBe(true);
    expect(entryRecordCurrent({ sizeQ: null, pending: false }, 5n)).toBe(false);
  });

  it("returns paid price and booked basis for the current position, zeros otherwise", () => {
    saveEntryPrice(SLAB, 0, 148_250_000n, 5, W, -12n, { bookedPriceE6: 148_000_000n, busyFeeAtoms: 40n });
    expect(getCurrentEntry(SLAB, 0, W, -12n)).toEqual({ entryE6: 148_250_000n, riskEntryE6: 148_000_000n, busyFeeAtoms: 40n });
    expect(getCurrentEntry(SLAB, 0, W, -13n)).toEqual({ entryE6: 0n, riskEntryE6: 0n, busyFeeAtoms: null });
    expect(getCurrentEntry(SLAB, 1, W, -12n)).toEqual({ entryE6: 0n, riskEntryE6: 0n, busyFeeAtoms: null });
  });
});

describe("unknown marker", () => {
  it("tradeGrewPosition: open, add, flip grow; reduce and close do not", () => {
    expect(tradeGrewPosition(0n, 10n)).toBe(true);
    expect(tradeGrewPosition(10n, 20n)).toBe(true);
    expect(tradeGrewPosition(10n, -5n)).toBe(true);
    expect(tradeGrewPosition(-10n, -20n)).toBe(true);
    expect(tradeGrewPosition(10n, 5n)).toBe(false);
    expect(tradeGrewPosition(10n, 0n)).toBe(false);
  });

  it("markUnpricedFill writes only for a growing fill, carrying the signature", () => {
    expect(markUnpricedFill(SLAB, 0, W, "sigA", 10n, 5n)).toBe(false);
    expect(localStorage.getItem(UKEY)).toBeNull();
    expect(markUnpricedFill(SLAB, 0, W, "sigA", 10n, 20n)).toBe(true);
    expect(getEntryUnknownMark(SLAB, 0, W, 20n)).toEqual({ sizeQ: 20n, sig: "sigA" });
    markEntryUnknown(SLAB, 0, W, 20n);
    expect(getEntryUnknownMark(SLAB, 0, W, 20n)).toEqual({ sizeQ: 20n, sig: null });
  });

  it("a marker for another size, or unparsable, is removed and reads as none", () => {
    markEntryUnknown(SLAB, 0, W, 20n, "s");
    expect(getEntryUnknownMark(SLAB, 0, W, 21n)).toBeNull();
    expect(localStorage.getItem(UKEY)).toBeNull();
    localStorage.setItem(UKEY, "nope");
    expect(isEntryMarkedUnknown(SLAB, 0, W, 1n)).toBe(false);
    expect(localStorage.getItem(UKEY)).toBeNull();
    localStorage.setItem(UKEY, JSON.stringify({ sizeQ: 5, sig: 3 }));
    expect(getEntryUnknownMark(SLAB, 0, W, 5n)).toBeNull();
  });

  it("clearEntryUnknownMark removes it, and a throwing storage is tolerated", () => {
    markEntryUnknown(SLAB, 0, W, 1n);
    clearEntryUnknownMark(SLAB, 0, W);
    expect(localStorage.getItem(UKEY)).toBeNull();
    markEntryUnknown(SLAB, 0, undefined, 1n);
    expect(isEntryMarkedUnknown(SLAB, 0, undefined, 1n)).toBe(true);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(getEntryUnknownMark(SLAB, 0, W, 1n)).toBeNull();
    expect(getEntryPrice(SLAB, 0, W)).toBe(0n);
    expect(getEntryLeverage(SLAB, 0, W)).toBeNull();
    expect(getSavedEntry(SLAB, 0, W)).toBeNull();
    vi.restoreAllMocks();
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => clearEntryUnknownMark(SLAB, 0, W)).not.toThrow();
    expect(() => clearEntryPrice(SLAB, 0, W, { flat: true })).not.toThrow();
  });
});

describe("clearEntryPrice", () => {
  it("clears the entry; the marker only on a flat close", () => {
    saveEntryPrice(SLAB, 0, 148_250_000n, 5, W, 10n);
    markEntryUnknown(SLAB, 0, W, 10n);
    clearEntryPrice(SLAB, 0, W);
    expect(getEntryPrice(SLAB, 0, W)).toBe(0n);
    expect(localStorage.getItem(UKEY)).not.toBeNull();
    clearEntryPrice(SLAB, 0, W, { flat: true });
    expect(localStorage.getItem(UKEY)).toBeNull();
  });
});

describe("entryAfterTrade remaining branches", () => {
  const sv = (e: bigint, s: bigint | null) => ({ entryPriceE6: e, sizeQ: s });
  it("flat after clears; an unpriced open is null", () => {
    expect(entryAfterTrade({ beforeQ: 10n, afterQ: 0n, saved: sv(1n, 10n), fillPriceE6: 5n })).toBeNull();
    expect(entryAfterTrade({ beforeQ: 0n, afterQ: 10n, saved: null, fillPriceE6: 0n })).toBeNull();
  });
  it("a flip takes the fill price", () => {
    expect(entryAfterTrade({ beforeQ: 10n, afterQ: -4n, saved: sv(1_000_000n, 10n), fillPriceE6: 148_250_000n })).toBe(148_250_000n);
  });
  it("no vouching record: null", () => {
    expect(entryAfterTrade({ beforeQ: 10n, afterQ: 5n, saved: null, fillPriceE6: 5n })).toBeNull();
    expect(entryAfterTrade({ beforeQ: 10n, afterQ: 5n, saved: sv(0n, 10n), fillPriceE6: 5n })).toBeNull();
    expect(entryAfterTrade({ beforeQ: 10n, afterQ: 5n, saved: sv(1n, null), fillPriceE6: 5n })).toBeNull();
    expect(entryAfterTrade({ beforeQ: 10n, afterQ: 5n, saved: sv(1n, -10n), fillPriceE6: 5n })).toBeNull();
    expect(entryAfterTrade({ beforeQ: 10n, afterQ: 5n, saved: sv(1n, 8n), fillPriceE6: 5n })).toBeNull();
  });
  it("a reduce keeps the average; an add with no fill price is null", () => {
    expect(entryAfterTrade({ beforeQ: 10n, afterQ: 4n, saved: sv(148_000_000n, 10n), fillPriceE6: 150_000_000n })).toBe(148_000_000n);
    expect(entryAfterTrade({ beforeQ: 10n, afterQ: 20n, saved: sv(148_000_000n, 10n), fillPriceE6: 0n })).toBeNull();
  });
});

describe("busyFeeAfterTrade", () => {
  const sv = (s: bigint | null, fee: bigint | null) => ({ entryPriceE6: 1n, sizeQ: s, busyFeeAtoms: fee });
  it("flat after is null", () => {
    expect(busyFeeAfterTrade({ beforeQ: 5n, afterQ: 0n, saved: null, fillBusyFeeAtoms: 3n })).toBeNull();
  });
  it("open from flat carries the fill fee; unknown or negative is null", () => {
    expect(busyFeeAfterTrade({ beforeQ: 0n, afterQ: 10n, saved: null, fillBusyFeeAtoms: 120n })).toBe(120n);
    expect(busyFeeAfterTrade({ beforeQ: 0n, afterQ: 10n, saved: null, fillBusyFeeAtoms: null })).toBeNull();
    expect(busyFeeAfterTrade({ beforeQ: 0n, afterQ: 10n, saved: null, fillBusyFeeAtoms: -1n })).toBeNull();
  });
  it("a flip keeps only the share that opens the new side", () => {
    // before 10, after -5: fillQ = 15, fee 300 over 15 -> 5/15 share = 100
    expect(busyFeeAfterTrade({ beforeQ: 10n, afterQ: -5n, saved: null, fillBusyFeeAtoms: 300n })).toBe(100n);
  });
  it("reduce scales the prior fee; add sums prior share and the fill fee", () => {
    expect(busyFeeAfterTrade({ beforeQ: 10n, afterQ: 5n, saved: sv(10n, 200n), fillBusyFeeAtoms: null })).toBe(100n);
    expect(busyFeeAfterTrade({ beforeQ: 10n, afterQ: 20n, saved: sv(10n, 200n), fillBusyFeeAtoms: 50n })).toBe(250n);
    expect(busyFeeAfterTrade({ beforeQ: 10n, afterQ: 20n, saved: sv(10n, 200n), fillBusyFeeAtoms: null })).toBeNull();
    expect(busyFeeAfterTrade({ beforeQ: 10n, afterQ: 20n, saved: sv(10n, 200n), fillBusyFeeAtoms: -2n })).toBeNull();
  });
  it("an unvouched record is null", () => {
    expect(busyFeeAfterTrade({ beforeQ: 10n, afterQ: 5n, saved: null, fillBusyFeeAtoms: 1n })).toBeNull();
    expect(busyFeeAfterTrade({ beforeQ: 10n, afterQ: 5n, saved: sv(10n, null), fillBusyFeeAtoms: 1n })).toBeNull();
    expect(busyFeeAfterTrade({ beforeQ: 10n, afterQ: 5n, saved: sv(null, 5n), fillBusyFeeAtoms: 1n })).toBeNull();
    expect(busyFeeAfterTrade({ beforeQ: 10n, afterQ: 5n, saved: sv(-10n, 5n), fillBusyFeeAtoms: 1n })).toBeNull();
    expect(busyFeeAfterTrade({ beforeQ: 10n, afterQ: 5n, saved: sv(8n, 5n), fillBusyFeeAtoms: 1n })).toBeNull();
  });
});

describe("keepEntryAfterReduce", () => {
  const seed = (extra: Parameters<typeof saveEntryPrice>[6] = {}) =>
    saveEntryPrice(SLAB, 0, 148_250_000n, 4, W, 10n, { bookedPriceE6: 148_000_000n, busyFeeAtoms: 200n, ...extra });

  it("moves the record to the reduced size, keeping the average price and scaling the fee", () => {
    seed({ chainSig: "cs" });
    expect(keepEntryAfterReduce(SLAB, 0, W, 10n, 4n, "newSig")).toBe(true);
    const s = getSavedEntry(SLAB, 0, W)!;
    expect(s.entryPriceE6).toBe(148_250_000n);
    expect(s.bookedPriceE6).toBe(148_000_000n);
    expect(s.sizeQ).toBe(4n);
    expect(s.busyFeeAtoms).toBe(80n);
    expect(s.leverage).toBe(4);
    expect(s.chainSig).toBe("cs");
    expect(s.lastSig).toBe("newSig");
  });

  it("without a signature the record carries no lastSig", () => {
    seed();
    expect(keepEntryAfterReduce(SLAB, 0, W, 10n, 4n)).toBe(true);
    expect(getSavedEntry(SLAB, 0, W)!.lastSig).toBeNull();
  });

  it("not a pure reduce: flat, flip, add, from flat", () => {
    seed();
    expect(keepEntryAfterReduce(SLAB, 0, W, 10n, 0n)).toBe(false);
    expect(keepEntryAfterReduce(SLAB, 0, W, 0n, 5n)).toBe(false);
    expect(keepEntryAfterReduce(SLAB, 0, W, 10n, -3n)).toBe(false);
    expect(keepEntryAfterReduce(SLAB, 0, W, 10n, 12n)).toBe(false);
    expect(getEntryPrice(SLAB, 0, W)).toBe(148_250_000n);
  });

  it("left alone when marked unknown, missing, size mismatch, or sizeless", () => {
    seed();
    markEntryUnknown(SLAB, 0, W, 10n);
    expect(keepEntryAfterReduce(SLAB, 0, W, 10n, 4n)).toBe(false);
    clearEntryUnknownMark(SLAB, 0, W);
    expect(keepEntryAfterReduce(SLAB, 0, W, 9n, 4n)).toBe(false);
    expect(keepEntryAfterReduce(SLAB, 1, W, 10n, 4n)).toBe(false);
    saveEntryPrice(SLAB, 0, 148_250_000n, 4, W);
    expect(keepEntryAfterReduce(SLAB, 0, W, 10n, 4n)).toBe(false);
  });

  it("prevChange must match the record's lastSig", () => {
    seed({ lastSig: "L1" });
    expect(keepEntryAfterReduce(SLAB, 0, W, 10n, 4n, "n", "L2")).toBe(false);
    expect(keepEntryAfterReduce(SLAB, 0, W, 10n, 4n, "n", "L1")).toBe(true);
    expect(getSavedEntry(SLAB, 0, W)!.lastSig).toBe("n");
    seed();
    expect(keepEntryAfterReduce(SLAB, 0, W, 10n, 4n, "n", "L1")).toBe(false);
    // null prevChange (known empty chain history) still needs a recorded lastSig
    expect(keepEntryAfterReduce(SLAB, 0, W, 10n, 4n, "n", null)).toBe(false);
  });
});
