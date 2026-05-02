import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearEntryPrice, getEntryLeverage, getEntryPrice, saveEntryPrice } from "../../lib/entry-price";

const SLAB = "6ka35xxxfLE5GttGNX7ZDZZz3d1VM2spSWSjArMKxe8o";
const IDX = 2;

describe("entry-price local storage", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    });
  });

  it("stores entry price and selected order leverage together", () => {
    saveEntryPrice(SLAB, IDX, 83_922_808n, 2);

    expect(getEntryPrice(SLAB, IDX)).toBe(83_922_808n);
    expect(getEntryLeverage(SLAB, IDX)).toBe(2);
  });

  it("keeps backwards compatibility with old records that only had entryPriceE6", () => {
    localStorage.setItem(
      `perc:entry:${SLAB}:${IDX}`,
      JSON.stringify({ entryPriceE6: "83922808", timestamp: Date.now() }),
    );

    expect(getEntryPrice(SLAB, IDX)).toBe(83_922_808n);
    expect(getEntryLeverage(SLAB, IDX)).toBeNull();
  });

  it("clears both entry price and selected leverage", () => {
    saveEntryPrice(SLAB, IDX, 83_922_808n, 2);
    clearEntryPrice(SLAB, IDX);

    expect(getEntryPrice(SLAB, IDX)).toBe(0n);
    expect(getEntryLeverage(SLAB, IDX)).toBeNull();
  });
});
