/**
 * Stake pool value for the /stake page and /api/stake/pools (release checklist section 5 item 4): the value includes the
 * insurance a first-loss pool has deployed into the market, not only what sits in the vault. Pure; never throws.
 *
 * Naming: only a first-loss pool (v5 risk_mode 1) is "insurance staking"; fee-only and legacy pools keep "Fee staking".
 * The math is the SDK's `stakePoolValue` (ported in lib/v22/sdk/v22-stake.ts, TODO(repin)). The EXIT reading
 * (`snapInsuranceFreeAtoms`) is used, because this is what a leaving staker is paid. A first-loss pool whose insurance units
 * cannot be read gets NO number (the page shows a dash), never a guess.
 */
import { decodeInsuranceUnitsV20, decodeStakePoolV5, stakePoolValue, STAKE_RISK_MODE } from "./sdk";

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
export function stakePoolValueView(poolData: Uint8Array, unitsData: Uint8Array | null | undefined): StakePoolValueView | null {
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
      v = stakePoolValue(pool, { unitsStake: u.unitsStake, unitsTotal: u.unitsTotal }, u.snapInsuranceFreeAtoms);
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
