/**
 * Shared filter logic for counting "active" markets.
 *
 * A market is active if it has at least one non-zero, non-sentinel stat
 * (price, volume, or open interest). Sentinel values ≈ u64::MAX (1.844e19)
 * are treated as zero because they come from uninitialized on-chain fields.
 *
 * SINGLE SOURCE OF TRUTH: used by homepage, /api/stats, and markets page
 * to ensure consistent market counts across the platform.
 */

/** Returns true if a numeric value is sane (positive, finite, not a u64::MAX sentinel). */
export function isSaneMarketValue(v: number | null | undefined): boolean {
  if (v == null) return false;
  return v > 0 && v < 1e18 && Number.isFinite(v);
}

/**
 * Determine if a market row (from markets_with_stats) is "active".
 * A market is active if it has at least one sane metric.
 */
export function isActiveMarket(row: {
  last_price?: number | null;
  volume_24h?: number | null;
  total_open_interest?: number | null;
  open_interest_long?: number | null;
  open_interest_short?: number | null;
}): boolean {
  if (isSaneMarketValue(row.last_price)) return true;
  if (isSaneMarketValue(row.volume_24h)) return true;
  if (isSaneMarketValue(row.total_open_interest)) return true;
  // Fallback: sum of long + short OI
  const combinedOI = (row.open_interest_long ?? 0) + (row.open_interest_short ?? 0);
  if (isSaneMarketValue(combinedOI)) return true;
  return false;
}

/**
 * Determine if a market row is a "zombie" — has no LP liquidity and no real activity.
 *
 * Three zombie conditions (GH#1420 + GH#1427 + GH#1499):
 *   1. vault_balance === 0 AND no sane stats AND total_accounts === 0
 *      → drained/dead market with no activity (even if c_tot > 0 from stale slab data).
 *   2. vault_balance === null AND no sane stats AND total_accounts === 0
 *      → phantom market that was never indexed or funded.
 *   3. (Legacy) vault_balance === 0 with no c_tot and no activity
 *      → explicitly drained vault.
 *
 * GH#1499 edge case — "c_tot > 0 → not zombie" is too broad:
 * NNOB has c_tot=100B but vault=0, zero accounts, and null price because no oracle
 * keeper cranks it. After PR#1496 (c_tot > 0 → short-circuit return false), NNOB
 * escaped the zombie filter and appeared in the default response with null prices.
 * Fix: c_tot > 0 only exempts a market from zombie status when there is corroborating
 * activity — a live price (keeper is cranking) OR real accounts (users have positions).
 * Without either, c_tot is legacy collateral in a dead slab and should be zombie.
 *
 * GH#1502 edge case — phantom OI in hasActivity:
 * NNOB showed is_zombie=false even after PR#1501 because its raw DB total_open_interest
 * was a non-zero stale value (phantom OI per GH#1290). The hasActivity check included
 * isSaneMarketValue(total_open_interest), which was true for NNOB → hasActivity=true
 * → c_tot>0 && hasActivity → return false (not zombie). But per GH#1290, OI without
 * any accounts is phantom by definition (StatsCollector invariant). Fix: only count
 * OI as activity when total_accounts > 0 — i.e. real users have positions.
 *
 * FF7K keeper markets (33 of 34): vault=0, c_tot>0, have prices → hasActivity=true → not zombie ✓
 * NNOB (the outlier): vault=0, c_tot>0, no price, no accounts, phantom OI → hasActivity=false → zombie ✓
 *
 * SINGLE SOURCE OF TRUTH: used by /api/markets and /api/stats to ensure
 * consistent zombie exclusion across the platform. Previously duplicated
 * inline in both routes (CodeRabbit PR #1466 nitpick).
 */
export function isZombieMarket(row: {
  vault_balance?: number | null;
  c_tot?: number | null;
  last_price?: number | null;
  volume_24h?: number | null;
  total_open_interest?: number | null;
  total_accounts?: number | null;
}): boolean {
  // REDUCED SCHEMA (2026-07): market_stats no longer mirrors vault_balance, c_tot,
  // total_accounts or total_open_interest — the frontend reads vault/OI/insurance
  // live from chain instead. A DB row therefore OMITS those keys entirely.
  //
  // Every check below reads absence as death: `vault_balance ?? null` collapses
  // undefined to null, hasActivity sees `total_accounts ?? 0` as 0, and the
  // null-vault branch then returns true. That classified all four live devnet
  // markets as zombies and served an empty market list (total:0, zombieCount:4).
  //
  // Absent is not zero. Without any of the three liveness signals there is no
  // evidence either way, so decline to classify. Genuinely dead markets are still
  // excluded upstream: the indexer's sweep sets status=closed + indexer_excluded
  // on dust-vault/no-account slabs, and both the view and the query filter those.
  const hasLivenessSignals =
    row.vault_balance !== undefined ||
    row.c_tot !== undefined ||
    row.total_accounts !== undefined;
  if (!hasLivenessSignals) return false;

  const vaultBal = row.vault_balance ?? null;
  const cTot = row.c_tot ?? null;

  // Compute whether this market has any live activity — price, volume, or real accounts.
  // Used to validate the c_tot exemption (GH#1499).
  //
  // GH#1502: OI is intentionally excluded from hasActivity. Per GH#1290, OI without any
  // accounts is phantom (stale slab data). NNOB had non-zero raw total_open_interest but
  // zero accounts — including OI here caused hasActivity=true → c_tot>0 exemption fired
  // → is_zombie=false even though no keeper or users exist. Only price (oracle is cranking)
  // or accounts (users have positions) prove a market is genuinely live.
  const hasActivity =
    isSaneMarketValue(row.last_price) ||
    isSaneMarketValue(row.volume_24h) ||
    (row.total_accounts ?? 0) > 0;

  // If on-chain collateral total (c_tot) is positive AND there is corroborating activity,
  // the market has real funds and a live oracle — not a zombie.
  // FF7K keeper markets: vault=0 (stores collateral in slab), c_tot>0, prices present → active.
  //
  // GH#1499: Do NOT exempt when c_tot>0 but vault=0, accounts=0, and no price.
  // That pattern means the slab has legacy collateral but no active keeper or positions.
  // In that case, fall through to the vault_balance=0 zombie check below.
  if (cTot !== null && cTot > 0 && hasActivity) return false;

  // GH#2029: vault_balance=0 only means zombie when there's zero evidence of life.
  // The 7T1E mainnet market has vault_balance=0 (collateral in slab) but last_price=79.5
  // (keeper is cranking). Without this guard, live markets get hidden as zombies.
  if (vaultBal !== null && vaultBal === 0 && !hasActivity) return true;
  if (vaultBal === null) {
    // GH#1502: OI intentionally excluded from hasNoStats check (same logic as hasActivity above).
    // OI without accounts is phantom per GH#1290 — a null-vault market with phantom OI
    // and no real price or users should still be zombie.
    const hasNoStats =
      !isSaneMarketValue(row.last_price) &&
      !isSaneMarketValue(row.volume_24h) &&
      (row.total_accounts ?? 0) === 0;
    if (hasNoStats) return true;
  }
  return false;
}
