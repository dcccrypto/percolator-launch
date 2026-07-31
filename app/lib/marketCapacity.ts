/**
 * Side-capacity math for the order ticket — how much MORE size the market can
 * absorb in the user's chosen direction before the matcher refuses to fill.
 *
 * WHY THIS EXISTS
 * ---------------
 * The matcher enforces TWO ceilings (lib/matcherCaps.ts): `maxFillAbs` per
 * trade, and `maxInventoryAbs` on the LP's NET inventory. The ticket already
 * blocks per-trade violations, but a trade well under the fill cap still
 * reverts (same bare InvalidAccountData, no partial fill) when it would push
 * the LP past its inventory cap — exactly the state a one-sided market drifts
 * into as one direction fills up. Without this check the user "just keeps
 * trying and doesn't know what's wrong".
 *
 * SIGN CONVENTIONS (percolator-match `MatcherCtx.inventory_base`)
 * ---------------------------------------------------------------
 * `inventoryBase` is the LP's own base position: positive = LP long,
 * negative = LP short. The LP takes the OTHER side of every user trade
 * (vamm.rs: `lp_inventory_delta = -fill_size`), so:
 *
 *   user LONG  s  →  newInv = inv − s   → binding bound: inv − s ≥ −maxInv
 *                                        → s ≤ maxInv + inv
 *   user SHORT s  →  newInv = inv + s   → binding bound: inv + s ≤ +maxInv
 *                                        → s ≤ maxInv − inv
 *
 * Note a trade that REDUCES |inventory| is always partially welcome — the
 * capacity formula handles crossing zero automatically (capacity is measured
 * to the far bound, not to zero).
 */

export type TradeSide = "long" | "short";

/**
 * Largest additional size (base-token q units, ≥ 0) the market can absorb in
 * `side` before the LP's net inventory would exceed `maxInventoryAbs`.
 * Ignores the separate per-trade cap — callers combine both.
 */
/**
 * Sentinel: `maxInventoryAbs == 0` means UNLIMITED on-chain (vamm.rs
 * check_inventory_limit v3-compat), NOT zero capacity. Returning 0 here
 * would hard-block every order on a market that fills fine.
 */
export const UNLIMITED_CAPACITY = (1n << 127n) - 1n;

export function remainingSideCapacityQ(
  inventoryBase: bigint,
  maxInventoryAbs: bigint,
  side: TradeSide,
): bigint {
  if (maxInventoryAbs < 0n) return 0n;
  if (maxInventoryAbs === 0n) return UNLIMITED_CAPACITY;
  const cap = side === "long" ? maxInventoryAbs + inventoryBase : maxInventoryAbs - inventoryBase;
  return cap > 0n ? cap : 0n;
}

/**
 * True when a trade of `sizeQ` in `side` would push the LP past its
 * inventory ceiling — i.e. the matcher will clamp, the wrapper will reject,
 * and the user sees an unexplained failure unless we block it here.
 */
export function wouldExceedInventoryCap(
  inventoryBase: bigint,
  maxInventoryAbs: bigint,
  side: TradeSide,
  sizeQ: bigint,
): boolean {
  if (sizeQ <= 0n) return false;
  return sizeQ > remainingSideCapacityQ(inventoryBase, maxInventoryAbs, side);
}
