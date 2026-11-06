/**
 * Stake pool value for the /stake page and /api/stake/pools (release checklist section 5 item 4): the value includes the
 * insurance a first-loss pool has deployed into the market, not only what sits in the vault. Pure; never throws.
 *
 * Naming: only a first-loss pool (v5 risk_mode 1) is "insurance staking"; fee-only and legacy pools keep "Fee staking".
 * The math is the SDK's `stakePoolValue` (ported in lib/v22/sdk/v22-stake.ts, TODO(repin)). The EXIT (free) reading is used,
 * because this is what a leaving staker is paid: the market's live one when it decodes, else `snapInsuranceFreeAtoms`. A first-loss
 * pool whose insurance units cannot be read gets NO number (the page shows a dash), never a guess.
 */
import { decodeTerminalInsuranceCapacity } from "./records";
import { decodeInsuranceUnitsV20, decodeStakePoolV5, quoteStakeWithdrawNowV5, stakePoolValue, STAKE_RISK_MODE } from "./sdk";

/**
 * The wrapper's live exit reading for asset 0 (`ins_units_readings_view`): min(sum of the domains' withdraw capacity, insurance), from the raw market
 * account. `InsuranceUnitsV20.snapInsuranceFreeAtoms` is only refreshed when the units account is touched, so it lags in BOTH directions: stale-high
 * after an insurance loss (devnet FGSFL 2026-10-20: 60M snapshot vs 30M live), stale-low after the domains' withdraw budget grows with no
 * units touch (crank liquidation fees, maintenance fees, a trade's backing fee when a backing fee policy is set). Stake Withdraw refreshes
 * it to this reading before pricing (stake processor.rs:2802, wrapper `ins_units_snapshot`), so callers price at it. The program also
 * subtracts the hidden K/F loss reservation and caps the sum by insurance less source reservations and by the vault, which this read does
 * not, so for the same market state it is never below what the program prices at: a quote from it can only burn less than the most that
 * fits. Null when the market cannot be decoded: callers then keep the snapshot.
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
      const exit = liveFree ?? u.snapInsuranceFreeAtoms;
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
  /** Collateral atoms that can go out now; the `maxLpRaw` burn pays at most this (less by the headroom when the cap binds). */
  maxAtoms: bigint;
  /** The rest of the redeem value, returned when the deployed insurance is recovered. */
  deferredAtoms: bigint;
}

/**
 * Trim on a capped LP burn, in bps of the burn. The program prices at the free reading of the slot the tx lands in; 10 bps keeps the burn
 * within liquid through insurance growth of about 0.1% of the pool value since the read (without it, a few atoms of growth refuse 36).
 */
export const WITHDRAW_CAP_HEADROOM_BPS = 10n;

/**
 * The withdraw cap for a FIRST_LOSS pool: `min(redeemable, liquid)`. Null (no cap known, keep the balance) for fee-only / legacy pools,
 * and when the pool, the units or the vault balance cannot be read: never a guess.
 *
 * @param poolData     Raw stake pool account.
 * @param unitsData    Raw wrapper `InsuranceUnitsV20` account, or null.
 * @param vaultAtoms   SPL balance of `pool.vault`.
 * @param userLpRaw    The staker's raw LP balance.
 * @param liveFree     {@link liveFreeInsuranceAtoms} of the market; null or omitted prices at the units snapshot.
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
    // Priced at the live reading (the one Withdraw refreshes to), not min(snapshot, live): a stale-low snapshot under-values the pool, which
    // makes the capped LP burn too large and the program refuses it (36).
    const q = quoteStakeWithdrawNowV5(pool, { unitsStake: u.unitsStake, unitsTotal: u.unitsTotal }, liveFree ?? u.snapInsuranceFreeAtoms, vaultAtoms, userLpRaw);
    if (!q) return null;
    // A burn that pays 0 atoms is not a withdrawal: with nothing liquid the largest "fitting" burn can be a dust LP amount worth 0.
    // A capped burn sits on the liquid boundary to the atom, so insurance growth between this read and the tx would push it over: keep headroom.
    const maxLpRaw = q.maxCollateralNow === 0n ? 0n : q.capBinds ? q.maxLpNow - (q.maxLpNow * WITHDRAW_CAP_HEADROOM_BPS) / 10_000n : q.maxLpNow;
    return { capBinds: q.capBinds, maxLpRaw, maxAtoms: q.maxCollateralNow, deferredAtoms: q.deferred };
  } catch {
    return null;
  }
}
