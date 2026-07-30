/**
 * Matcher fill-cap parsing — the ceiling the order ticket must respect.
 *
 * Regression context (devnet, 2026-07-29): market 5sDvEs2… had
 * maxFillAbs = 735,835,172,921. A trade of exactly that size succeeded and
 * maxFillAbs + 1 failed with a bare `InvalidAccountData`, because the matcher
 * clamps an oversized fill without setting FLAG_PARTIAL_OK and the wrapper
 * then rejects the under-fill. The ticket offered $5,000 of buying power into
 * a market that could fill ~$9.57, so it has to read this cap and block first.
 */
import { describe, it, expect } from "vitest";
import { parseMatcherCaps } from "@/lib/matcherCaps";

const CTX_VAMM_OFFSET = 64;
const MATCHER_CTX_LEN = 320;

/** Build a matcher-context account with the given caps at the real offsets. */
function makeCtx(maxFillAbs: bigint, maxInventoryAbs: bigint): Buffer {
  const buf = Buffer.alloc(MATCHER_CTX_LEN);
  const writeU128 = (off: number, v: bigint) => {
    buf.writeBigUInt64LE(v & 0xffff_ffff_ffff_ffffn, off);
    buf.writeBigUInt64LE(v >> 64n, off + 8);
  };
  writeU128(CTX_VAMM_OFFSET + 80, maxFillAbs);
  writeU128(CTX_VAMM_OFFSET + 128, maxInventoryAbs);
  return buf;
}

describe("parseMatcherCaps", () => {
  it("reads the real on-chain caps for market 5sDvEs2…", () => {
    // Exact values read from matcher ctx A6oAY5Zp… on devnet.
    const caps = parseMatcherCaps(makeCtx(735_835_172_921n, 2_943_340_691_685n));
    expect(caps).not.toBeNull();
    expect(caps!.maxFillAbs).toBe(735_835_172_921n);
    expect(caps!.maxInventoryAbs).toBe(2_943_340_691_685n);
  });

  it("keeps the documented maxFill = maxInventory / 4 relationship", () => {
    const caps = parseMatcherCaps(makeCtx(735_835_172_921n, 2_943_340_691_685n))!;
    expect(caps.maxInventoryAbs / 4n).toBe(caps.maxFillAbs);
  });

  it("handles caps above 2^64 (u128, not u64)", () => {
    const big = (1n << 100n) + 12_345n;
    const caps = parseMatcherCaps(makeCtx(big, big * 4n))!;
    expect(caps.maxFillAbs).toBe(big);
  });

  it("returns null for an account too short to hold a vAMM context", () => {
    expect(parseMatcherCaps(Buffer.alloc(64))).toBeNull();
  });

  it("flags exactly the sizes that failed on-chain", () => {
    const { maxFillAbs } = parseMatcherCaps(makeCtx(735_835_172_921n, 2_943_340_691_685n))!;
    // The bisected boundary: cap OK, cap+1 rejected by the wrapper.
    const overCap = (size: bigint) => size > maxFillAbs;
    expect(overCap(maxFillAbs)).toBe(false);
    expect(overCap(maxFillAbs + 1n)).toBe(true);
    // The user's actual $5,000 order at the (broken) oracle price.
    expect(overCap(384_615_384_615_384n)).toBe(true);
  });

  it("converts the cap to collateral notional the way the ticket does", () => {
    const { maxFillAbs } = parseMatcherCaps(makeCtx(735_835_172_921n, 2_943_340_691_685n))!;
    // At the broken SOL-denominated price (13e-6) the cap read as ~$9.57 …
    expect(Number((maxFillAbs * 13n) / 1_000_000n) / 1e6).toBeCloseTo(9.57, 1);
    // … and at the correct USD price (943e-6) it is ~$694.
    expect(Number((maxFillAbs * 943n) / 1_000_000n) / 1e6).toBeCloseTo(693.9, 1);
  });
});
