/**
 * GH#2362 — which worst-fill bound actually gets submitted.
 *
 * The trade confirmation modal computes a `worstFillPriceE6` and shows it to
 * the user as the binding slippage limit. That reviewed value must be the one
 * the transaction carries; previously it was dropped and `useTrade` re-derived
 * a bound from the live mark at submit time, so any price move between opening
 * the modal and pressing Confirm silently changed the protection the user had
 * approved.
 *
 * The subtlety is the zero case. The on-chain handler treats
 * `limit_price_e6 == 0` as a "no limit" sentinel and skips the slippage check
 * entirely (percolator.rs::handle_trade_cpi); `useTrade` deliberately preserves
 * an explicit `0n` as an opt-in escape hatch for keeper/bot paths. But the
 * modal's snapshot is *also* `0n` whenever its computation threw or no live
 * price was available. Forwarding that zero would convert "the bound might not
 * match what you saw" into "there is no bound at all" — strictly worse than the
 * bug being fixed.
 *
 * So: forward a positive reviewed bound, and otherwise return undefined, which
 * makes `useTrade` derive a fresh non-zero limit exactly as it did before.
 */
export function resolveSubmittedLimitPriceE6(
  reviewedWorstFillPriceE6: bigint | undefined,
): bigint | undefined {
  if (reviewedWorstFillPriceE6 === undefined) return undefined;
  if (reviewedWorstFillPriceE6 <= 0n) return undefined;
  return reviewedWorstFillPriceE6;
}
