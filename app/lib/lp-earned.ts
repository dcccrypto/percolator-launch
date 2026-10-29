/**
 * Exact per-user earnings for the Earn (wrapper LP vault) position card.
 *
 * The chain does not record what a depositor paid for their LP shares, so the
 * cost basis comes from the indexer (percolator-indexer#207): an average-cost
 * fold over the user's DepositToLpVault / ExecuteRedemption instructions.
 *
 *   value      = claimShares × vaultTotalAtoms / lpSupply     (same basis as Position Value)
 *   unrealized = value − cost_basis_atoms
 *   earned     = unrealized + realized_pnl_atoms              (realized = past redemptions)
 *
 * An exact figure is shown ONLY when it really is exact:
 *  - the indexer says `basisKnown` (no LP moved outside the vault, every event decoded), and
 *  - the indexer's share count equals what the wallet holds on-chain right now
 *    (held + escrowed in a pending redemption). A mismatch means the indexer is
 *    behind or the LP moved; either way the basis does not describe these shares.
 * Otherwise the card says the figure is unavailable rather than guessing. An
 * estimate "since par" was rejected in review (#2675): the vault's share price
 * includes fees earned before a late depositor joined, so it can show earnings
 * for a deposit that earned nothing.
 */

export interface LpCostBasis {
  basisKnown: boolean;
  /** Indexed claim: held + pending-redemption shares (raw LP units). */
  lpShares: bigint;
  costBasisAtoms: bigint;
  realizedPnlAtoms: bigint;
}

export type LpEarned =
  | { kind: "exact"; earnedAtoms: bigint; unrealizedAtoms: bigint; realizedAtoms: bigint; costBasisAtoms: bigint }
  | { kind: "unavailable"; reason: "no-data" | "basis-unknown" | "out-of-sync" | "no-supply" | "unpriced" };

export function computeExactLpEarned(args: {
  basis: LpCostBasis | null;
  userLpBalance: bigint;
  pendingRedemptionShares: bigint;
  vaultTotalAtoms: bigint;
  lpSupply: bigint;
}): LpEarned {
  const { basis, userLpBalance, pendingRedemptionShares, vaultTotalAtoms, lpSupply } = args;
  if (!basis) return { kind: "unavailable", reason: "no-data" };
  if (!basis.basisKnown) return { kind: "unavailable", reason: "basis-unknown" };
  const claim = userLpBalance + pendingRedemptionShares;
  if (claim !== basis.lpShares) return { kind: "unavailable", reason: "out-of-sync" };
  if (lpSupply <= 0n) return { kind: "unavailable", reason: "no-supply" };
  const value = (claim * vaultTotalAtoms) / lpSupply;
  const unrealized = value - basis.costBasisAtoms;
  return {
    kind: "exact",
    earnedAtoms: unrealized + basis.realizedPnlAtoms,
    unrealizedAtoms: unrealized,
    realizedAtoms: basis.realizedPnlAtoms,
    costBasisAtoms: basis.costBasisAtoms,
  };
}

/** Parse the /api/earn/:slab/position/:wallet payload (amounts are decimal strings). */
export function parseLpCostBasis(json: unknown): LpCostBasis | null {
  if (!json || typeof json !== "object") return null;
  const j = json as Record<string, unknown>;
  if (j.available !== true) return null;
  const big = (v: unknown): bigint | null => {
    if (typeof v !== "string" || !/^-?\d+$/.test(v)) return null;
    return BigInt(v);
  };
  const lpShares = big(j.lpShares);
  const costBasisAtoms = big(j.costBasisAtoms);
  const realizedPnlAtoms = big(j.realizedPnlAtoms);
  if (lpShares === null || costBasisAtoms === null || realizedPnlAtoms === null) return null;
  return { basisKnown: j.basisKnown === true, lpShares, costBasisAtoms, realizedPnlAtoms };
}

/**
 * The slice of `useInsuranceLP` state the Earned figure is priced from. On a two-pot
 * (non-bound) vault `vaultTotalAtoms` is already the program's combined NAV, and it is
 * spread over the registry's shares (`splitPot.totalShares`), not the LP mint supply —
 * the same pair the card's Value uses, so Earned never disagrees with Value.
 * On a BOUND vault (`bound`) the pair is the withdraw pricing (lib/limits/earn-display.ts):
 * the program's senior value over registry shares, so a loss shows in Earned.
 */
export interface LpVaultValuationState {
  bound?: boolean;
  userLpBalance: bigint;
  pendingRedemptionShares: bigint;
  vaultTotalAtoms: bigint;
  lpSupply: bigint;
  splitPot: { totalShares: bigint } | null;
}

export function computeLpEarnedForVault(
  basis: LpCostBasis | null,
  state: LpVaultValuationState,
  pricing?: { totalShares: bigint; withdrawSeniorValue: bigint | null } | null,
): LpEarned {
  if (state.bound) {
    if (!basis) return { kind: "unavailable", reason: "no-data" };
    if (!pricing || pricing.withdrawSeniorValue === null) return { kind: "unavailable", reason: "unpriced" };
    return computeExactLpEarned({
      basis,
      userLpBalance: state.userLpBalance,
      pendingRedemptionShares: state.pendingRedemptionShares,
      vaultTotalAtoms: pricing.withdrawSeniorValue,
      lpSupply: pricing.totalShares,
    });
  }
  return computeExactLpEarned({
    basis,
    userLpBalance: state.userLpBalance,
    pendingRedemptionShares: state.pendingRedemptionShares,
    vaultTotalAtoms: state.vaultTotalAtoms,
    lpSupply: state.splitPot?.totalShares ?? state.lpSupply,
  });
}
