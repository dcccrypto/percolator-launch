/**
 * #3314: the saved entry after a trade on an open position, decided from the position measured
 * on chain before and after the trade (signed ADL-effective q), never from the requested size.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { entryAfterTrade, getSavedEntry, saveEntryPrice, getEntryPrice } from "../../lib/entry-price";

const SLAB = "6ka35xxxfLE5GttGNX7ZDZZz3d1VM2spSWSjArMKxe8o";
const W = "4bXx1ioqZ5XLC86DCwuCtu8mPfS9MT9EEY12SxH1FEGa";

const saved = (entryPriceE6: bigint, sizeQ: bigint | null) => ({ entryPriceE6, sizeQ });

describe("entryAfterTrade", () => {
  it("opening from flat takes this fill's price", () => {
    expect(entryAfterTrade({ beforeQ: 0n, afterQ: 40n, saved: null, fillPriceE6: 1_200_000n })).toBe(1_200_000n);
    expect(entryAfterTrade({ beforeQ: 0n, afterQ: -40n, saved: null, fillPriceE6: 1_200_000n })).toBe(1_200_000n);
  });

  it("an add averages the saved entry over the prior size and the fill over the added size", () => {
    // 40 @ 1.00 + 40 @ 1.20 = 80 @ 1.10
    expect(entryAfterTrade({ beforeQ: 40n, afterQ: 80n, saved: saved(1_000_000n, 40n), fillPriceE6: 1_200_000n })).toBe(1_100_000n);
    // short side: -30 @ 2.00 + -10 @ 1.00 = -40 @ 1.75
    expect(entryAfterTrade({ beforeQ: -30n, afterQ: -40n, saved: saved(2_000_000n, -30n), fillPriceE6: 1_000_000n })).toBe(1_750_000n);
  });

  it("weights by the MEASURED growth, so a partial fill weighs only what filled", () => {
    // asked to add 40, only 10 filled: 40 @ 1.00 + 10 @ 2.00 = 50 @ 1.20
    expect(entryAfterTrade({ beforeQ: 40n, afterQ: 50n, saved: saved(1_000_000n, 40n), fillPriceE6: 2_000_000n })).toBe(1_200_000n);
  });

  it("truncates the average like every other e6 price", () => {
    // (1·1 + 2·2) / 3 = 1.666666… → 1_666_666
    expect(entryAfterTrade({ beforeQ: 1n, afterQ: 3n, saved: saved(1_000_000n, 1n), fillPriceE6: 2_000_000n })).toBe(1_666_666n);
  });

  it("a reduce keeps the saved entry (average cost), including an unchanged size", () => {
    expect(entryAfterTrade({ beforeQ: 80n, afterQ: 30n, saved: saved(1_100_000n, 80n), fillPriceE6: 9_000_000n })).toBe(1_100_000n);
    expect(entryAfterTrade({ beforeQ: 80n, afterQ: 80n, saved: saved(1_100_000n, 80n), fillPriceE6: 9_000_000n })).toBe(1_100_000n);
  });

  it("a flip opens the remainder at this fill, whatever the saved entry was", () => {
    expect(entryAfterTrade({ beforeQ: 40n, afterQ: -10n, saved: saved(1_000_000n, 40n), fillPriceE6: 1_300_000n })).toBe(1_300_000n);
    expect(entryAfterTrade({ beforeQ: 40n, afterQ: -10n, saved: null, fillPriceE6: 1_300_000n })).toBe(1_300_000n);
  });

  it("ADL: a sell larger than the EFFECTIVE long flips it, so the long's entry is not kept", () => {
    // Basis 100, effective 80 after ADL; selling 90 leaves a 10 short. Read on effective sizes
    // (what the caller passes) this is a flip, not a reduce of 100.
    expect(entryAfterTrade({ beforeQ: 80n, afterQ: -10n, saved: saved(1_000_000n, 100n), fillPriceE6: 1_300_000n })).toBe(1_300_000n);
  });

  it("closing to flat clears", () => {
    expect(entryAfterTrade({ beforeQ: 80n, afterQ: 0n, saved: saved(1_100_000n, 80n), fillPriceE6: 1_300_000n })).toBeNull();
  });

  it("no saved entry, or one without a recorded size, clears an add or reduce (the old behaviour)", () => {
    expect(entryAfterTrade({ beforeQ: 40n, afterQ: 80n, saved: null, fillPriceE6: 1_200_000n })).toBeNull();
    expect(entryAfterTrade({ beforeQ: 40n, afterQ: 80n, saved: saved(1_000_000n, null), fillPriceE6: 1_200_000n })).toBeNull();
    expect(entryAfterTrade({ beforeQ: 80n, afterQ: 30n, saved: saved(1_000_000n, null), fillPriceE6: 1_200_000n })).toBeNull();
  });

  it("a saved entry for a DIFFERENT position is never blended in", () => {
    // grown past the record (an add from another device), or on the other side (a stale record)
    expect(entryAfterTrade({ beforeQ: 60n, afterQ: 80n, saved: saved(1_000_000n, 40n), fillPriceE6: 1_200_000n })).toBeNull();
    expect(entryAfterTrade({ beforeQ: 40n, afterQ: 80n, saved: saved(1_000_000n, -40n), fillPriceE6: 1_200_000n })).toBeNull();
  });

  it("a record larger than the position (partial close / liquidation elsewhere, ADL) still applies", () => {
    expect(entryAfterTrade({ beforeQ: 30n, afterQ: 60n, saved: saved(1_000_000n, 80n), fillPriceE6: 2_000_000n })).toBe(1_500_000n);
  });

  it("no usable fill price never yields an entry for new size", () => {
    expect(entryAfterTrade({ beforeQ: 0n, afterQ: 40n, saved: null, fillPriceE6: 0n })).toBeNull();
    expect(entryAfterTrade({ beforeQ: 40n, afterQ: 80n, saved: saved(1_000_000n, 40n), fillPriceE6: 0n })).toBeNull();
    // a reduce does not need one
    expect(entryAfterTrade({ beforeQ: 40n, afterQ: 20n, saved: saved(1_000_000n, 40n), fillPriceE6: 0n })).toBe(1_000_000n);
  });
});

describe("saved entry record carries the position size", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    });
  });

  it("round-trips entry, leverage and signed size", () => {
    saveEntryPrice(SLAB, 0, 1_100_000n, 3, W, -80n);
    expect(getSavedEntry(SLAB, 0, W)).toEqual({ entryPriceE6: 1_100_000n, leverage: 3, sizeQ: -80n });
    expect(getEntryPrice(SLAB, 0, W)).toBe(1_100_000n);
  });

  it("an older record without a size reads sizeQ null; a missing or bad record reads null", () => {
    saveEntryPrice(SLAB, 0, 1_000_000n, undefined, W);
    expect(getSavedEntry(SLAB, 0, W)).toEqual({ entryPriceE6: 1_000_000n, leverage: null, sizeQ: null });
    expect(getSavedEntry(SLAB, 1, W)).toBeNull();
    store.set(`perc:entry:${SLAB}:2:${W}`, "{not json");
    expect(getSavedEntry(SLAB, 2, W)).toBeNull();
    store.set(`perc:entry:${SLAB}:3:${W}`, JSON.stringify({ entryPriceE6: "-5", timestamp: 0 }));
    expect(getSavedEntry(SLAB, 3, W)).toBeNull();
  });
});
