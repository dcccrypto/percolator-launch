/**
 * Side-capacity math + live-inventory parsing — the second half of the
 * "user just keeps trying and doesn't know what's wrong" fix.
 *
 * The matcher rejects (whole, no partial fill) any trade that would push the
 * LP's NET inventory past maxInventoryAbs. These tests pin the sign
 * conventions to percolator-match's vamm.rs (`lp_inventory_delta = -fill_size`,
 * inventory_base positive = LP long) with exact values, so an inverted sign —
 * which would block the EMPTY side and allow the FULL one — cannot survive.
 */
import { describe, it, expect } from "vitest";
import { remainingSideCapacityQ, wouldExceedInventoryCap } from "@/lib/marketCapacity";
import { parseMatcherCaps, parseMatcherInventory } from "@/lib/matcherCaps";

describe("remainingSideCapacityQ", () => {
  it("flat LP: both sides get the whole cap", () => {
    expect(remainingSideCapacityQ(0n, 1000n, "long")).toBe(1000n);
    expect(remainingSideCapacityQ(0n, 1000n, "short")).toBe(1000n);
  });

  it("LP short (users net long): long side shrinks, short side grows", () => {
    // User longs made the LP short 800 of a 1000 cap:
    // one more user long moves inv from -800 toward -1000 → only 200 left;
    // a user short UNWINDS the LP toward flat and can go to +1000 → 1800.
    expect(remainingSideCapacityQ(-800n, 1000n, "long")).toBe(200n);
    expect(remainingSideCapacityQ(-800n, 1000n, "short")).toBe(1800n);
  });

  it("LP long (users net short): mirror image", () => {
    expect(remainingSideCapacityQ(800n, 1000n, "long")).toBe(1800n);
    expect(remainingSideCapacityQ(800n, 1000n, "short")).toBe(200n);
  });

  it("side at the cap exactly: zero left there, double cap on the other", () => {
    expect(remainingSideCapacityQ(-1000n, 1000n, "long")).toBe(0n);
    expect(remainingSideCapacityQ(-1000n, 1000n, "short")).toBe(2000n);
  });

  it("clamps at zero when inventory somehow sits beyond the cap", () => {
    expect(remainingSideCapacityQ(-1200n, 1000n, "long")).toBe(0n);
  });

  it("no cap configured (0) → no capacity computed", () => {
    expect(remainingSideCapacityQ(-800n, 0n, "long")).toBe(0n);
  });

  it("the CATE numbers: LP short 202.5B of an 821.5B cap", () => {
    const inv = -202_520_251_800n;
    const cap = 821_523_926_884n;
    expect(remainingSideCapacityQ(inv, cap, "long")).toBe(619_003_675_084n);
    expect(remainingSideCapacityQ(inv, cap, "short")).toBe(1_024_044_178_684n);
  });
});

describe("wouldExceedInventoryCap", () => {
  it("blocks exactly one unit over, allows exactly at capacity", () => {
    // inv -800, cap 1000 → long capacity 200
    expect(wouldExceedInventoryCap(-800n, 1000n, "long", 200n)).toBe(false);
    expect(wouldExceedInventoryCap(-800n, 1000n, "long", 201n)).toBe(true);
  });

  it("a size crossing zero to the other side is allowed up to the far bound", () => {
    // inv -800: a user short of 1800 takes the LP to exactly +1000 — legal.
    expect(wouldExceedInventoryCap(-800n, 1000n, "short", 1800n)).toBe(false);
    expect(wouldExceedInventoryCap(-800n, 1000n, "short", 1801n)).toBe(true);
  });

  it("zero/negative size never blocks", () => {
    expect(wouldExceedInventoryCap(-1000n, 1000n, "long", 0n)).toBe(false);
  });
});

describe("parseMatcherInventory", () => {
  // The vAMM context: 64-byte return slot, then MatcherCtx; inventory_base is
  // an i128 at ctx-relative 96 (absolute 160). Layout from percolator-match
  // vamm.rs — the same doc-comment parseMatcherCaps' offsets come from.
  function ctxBuffer(): Buffer {
    return Buffer.alloc(64 + 256);
  }
  function writeI128(buf: Buffer, off: number, v: bigint): void {
    const u = v < 0n ? v + (1n << 128n) : v;
    buf.writeBigUInt64LE(u & 0xffffffffffffffffn, off);
    buf.writeBigUInt64LE(u >> 64n, off + 8);
  }

  it("reads a negative (LP short) inventory back exactly", () => {
    const buf = ctxBuffer();
    writeI128(buf, 64 + 96, -202_520_251_800n);
    expect(parseMatcherInventory(buf)).toBe(-202_520_251_800n);
  });

  it("reads a positive inventory and is independent of the caps fields", () => {
    const buf = ctxBuffer();
    writeI128(buf, 64 + 80, 111n); // max_fill_abs
    writeI128(buf, 64 + 96, 42n); // inventory_base
    writeI128(buf, 64 + 128, 999n); // max_inventory_abs
    expect(parseMatcherInventory(buf)).toBe(42n);
    const caps = parseMatcherCaps(buf);
    expect(caps).not.toBeNull();
    expect(caps!.maxFillAbs).toBe(111n);
    expect(caps!.maxInventoryAbs).toBe(999n);
  });

  it("returns null on a buffer too short for the field", () => {
    expect(parseMatcherInventory(Buffer.alloc(64 + 96 + 8))).toBeNull();
  });
});
