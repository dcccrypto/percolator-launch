/**
 * Resolving a list of per-market details without making every row wait for the
 * slowest one.
 *
 * My Markets fetches `/api/markets/[slab]` for each market the creator owns and
 * publishes the whole map at once:
 *
 *     Promise.all(list.map(fetchDetail)).then((results) => { ...; setDetails(next); })
 *
 * The requests run in parallel, but nothing is rendered until the LAST one
 * settles — so every row shows its truncated mint address until the slowest
 * market resolves. Measured on the live playground: four markets returned in
 * 517-635ms and the list waited 1022ms, holding the fast ones back ~400-500ms
 * on a good run. A market that is slow, retrying, or failing makes every other
 * row wait out its full timeout.
 *
 * `applyResolved` is the incremental form: each detail is merged as it lands,
 * so a row fills in the moment ITS OWN fetch returns and is never gated on a
 * sibling.
 *
 * Two details that matter and are easy to get wrong:
 *
 *   - a null result (fetch failed, or the market is not in the DB) must NOT
 *     erase a detail that is already on screen. That turns one transient 500
 *     into a row reverting to a mint address.
 *   - the merge must ignore a result belonging to a slab that is no longer in
 *     the list, or a late response from a previous wallet's markets paints
 *     into the current one.
 */

export interface ResolvedDetail<T> {
  slab: string;
  detail: T | null;
}

/**
 * Merge one resolved detail into the map already on screen.
 *
 * Returns the SAME object when nothing changes, so a caller using it in
 * `setState` does not re-render on a no-op (a failed fetch for an unknown slab
 * is the common case).
 */
export function applyResolved<T>(
  current: Record<string, T>,
  resolved: ResolvedDetail<T>,
  allowedSlabs: readonly string[],
): Record<string, T> {
  // Not in the current list: a late response from a previous wallet or a
  // market the creator no longer owns. Dropping it is the whole point.
  if (!allowedSlabs.includes(resolved.slab)) return current;
  // A failed read is not evidence the market has no detail — keep what is
  // already shown rather than reverting the row to its mint address.
  if (resolved.detail == null) return current;
  if (current[resolved.slab] === resolved.detail) return current;
  return { ...current, [resolved.slab]: resolved.detail };
}

/**
 * Seed a map from a synchronous cache before any request goes out.
 *
 * Used by hooks/useMarketIdentities.ts to paint tickers from the session
 * identity cache on the first committed render: /my-markets WROTE that cache on
 * every resolve and never read it back, so returning to the page re-showed
 * placeholders for a full second with the answer already in memory.
 *
 * NOTE: seed a map of IDENTITY, never a map of per-market detail. Presence in
 * the detail map means "this market has its numbers in", and an identity-only
 * placeholder there makes the page publish a $0.00 liquidity aggregate as a
 * finished figure. `getSeed` returns null for a miss.
 */
export function seedFromCache<T>(
  slabs: readonly string[],
  getSeed: (slab: string) => T | null,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const slab of slabs) {
    const seed = getSeed(slab);
    if (seed != null) out[slab] = seed;
  }
  return out;
}
