/**
 * E: the `isSentinelValue` guard on `account.pnl` was applied for DISPLAY
 * (PositionsDock.tsx:202, PositionPanel.tsx:297, AccountsCard.tsx:72) but NOT
 * before that SAME raw pnl fed `estimateEntryFromPnl` (PositionsDock.tsx:186,
 * OrderTicket.tsx:356, usePortfolio.ts:264) — a sentinel (u64::MAX-class)
 * uninitialized-field value could poison the derived entry price for a SHORT
 * position, because `estimateEntryFromPnl`'s own `entry > 0n ? entry :
 * oraclePrice` clamp only catches a negative/zero result, not an
 * absurdly-large-but-positive one.
 *
 * Fix: guard with `isSentinelValue(pnl) ? 0n : pnl` at the FIRST consumer
 * (immediately before the estimateEntryFromPnl call), not just at display time.
 */
import { describe, it, expect } from "vitest";
import { estimateEntryFromPnl } from "@/lib/trading";
import { isSentinelValue } from "@/lib/health";

describe("estimateEntryFromPnl: sentinel pnl must be guarded BEFORE it enters the math", () => {
  const oraclePriceE6 = 81_170_000n; // $81.17

  it("an unguarded sentinel pnl on a SHORT position produces an absurd (but positive) entry price", () => {
    const shortSize = -1_000_000n; // short 1 SOL
    const sentinelPnl = 18_446_744_073_709_551_615n; // u64::MAX, an uninitialized-field sentinel

    // Unguarded: entry = oraclePrice + diff, and `diff` is astronomically large —
    // but the sign keeps `entry` POSITIVE, so estimateEntryFromPnl's own
    // `entry > 0n ? entry : oraclePrice` fallback does NOT catch this.
    const unguardedEntry = estimateEntryFromPnl(shortSize, sentinelPnl, oraclePriceE6);
    expect(unguardedEntry).toBeGreaterThan(oraclePriceE6 * 1_000_000n); // wildly wrong, but survives the clamp
  });

  it("guarding with isSentinelValue BEFORE the call yields the safe (mark-price) fallback", () => {
    const shortSize = -1_000_000n;
    const sentinelPnl = 18_446_744_073_709_551_615n;

    expect(isSentinelValue(sentinelPnl)).toBe(true);
    const safePnl = isSentinelValue(sentinelPnl) ? 0n : sentinelPnl;
    const guardedEntry = estimateEntryFromPnl(shortSize, safePnl, oraclePriceE6);
    expect(guardedEntry).toBe(oraclePriceE6); // flat pnl -> entry falls back to the mark
  });

  it("a genuine (non-sentinel) pnl is passed through unchanged by the guard", () => {
    const longSize = 1_000_000n;
    const realPnl = 6_170_000n; // a real, small +$6.17 collateral pnl
    expect(isSentinelValue(realPnl)).toBe(false);
    const safePnl = isSentinelValue(realPnl) ? 0n : realPnl;
    expect(safePnl).toBe(realPnl);
    expect(estimateEntryFromPnl(longSize, safePnl, oraclePriceE6)).toBe(
      estimateEntryFromPnl(longSize, realPnl, oraclePriceE6),
    );
  });

  it("the u64::MAX sentinel threshold boundary is guarded consistently with lib/health.ts", () => {
    // Mirrors lib/health.ts's own U64_SENTINEL_THRESHOLD (~97.5% of u64::MAX).
    const justBelowThreshold = 17_999_999_999_999_999_999n;
    const justAtThreshold = 18_000_000_000_000_000_000n;
    expect(isSentinelValue(justBelowThreshold)).toBe(false);
    expect(isSentinelValue(justAtThreshold)).toBe(true);
  });
});
