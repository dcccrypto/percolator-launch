/**
 * PoC + regression — warmup must clamp the on-chain numUsedAccounts before using
 * it as the account-index bound.
 *
 * The route guards `accountIdx >= engine.numUsedAccounts` with the raw on-chain
 * value, and accountIdx has no upper bound (only >= 0). A sentinel/garbage
 * numUsedAccounts (u64::MAX / uninitialized slab) is huge, so the guard passes and
 * parseAccount reads an out-of-range slot. sanitizeAccountCount clamps garbage to 0.
 */
import { describe, it, expect } from "vitest";
import { sanitizeAccountCount } from "@/lib/health";

// Models the guard: rejects (404) when accountIdx >= the (sanitized) count.
const guardRejects = (accountIdx: number, rawNumUsed: number) =>
  accountIdx >= sanitizeAccountCount(rawNumUsed);

describe("warmup account-index clamp", () => {
  it("sanitizeAccountCount clamps sentinel/garbage counts to 0", () => {
    expect(sanitizeAccountCount(Number(2n ** 64n - 1n))).toBe(0); // u64::MAX sentinel
    expect(sanitizeAccountCount(999_999)).toBe(0);                 // above the 4096 slab cap
    expect(sanitizeAccountCount(-1)).toBe(0);
  });

  it("clamps a sentinel/garbage maxAccounts cap to the structural max", () => {
    // The cap is on-chain data too: on an uninitialized slab it is a sentinel, so
    // it must be clamped to MAX_SLAB_ACCOUNTS rather than taken at face value —
    // otherwise a sentinel cap admits the sentinel count it is meant to reject.
    expect(sanitizeAccountCount(Number(2n ** 64n - 1n), Number(2n ** 64n - 1n))).toBe(0);
    expect(sanitizeAccountCount(5000, 999_999)).toBe(0); // cap > 4096 clamped → 5000 rejected
    expect(sanitizeAccountCount(50, 10)).toBe(0);        // real tighter cap honored
    expect(sanitizeAccountCount(5, 10)).toBe(5);         // in range under the real cap
  });

  it("legitimate counts pass through", () => {
    expect(sanitizeAccountCount(10)).toBe(10);
    expect(sanitizeAccountCount(4096)).toBe(4096); // large-slab capacity
  });

  it("guard: garbage count no longer lets an index through (the fix)", () => {
    // Old behavior: accountIdx 5 vs a huge raw count → 5 >= huge is false → PASSES.
    expect(5 >= Number(2n ** 64n - 1n)).toBe(false);   // the old bug
    // Fixed: clamp first → 5 >= 0 → REJECTED.
    expect(guardRejects(5, Number(2n ** 64n - 1n))).toBe(true);
    // A legitimate in-range index is still allowed.
    expect(guardRejects(5, 10)).toBe(false);
  });
});
