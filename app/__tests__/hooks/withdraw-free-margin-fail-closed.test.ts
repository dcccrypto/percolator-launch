/**
 * D: hooks/useWithdraw.ts + components/trade/DepositWithdrawCard.tsx's
 * free-margin guard silently DISABLED itself on an entry-cache miss —
 * `getEntryPrice` returns 0n when nothing is cached, `computePositionInitialMargin`
 * is guarded to return 0n for `entryPriceE6 <= 0n` (lib/trading.ts:63), so
 * lockedMargin fell to 0 and "Max" offered the account's FULL capital even
 * with an open position backing part of it — the resulting withdrawal then
 * reverted on-chain.
 *
 * The fix mirrors OrderTicket's existing 3-step fallback (on-chain entry_price
 * -> locally-cached entry -> `estimateEntryFromPnl` estimate) and, if even
 * that can't establish an entry price, fails CLOSED: locks the WHOLE capital
 * rather than none of it.
 *
 * This test exercises the REAL `computePositionInitialMargin` /
 * `estimateEntryFromPnl` from lib/trading.ts (not a mirror) plus a small,
 * documented mirror of the fail-closed decision tree now inlined in
 * DepositWithdrawCard.tsx / useWithdraw.ts.
 */
import { describe, it, expect } from "vitest";
import { computePositionInitialMargin, estimateEntryFromPnl } from "@/lib/trading";

const INITIAL_MARGIN_BPS = 1000n; // 10%

/** Mirrors the fixed lockedMargin decision in DepositWithdrawCard.tsx / useWithdraw.ts. */
function computeLockedMargin(params: {
  hasOpenPosition: boolean;
  positionSize: bigint;
  capital: bigint;
  rawEntryPrice: bigint;   // on-chain entry_price, 0n if not stored (v17)
  cachedEntryPrice: bigint; // lib/entry-price.ts cache, 0n on a miss
  oraclePriceE6: bigint;   // live/wrapper mark price available for the estimate fallback
  pnl: bigint;             // portfolio.pnl (already sentinel-guarded by the caller)
}): bigint {
  const estimatedEntryPrice =
    params.hasOpenPosition && params.oraclePriceE6 > 0n
      ? estimateEntryFromPnl(params.positionSize, params.pnl, params.oraclePriceE6)
      : 0n;
  const effectiveEntryPrice =
    params.rawEntryPrice > 0n
      ? params.rawEntryPrice
      : params.cachedEntryPrice > 0n
        ? params.cachedEntryPrice
        : estimatedEntryPrice;

  if (!params.hasOpenPosition) return 0n;
  if (effectiveEntryPrice > 0n) {
    return computePositionInitialMargin(params.positionSize, effectiveEntryPrice, INITIAL_MARGIN_BPS);
  }
  // Fail closed: no entry price could be established at all.
  return params.capital;
}

describe("withdraw free-margin guard: fail closed on an unresolvable entry price", () => {
  const capital = 10_000_000_000n; // 10,000 sim-USDC
  const positionSize = 1_000_000n; // 1 SOL long
  const oraclePriceE6 = 81_170_000n; // $81.17

  it("BUG (old behavior): a cache miss with no fallback silently unlocks the FULL account", () => {
    // Old code path: ONLY getEntryPrice() — no estimate, no fail-closed.
    const oldLockedMargin = computePositionInitialMargin(positionSize, 0n, INITIAL_MARGIN_BPS);
    expect(oldLockedMargin).toBe(0n); // the bug: margin computed off a 0 entry price
    const oldFreeMargin = capital > oldLockedMargin ? capital - oldLockedMargin : 0n;
    expect(oldFreeMargin).toBe(capital); // "Max" offered the WHOLE account
  });

  it("FIX: on-chain entry_price, when present, is used directly", () => {
    const locked = computeLockedMargin({
      hasOpenPosition: true,
      positionSize,
      capital,
      rawEntryPrice: 75_000_000n, // $75, stored on-chain (legacy v12 path)
      cachedEntryPrice: 0n,
      oraclePriceE6,
      pnl: 0n,
    });
    // notional = 1 * 75 = $75; margin @ 10% = $7.50
    expect(locked).toBe(computePositionInitialMargin(positionSize, 75_000_000n, INITIAL_MARGIN_BPS));
    expect(locked).toBeGreaterThan(0n);
  });

  it("FIX: falls back to the locally-cached entry price on a v17 cache hit", () => {
    const locked = computeLockedMargin({
      hasOpenPosition: true,
      positionSize,
      capital,
      rawEntryPrice: 0n, // v17 never stores this on-chain
      cachedEntryPrice: 78_000_000n, // saved at trade-open time
      oraclePriceE6,
      pnl: 0n,
    });
    expect(locked).toBe(computePositionInitialMargin(positionSize, 78_000_000n, INITIAL_MARGIN_BPS));
    expect(locked).toBeGreaterThan(0n);
  });

  it("FIX: falls back to estimateEntryFromPnl on a cache MISS (2nd device / NFT transfer)", () => {
    // A winning position: mark $81.17, +$6.17 collateral pnl implies entry $75.
    const pnl = 6_170_000n;
    const locked = computeLockedMargin({
      hasOpenPosition: true,
      positionSize,
      capital,
      rawEntryPrice: 0n,
      cachedEntryPrice: 0n, // the cache miss the old code silently failed on
      oraclePriceE6,
      pnl,
    });
    const impliedEntry = estimateEntryFromPnl(positionSize, pnl, oraclePriceE6);
    expect(impliedEntry).toBeGreaterThan(0n);
    expect(locked).toBe(computePositionInitialMargin(positionSize, impliedEntry, INITIAL_MARGIN_BPS));
    expect(locked).toBeGreaterThan(0n); // NOT the old bug's 0n
    // freeMargin is now correctly less than full capital.
    const freeMargin = capital > locked ? capital - locked : 0n;
    expect(freeMargin).toBeLessThan(capital);
  });

  it("FIX: fails CLOSED (locks the whole account) when NO entry price can be established at all", () => {
    // No on-chain entry, no cache, AND no oracle price yet to run the estimate —
    // exactly the scenario the old code silently treated as "0 margin locked".
    const locked = computeLockedMargin({
      hasOpenPosition: true,
      positionSize,
      capital,
      rawEntryPrice: 0n,
      cachedEntryPrice: 0n,
      oraclePriceE6: 0n, // no live price available yet
      pnl: 0n,
    });
    expect(locked).toBe(capital); // fail closed — NOT 0n
    const freeMargin = capital > locked ? capital - locked : 0n;
    expect(freeMargin).toBe(0n); // Max button (gated on freeMargin > 0n) does not render
  });

  it("a FLAT account (no open position) is unaffected — full capital is free", () => {
    const locked = computeLockedMargin({
      hasOpenPosition: false,
      positionSize: 0n,
      capital,
      rawEntryPrice: 0n,
      cachedEntryPrice: 0n,
      oraclePriceE6: 0n,
      pnl: 0n,
    });
    expect(locked).toBe(0n);
  });
});
