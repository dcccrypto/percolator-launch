/**
 * v1 close-only policy for the trade ticket. v1 keeps pricing and cranking so exits are safe, but
 * takes no new risk. A trade that only REDUCES an existing position (never flips it) is a close and
 * stays allowed; so do withdrawals and everything outside the open-order button.
 */
export type TradeDirection = "long" | "short";

/**
 * `existing` is the signed position (positive long, negative short); `size` the positive size of
 * the order in the same base units. True when the order leaves the account with more exposure.
 */
export function isRiskIncreasing(existing: bigint, direction: TradeDirection, size: bigint): boolean {
  if (size <= 0n) return false;
  if (existing === 0n) return true;
  const sameSide = (existing > 0n) === (direction === "long");
  if (sameSide) return true;
  const abs = existing < 0n ? -existing : existing;
  return size > abs; // flipping through zero opens the other side
}

/** The ticket must refuse this order on a v1 close-only market. */
export function v1BlocksOrder(p: { v1CloseOnly: boolean; existing: bigint; direction: TradeDirection; size: bigint }): boolean {
  return p.v1CloseOnly && isRiskIncreasing(p.existing, p.direction, p.size);
}
