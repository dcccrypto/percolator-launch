/**
 * Shared phantom-OI helpers.
 *
 * "Phantom OI" = open interest that is NOT backed by real positions:
 *   - markets with no accounts (vault was never seeded with traders), OR
 *   - markets whose vault_balance is below the creation-deposit threshold (1 USDC = 1_000_000 micro-units).
 *
 * This is the single source of truth used by both /api/markets and /api/stats.
 * Previously each route maintained its own copy of the constant and predicate,
 * which led to drift (GH#1432, GH#1435, GH#1438).
 *
 * Rule: vault_balance < MIN_VAULT_FOR_OI  →  phantom (strict <).
 *   vault=0       → phantom  (no LP deposit)
 *   vault=1–999_999 → phantom  (dust / creation not finalised)
 *   vault=1_000_000 → NOT phantom  (standard creation-deposit; all active devnet markets)
 *   vault>1_000_000 → NOT phantom  (real LP liquidity)
 */

/** Minimum vault_balance (micro-units) for a market to be considered non-phantom. */
export const MIN_VAULT_FOR_OI = 1_000_000;

/**
 * Returns true when a market's open interest should be treated as phantom
 * (suppressed / excluded from aggregates).
 *
 * @param accountsCount  Value of `total_accounts` from the market row (0 when null).
 * @param vaultBalance   Value of `vault_balance`   from the market row (0 when null).
 */
export function isPhantomOpenInterest(
  accountsCount: number | null | undefined,
  vaultBalance: number,
): boolean {
  // REDUCED SCHEMA (2026-07): total_accounts is no longer mirrored into
  // market_stats, so callers reading it from the DB get null/undefined rather
  // than a count. Coercing that to 0 asserts "this market definitely has no
  // accounts" — which made EVERY market's OI phantom and zeroed it, even
  // markets with hundreds of millions in vault and OI that /api/open-interest
  // reported correctly from the same slab.
  //
  // Unknown is not zero. Both conditions guard one hazard — a stale slab
  // carrying OI counters with nothing real behind it — and the vault condition
  // catches it on its own, now that vault_balance is read live from the chain.
  // So an unknown account count simply abstains instead of voting "phantom".
  const noAccounts = accountsCount != null && accountsCount === 0;
  return noAccounts || vaultBalance < MIN_VAULT_FOR_OI;
}
