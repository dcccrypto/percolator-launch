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
  // Both 0 AND the i128::MAX sentinel mean "no practical inventory cap" — the
  // newmarkets.ts seed sets maxInventoryAbs to i128::MAX. Collapse both to the
  // sentinel so callers render "unlimited"; otherwise maxInventoryAbs ± inventoryBase
  // is a huge number that slips past a downstream exact `=== UNLIMITED_CAPACITY` check.
  if (maxInventoryAbs === 0n || maxInventoryAbs >= UNLIMITED_CAPACITY) return UNLIMITED_CAPACITY;
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

/**
 * The close ticket's explanation when the LP's inventory cap clamps a close.
 *
 * WHY: the slider is a percent of the WHOLE position, so the "close up to N%" it offers must be
 * too. It used to be `capacity / thisCloseSize`: choosing 50% with room for a fifth of the
 * position said "close up to 40%" (40% of the half), and a 40% retry was refused again. And at
 * zero room it offered "close up to 0% now" at every slider value (TROLL, 2026-10-03: the LP was
 * short exactly its cap, so a short's close (a buy, the LP sells) cannot fill at all).
 *
 * `capacityQ` = remainingSideCapacityQ for the close's side; `positionAbsQ` = |position|.
 */
export function closeCapacityMessage(capacityQ: bigint, positionAbsQ: bigint): string {
  const room = capacityQ > 0n ? capacityQ : 0n;
  const pct = positionAbsQ > 0n ? Number((room * 100n) / positionAbsQ) : 0;
  if (pct <= 0) {
    return (
      "This position can't be closed through the market right now: its liquidity provider is " +
      "already at its exposure limit on your side, so there is nobody to take the other side of " +
      "your close. Room opens up as other traders trade the opposite way; until then the position " +
      "stays open and keeps tracking the price."
    );
  }
  return (
    `The market can take ${pct}% of your position right now: its liquidity provider is at its ` +
    `exposure limit on your side. Close up to ${pct}% now, or wait for other trades to free capacity.`
  );
}

