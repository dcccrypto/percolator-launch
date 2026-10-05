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

  it("treats a corrupted negative entryPriceE6 the same as not found", () => {
    localStorage.setItem(
      `perc:entry:${SLAB}:${IDX}`,
      JSON.stringify({ entryPriceE6: "-83922808", timestamp: Date.now() }),
    );

    expect(getEntryPrice(SLAB, IDX)).toBe(0n);
  });
});

describe("entry-price per-portfolio scoping (#2560 — isolated margin)", () => {
  const WALLET = "Wa11et1111111111111111111111111111111111111";
  const PF_A = "PortfoLioAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const PF_B = "PortfoLioBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    });
  });

  it("two portfolios on the same (slab, idx, wallet) do NOT collide", () => {
    saveEntryPrice(SLAB, 0, 100n, 2, WALLET, PF_A);
    saveEntryPrice(SLAB, 0, 200n, 5, WALLET, PF_B);

    expect(getEntryPrice(SLAB, 0, WALLET, PF_A)).toBe(100n);
    expect(getEntryPrice(SLAB, 0, WALLET, PF_B)).toBe(200n);
    expect(getEntryLeverage(SLAB, 0, WALLET, PF_A)).toBe(2);
    expect(getEntryLeverage(SLAB, 0, WALLET, PF_B)).toBe(5);
  });

  it("a portfolio-scoped read falls back to a legacy (pre-#2560) wallet-scoped record", () => {
    // Written the old way (no portfolio segment), as an existing user would have.
    saveEntryPrice(SLAB, 0, 777n, 3, WALLET);
    // The primary portfolio reads it via fallback until its next scoped write.
    expect(getEntryPrice(SLAB, 0, WALLET, PF_A)).toBe(777n);
    expect(getEntryLeverage(SLAB, 0, WALLET, PF_A)).toBe(3);
  });

  it("a scoped record shadows the legacy fallback (scoped wins)", () => {
    saveEntryPrice(SLAB, 0, 777n, 3, WALLET); // legacy
    saveEntryPrice(SLAB, 0, 888n, 4, WALLET, PF_A); // scoped
    expect(getEntryPrice(SLAB, 0, WALLET, PF_A)).toBe(888n);
    expect(getEntryLeverage(SLAB, 0, WALLET, PF_A)).toBe(4);
  });

  it("a NEW portfolio with its own scoped record never falls through to another's legacy entry", () => {
    saveEntryPrice(SLAB, 0, 777n, 3, WALLET); // pre-existing primary (legacy)
    saveEntryPrice(SLAB, 0, 555n, 10, WALLET, PF_B); // freshly opened isolated
    // PF_B reads its own, not the legacy primary's.
    expect(getEntryPrice(SLAB, 0, WALLET, PF_B)).toBe(555n);
  });

  it("clearing a scoped entry removes ONLY that slot — never the shared legacy key (F2)", () => {
    // The write side still writes the legacy key for the primary, so dropping it
    // while closing a DIFFERENT portfolio would wipe the primary's entry.
    saveEntryPrice(SLAB, 0, 777n, 3, WALLET); // legacy (primary A's entry lives here)
    saveEntryPrice(SLAB, 0, 888n, 4, WALLET, PF_A); // scoped
    clearEntryPrice(SLAB, 0, WALLET, PF_A);
    // the scoped slot is gone; it now falls back to the still-present legacy...
    expect(getEntryPrice(SLAB, 0, WALLET)).toBe(777n); // legacy UNTOUCHED
    // ...and a close of an isolated portfolio B must not have wiped the primary.
    clearEntryPrice(SLAB, 0, WALLET, PF_B);
    expect(getEntryPrice(SLAB, 0, WALLET)).toBe(777n); // still there
  });

  it("callers that pass no portfolio behave exactly as before (byte-identical key)", () => {
    saveEntryPrice(SLAB, 0, 123n, 2, WALLET);
    // Same (slab, idx, wallet) read with no portfolio resolves the legacy key.
    expect(getEntryPrice(SLAB, 0, WALLET)).toBe(123n);
    expect(store.has(`perc:entry:${SLAB}:0:${WALLET}`)).toBe(true);
  });
});
