/**
 * r8 BUG C: an entry cached on this device was trusted even after the position changed from another device. It now counts only while the
 * ADL-effective size measured on chain still equals the size it was saved for (EntryRecord.sizeQ); a record with no size, or another size,
 * is not exact and the surfaces fall back to "unknown entry on this device". The opening device's first save (made when the fill lands,
 * before the size is measured) is flagged pending for a short window so it does not flicker to unknown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { entryRecordCurrent, getCurrentEntry, getSavedEntry, PENDING_ENTRY_WINDOW_MS, saveEntryPrice } from "@/lib/entry-price";
import { portfolioPositionPnl, terminalPositionPnl, type PortfolioPnlSource } from "@/lib/position-pnl";

const ADL_ONE = 1_000_000_000_000_000n;
const SLAB = "SLAB1111111111111111111111111111111111111111";
const OWNER = new PublicKey("11111111111111111111111111111111");
const WALLET = OWNER.toBase58();
const factors = { aLong: ADL_ONE, aShort: ADL_ONE } as never;
const MARK = 90_000_000n;

const snap = (basisQ: bigint): PortfolioPnlSource => ({
  account: { positionSize: basisQ, adlABasis: ADL_ONE, pnl: 0n, capital: 10_000_000n, owner: OWNER } as never,
  adlFactors: factors, adlApplicable: true, effectiveEntryPrice: 0n, entryPriceSource: "unknown",
  initialMarginBps: 1000n, maintenanceMarginBps: 500n, oraclePriceE6: MARK, slabAddress: SLAB, idx: 0, entryCacheWallet: WALLET,
});
const terminal = (basisQ: bigint) =>
  terminalPositionPnl({
    account: { positionSize: basisQ, adlABasis: ADL_ONE, pnl: 0n, capital: 10_000_000n, owner: OWNER } as never,
    slabAddress: SLAB, accountIdx: 0, adlFactors: factors, adlApplicable: true, markE6: MARK, initialMarginBps: 1000n, maintenanceMarginBps: 500n,
  });

beforeEach(() => localStorage.clear());
afterEach(() => vi.useRealTimers());

describe("a cached entry is valid only for the size it was saved for", () => {
  it("same size: exact (cache)", () => {
    saveEntryPrice(SLAB, 0, 100_000_000n, 2, WALLET, 1_000_000n);
    for (const p of [portfolioPositionPnl(snap(1_000_000n), MARK), terminal(1_000_000n)]) {
      expect(p.entrySource).toBe("cache");
      expect(p.entry).toBe(100_000_000n);
      expect(p.pnlKnown).toBe(true);
    }
  });

  it("another device added to the position: the stale cache is NOT exact, the entry is unknown", () => {
    saveEntryPrice(SLAB, 0, 100_000_000n, 2, WALLET, 1_000_000n);
    for (const p of [portfolioPositionPnl(snap(1_800_000n), MARK), terminal(1_800_000n)]) {
      expect(p.entrySource).toBe("unknown");
      expect(p.pnlKnown).toBe(false);
      expect(p.unrealizedPnl).toBeNull();
    }
  });

  it("another device reduced it, or flipped it: unknown too", () => {
    saveEntryPrice(SLAB, 0, 100_000_000n, 2, WALLET, 1_000_000n);
    expect(portfolioPositionPnl(snap(400_000n), MARK).pnlKnown).toBe(false);
    expect(terminal(-1_000_000n).pnlKnown).toBe(false);
  });

  it("a record with no size (an older save) cannot vouch: unknown", () => {
    localStorage.setItem(`perc:entry:${SLAB}:0:${WALLET}`, JSON.stringify({ entryPriceE6: "100000000", timestamp: Date.now() }));
    expect(portfolioPositionPnl(snap(1_000_000n), MARK).pnlKnown).toBe(false);
    expect(terminal(1_000_000n).pnlKnown).toBe(false);
  });

  it("the predicate", () => {
    expect(entryRecordCurrent({ sizeQ: 5n, pending: false }, 5n)).toBe(true);
    expect(entryRecordCurrent({ sizeQ: 5n, pending: false }, 6n)).toBe(false);
    expect(entryRecordCurrent({ sizeQ: 5n, pending: false }, null)).toBe(false);
    expect(entryRecordCurrent({ sizeQ: null, pending: false }, 5n)).toBe(false);
    expect(entryRecordCurrent({ sizeQ: null, pending: true }, 5n)).toBe(true);
  });
});

describe("the opening device does not flicker to unknown before the size is measured", () => {
  it("the first save has no size but is pending: the entry shows; the measured save replaces it", () => {
    saveEntryPrice(SLAB, 0, 100_400_000n, 3, WALLET, undefined, { bookedPriceE6: 100_000_000n, pending: true });
    expect(getSavedEntry(SLAB, 0, WALLET)).toMatchObject({ sizeQ: null, pending: true });
    const during = portfolioPositionPnl(snap(1_000_000n), MARK);
    expect(during.entrySource).toBe("cache");
    expect(during.entry).toBe(100_400_000n);
    // measurement lands: sized, no longer pending
    saveEntryPrice(SLAB, 0, 100_400_000n, 3, WALLET, 1_000_000n, { bookedPriceE6: 100_000_000n });
    expect(getSavedEntry(SLAB, 0, WALLET)).toMatchObject({ sizeQ: 1_000_000n, pending: false });
    expect(terminal(1_000_000n).entrySource).toBe("cache");
  });

  it("a measurement that never lands: the pending save stops counting after the window", () => {
    vi.useFakeTimers();
    saveEntryPrice(SLAB, 0, 100_400_000n, 3, WALLET, undefined, { pending: true });
    expect(terminal(1_000_000n).entrySource).toBe("cache");
    vi.advanceTimersByTime(PENDING_ENTRY_WINDOW_MS + 1_000);
    expect(terminal(1_000_000n).entrySource).toBe("unknown");
  });

  it("a sized save is never pending", () => {
    saveEntryPrice(SLAB, 0, 100_000_000n, 2, WALLET, 1_000_000n, { pending: true });
    expect(getSavedEntry(SLAB, 0, WALLET)!.pending).toBe(false);
  });
});

describe("every consumer of the cached entry checks the size (withdraw pre-check, snapshot fallback)", () => {
  it("getCurrentEntry: the booked basis for the matching size, zeros for another size or none", () => {
    saveEntryPrice(SLAB, 0, 100_400_000n, 2, WALLET, 1_000_000n, { bookedPriceE6: 100_000_000n });
    expect(getCurrentEntry(SLAB, 0, WALLET, 1_000_000n)).toEqual({ entryE6: 100_400_000n, riskEntryE6: 100_000_000n, busyFeeAtoms: null });
    expect(getCurrentEntry(SLAB, 0, WALLET, 1_800_000n)).toEqual({ entryE6: 0n, riskEntryE6: 0n, busyFeeAtoms: null });
    expect(getCurrentEntry(SLAB, 1, WALLET, 1_000_000n)).toEqual({ entryE6: 0n, riskEntryE6: 0n, busyFeeAtoms: null });
  });
  it("a snapshot that says 'cache' does not stand in for a record this device no longer holds", () => {
    const row = { ...snap(1_000_000n), entryPriceSource: "cache" as const, effectiveEntryPrice: 100_000_000n };
    const p = portfolioPositionPnl(row, MARK);
    expect(p.entrySource).toBe("unknown");
    expect(p.pnlKnown).toBe(false);
  });
});
