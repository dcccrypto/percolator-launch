/**
 * Stake pool value for the /stake page and /api/stake/pools (release checklist section 5 item 4): the value includes the
 * insurance a first-loss pool has deployed into the market, not only what sits in the vault. Pure; never throws.
 *
 * Naming: only a first-loss pool (v5 risk_mode 1) is "insurance staking"; fee-only and legacy pools keep "Fee staking".
 * The math is the SDK's `stakePoolValue` (ported in lib/v22/sdk/v22-stake.ts, TODO(repin)). The EXIT reading
 * (`snapInsuranceFreeAtoms`) is used, because this is what a leaving staker is paid. A first-loss pool whose insurance units
 * cannot be read gets NO number (the page shows a dash), never a guess.
 */
import { decodeTerminalInsuranceCapacity } from "./records";
import { decodeInsuranceUnitsV20, decodeStakePoolV5, quoteStakeWithdrawNowV5, stakePoolValue, STAKE_RISK_MODE } from "./sdk";

/**
 * The wrapper's live exit reading for asset 0 (`ins_units_readings_view`): min(sum of the domains' withdraw capacity, insurance), from the raw market
 * account. `InsuranceUnitsV20.snapInsuranceFreeAtoms` is only refreshed when the units account is touched, so after an insurance loss it is stale-high
 * (devnet FGSFL 2026-10-20: 60M snapshot vs 30M live). Null when the market cannot be decoded: callers then keep the snapshot.
 */
export function liveFreeInsuranceAtoms(marketData: Uint8Array | null | undefined): bigint | null {
  if (!marketData) return null;
  try {
    const c = decodeTerminalInsuranceCapacity(marketData, 0);
    const cap = c.domains.reduce((a, d) => a + d.withdrawCapacity, 0n);
    return cap < c.insurance ? cap : c.insurance;
  } catch {
    return null;
  }
}

export type StakePoolKind = "first-loss" | "fee-only" | "legacy";

export interface StakePoolValueView {
  kind: StakePoolKind;
  /** Vault-resident booked value (atoms); null when unknown. */
  liquidAtoms: bigint | null;
  /** Insurance deployed for this pool's stakers (atoms); 0n for a pool that does not deploy; null when unknown. */
  deployedAtoms: bigint | null;
  /** liquid + deployed; null when unknown. */
  totalAtoms: bigint | null;
  /** Close-out: terminal surplus recorded as unclaimed (no real staker); 0n when none. */
  unclaimedAtoms: bigint;
}

/** Null when the account is not a v5 pool (then the caller keeps its legacy math untouched). */
export function stakePoolValueView(poolData: Uint8Array, unitsData: Uint8Array | null | undefined, liveFree?: bigint | null): StakePoolValueView | null {
  let pool;
  try {
    pool = decodeStakePoolV5(poolData);
  } catch {
    return null;
  }
  const kind: StakePoolKind = pool.riskMode === STAKE_RISK_MODE.FirstLoss ? "first-loss" : pool.riskMode === STAKE_RISK_MODE.FeeOnly ? "fee-only" : "legacy";
  if (kind !== "first-loss") {
    const v = stakePoolValue(pool, { unitsStake: 0n, unitsTotal: 0n }, 0n);
    return { kind, liquidAtoms: v?.liquid ?? null, deployedAtoms: v ? 0n : null, totalAtoms: v?.total ?? null, unclaimedAtoms: pool.unclaimedAtoms };
  }
  let v = null;
  if (unitsData) {
    try {
      const u = decodeInsuranceUnitsV20(unitsData);
      const exit = liveFree != null && liveFree < u.snapInsuranceFreeAtoms ? liveFree : u.snapInsuranceFreeAtoms;
      v = stakePoolValue(pool, { unitsStake: u.unitsStake, unitsTotal: u.unitsTotal }, exit);
    } catch {
      v = null;
    }
  }
  return { kind, liquidAtoms: v?.liquid ?? null, deployedAtoms: v?.deployed ?? null, totalAtoms: v?.total ?? null, unclaimedAtoms: pool.unclaimedAtoms };
}

/** The page is called "Insurance staking" only when EVERY listed pool is first-loss; any fee-only / legacy pool keeps "Fee staking". */
export const isInsuranceOnly = (pools: ReadonlyArray<{ stakeKind?: StakePoolKind }>): boolean =>
  pools.length > 0 && pools.every((p) => p.stakeKind === "first-loss");

const USD_DECIMALS = 6;
/** Atoms to a display number (6-decimal collateral, as the rest of /stake); null stays null. */
export const atomsToUsd = (a: bigint | null): number | null => (a === null ? null : Number(a) / 10 ** USD_DECIMALS);

/** What a first-loss staker can take out now (stake processor.rs:1626-1631: a payout must fit the pool's liquid value). */
export interface StakeWithdrawCapView {
  /** True when part of the pool is deployed as insurance and the cap, not the balance, limits the withdrawal. */
  capBinds: boolean;
  /** Largest LP burn (raw) that pays within the cap, never above the balance. */
  maxLpRaw: bigint;
  /** Collateral atoms that burn pays. */
  maxAtoms: bigint;
  /** The rest of the redeem value, returned when the deployed insurance is recovered. */
  deferredAtoms: bigint;
}

/**
 * The withdraw cap for a FIRST_LOSS pool: `min(redeemable, liquid)`. Null (no cap known, keep the balance) for fee-only / legacy pools,
 * and when the pool, the units or the vault balance cannot be read: never a guess.
 *
 * @param poolData     Raw stake pool account.
 * @param unitsData    Raw wrapper `InsuranceUnitsV20` account, or null.
 * @param vaultAtoms   SPL balance of `pool.vault`.
 * @param userLpRaw    The staker's raw LP balance.
 * @returns The cap view, or null.
 * @example
 * ```ts
 * const cap = stakeWithdrawCapView(pool.data, units?.data ?? null, vaultBalance, lpRaw);
 * if (cap?.capBinds) setMax(cap.maxLpRaw);
 * ```
 */
export function stakeWithdrawCapView(poolData: Uint8Array, unitsData: Uint8Array | null | undefined, vaultAtoms: bigint | null, userLpRaw: bigint, liveFree?: bigint | null): StakeWithdrawCapView | null {
  if (vaultAtoms === null || !unitsData) return null;
  try {
    const pool = decodeStakePoolV5(poolData);
    if (pool.riskMode !== STAKE_RISK_MODE.FirstLoss) return null;
    const u = decodeInsuranceUnitsV20(unitsData);
    const q = quoteStakeWithdrawNowV5(pool, { unitsStake: u.unitsStake, unitsTotal: u.unitsTotal }, u.snapInsuranceFreeAtoms, vaultAtoms, userLpRaw, liveFree ?? undefined);
    if (!q) return null;
    // A burn that pays 0 atoms is not a withdrawal: with nothing liquid the largest "fitting" burn can be a dust LP amount worth 0.
    return { capBinds: q.capBinds, maxLpRaw: q.maxCollateralNow === 0n ? 0n : q.maxLpNow, maxAtoms: q.maxCollateralNow, deferredAtoms: q.deferred };
  } catch {
    return null;
  }
}
