import { beforeEach, describe, expect, it } from "vitest";
import { computePositionPnl, lookupKnownEntries, type PositionPnlInput } from "@/lib/position-pnl";
import { saveEntryPrice } from "@/lib/entry-price";

const ONE = 1_000_000_000_000_000n;
const base: PositionPnlInput = {
  basisQ: 80_000_000n,
  aBasis: ONE,
  adlFactors: { aLong: ONE / 2n, aShort: ONE },
  markE6: 100_000_000n,
  cachedEntryE6: 0n,
  onChainPnl: 5_000_000n,
  initialMarginBps: 1000n,
  capital: 1_000_000_000n,
};

describe("computePositionPnl", () => {
  it("entry priority is server > cache > derived: a server entry slots in above the cache", () => {
    const server = computePositionPnl({ ...base, serverEntryE6: 99_000_000n, cachedEntryE6: 99_875_000n });
    expect(server.entrySource).toBe("server");
    expect(server.entry).toBe(99_000_000n);
    expect(server.isEstimate).toBe(false);
    // 40 effective tokens x $1.00
    expect(server.unrealizedPnl).toBe(40_000_000n);

    const cache = computePositionPnl({ ...base, cachedEntryE6: 99_875_000n });
    expect(cache.entrySource).toBe("cache");
    expect(cache.unrealizedPnl).toBe(5_000_000n);

    const derived = computePositionPnl(base);
    expect(derived.entrySource).toBe("derived");
    expect(derived.isEstimate).toBe(true);
    expect(derived.unrealizedPnl).toBe(5_000_000n);
  });

  it("values at the MARK, not at the anchor: the estimate moves with the live mark", () => {
    const atAnchor = computePositionPnl(base);
    const moved = computePositionPnl({ ...base, markE6: 101_000_000n, anchorMarkE6: 100_000_000n });
    // +$1.00 x 40 effective tokens on top of the anchored +$5
    const delta = moved.unrealizedPnl! - atAnchor.unrealizedPnl!;
    // (integer flooring in the native -> collateral conversion costs a few atoms)
    expect(delta >= 39_999_000n && delta <= 40_001_000n).toBe(true);
  });

  it("unknown ADL factors: no PnL, never raw basis (control: known factors give a number)", () => {
    const r = computePositionPnl({ ...base, adlFactors: null, cachedEntryE6: 99_875_000n });
    expect(r.adlKnown).toBe(false);
    expect(r.effectiveSize).toBeNull();
    expect(r.pnlKnown).toBe(false);
    expect(r.unrealizedPnl).toBeNull();
    expect(r.roe).toBeNull();
    expect(computePositionPnl({ ...base, cachedEntryE6: 99_875_000n }).pnlKnown).toBe(true);
  });

  it("legacy v12 (adlApplicable: false) treats raw basis as the exposure", () => {
    const r = computePositionPnl({ ...base, adlFactors: null, adlApplicable: false, cachedEntryE6: 99_875_000n });
    expect(r.adlKnown).toBe(true);
    expect(r.effectiveSize).toBe(80_000_000n);
    expect(r.unrealizedPnl).toBe(10_000_000n);
  });

  it("pnl == 0 with no recorded entry is unknown, not a flat $0", () => {
    const r = computePositionPnl({ ...base, onChainPnl: 0n });
    expect(r.entrySource).toBe("unknown");
    expect(r.pnlKnown).toBe(false);
  });

  it("a u64::MAX sentinel pnl is not back-solved", () => {
    const r = computePositionPnl({ ...base, onChainPnl: 18_446_744_073_709_551_615n });
    expect(r.entrySource).toBe("unknown");
  });

  it("flat is a real zero", () => {
    const r = computePositionPnl({ ...base, basisQ: 0n, adlFactors: null });
    expect(r.pnlKnown).toBe(true);
    expect(r.unrealizedPnl).toBe(0n);
  });
});

describe("lookupKnownEntries", () => {
  beforeEach(() => localStorage.clear());
  it("reads this device's cache; the server slot is the single place indexer#211 plugs in", () => {
    expect(lookupKnownEntries("S", 0, "W")).toEqual({ serverEntryE6: null, cachedEntryE6: 0n });
    saveEntryPrice("S", 0, 123n, undefined, "W");
    expect(lookupKnownEntries("S", 0, "W").cachedEntryE6).toBe(123n);
  });
});
