/**
 * Ordering + search for the Stake page's Insurance Pools list.
 *
 * - Search: keep pools whose `symbol` or `name` contains the query
 *   (case-insensitive; empty query keeps everything).
 * - "My stakes first": a pool the wallet has staked in sorts above the rest,
 *   larger staked value first. Everything else keeps its incoming order via an
 *   explicit index tiebreak (so the result doesn't depend on the JS engine's
 *   sort being stable).
 *
 * Pure and dependency-free so it can be unit-tested in isolation, mirroring
 * `chart-fit.ts`.
 */

export interface StakeOrderable {
  id: string;
  symbol: string;
  name: string;
}

/**
 * @param stakedValueOf returns the wallet's staked value in a pool: `> 0` means
 *   staked (sorts to the top, descending by value); `0` (or negative) means not
 *   staked.
 */
export function orderStakePools<T extends StakeOrderable>(
  pools: readonly T[],
  query: string,
  stakedValueOf: (id: string) => number,
): T[] {
  const q = query.trim().toLowerCase();
  return pools
    .filter(
      (p) =>
        !q ||
        p.symbol.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q),
    )
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const av = stakedValueOf(a.p.id);
      const bv = stakedValueOf(b.p.id);
      const aStaked = av > 0 ? 1 : 0;
      const bStaked = bv > 0 ? 1 : 0;
      if (aStaked !== bStaked) return bStaked - aStaked; // staked pools first
      if (aStaked && bStaked) return bv - av; // larger stake first
      return a.i - b.i; // stable: preserve incoming order otherwise
    })
    .map(({ p }) => p);
}

/**
 * The sort weight for a wallet's position in a pool. "Staked" is defined by
 * holding LP tokens (`lpBalanceRaw > 0`), NOT by `estimatedValue > 0`: the
 * estimate is `(lp / supply) * tvl` and is 0 for an empty/drained pool or a pool
 * with no supply yet, where the wallet still holds LP and must still float to the
 * top. Such a position gets the smallest positive weight (ranked last among
 * staked pools, still above every unstaked one).
 */
export function stakedOrderValue(lpBalanceRaw: bigint, estimatedValue: number | null): number {
  if (lpBalanceRaw <= 0n) return 0;
  // null = the value is unknown (#3611); the wallet still holds LP, so it still sorts with the staked pools.
  return estimatedValue !== null && Number.isFinite(estimatedValue) && estimatedValue > 0 ? estimatedValue : Number.MIN_VALUE;
}
