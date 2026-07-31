/**
 * Split an over-cap close into legs the matcher will actually fill.
 *
 * WHY: the matcher fills at most `maxFillAbs` per fill and does NOT partial-
 * fill — an oversized request is clamped, the wrapper's validate_matcher_return
 * sees the mismatch, and the whole trade reverts with a bare
 * InvalidAccountData. A position can legitimately be up to 4× the fill cap
 * (maxInventoryAbs = 4 × maxFillAbs by construction in deriveMarketParams), so
 * "Close 100%" on a large position is GUARANTEED to fail as a single trade.
 *
 * The fix is BatchTradeCpi (tag 67): several legs in one instruction, one
 * signature — each leg individually under the cap, so each passes the
 * matcher's per-fill clamp. This module is the leg math; the caller feeds the
 * legs to encodeBatchTradeCpi.
 *
 * Legs are near-equal (remainder spread one unit at a time across the first
 * legs) rather than cap-cap-cap-dust: a dust-sized final leg risks the
 * engine's minimum-size floors, and equal legs carry no downside.
 */

/**
 * Split `closeSize` (signed, the exact total that must execute) into legs
 * whose |value| ≤ maxFillAbs, all sharing its sign, summing to it exactly.
 *
 * `maxFillAbs <= 0` means "no known cap" — the size passes through as one leg.
 */
export function chunkCloseSize(closeSize: bigint, maxFillAbs: bigint): bigint[] {
  if (closeSize === 0n) return [];
  const abs = closeSize < 0n ? -closeSize : closeSize;
  if (maxFillAbs <= 0n || abs <= maxFillAbs) return [closeSize];

  // ceil(abs / maxFillAbs) legs, near-equal split.
  const n = (abs + maxFillAbs - 1n) / maxFillAbs;
  const base = abs / n;
  const rem = abs % n; // first `rem` legs carry one extra unit
  const sign = closeSize < 0n ? -1n : 1n;

  const legs: bigint[] = [];
  for (let i = 0n; i < n; i++) {
    const legAbs = i < rem ? base + 1n : base;
    legs.push(sign * legAbs);
  }
  return legs;
}
