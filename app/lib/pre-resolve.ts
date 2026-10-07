/**
 * Pre-resolve fee gate for the app's reclaim flow (ResolveMarket + CloseSlab).
 *
 * Fee-flow audit 2026-09-29 F4: the LP leg (tag 78 LpVaultCrankFees) and the
 * staker leg (tag 87 WithdrawInsuranceReserveToStake → stake tag 12
 * AccrueFees) are LIVE-ONLY. Once ResolveMarket runs they can never move, and
 * CloseSlab SPL-burns every unbudgeted insurance atom — exactly the sum of the
 * outstanding protocol, creator, LP and staker legs. So before ResolveMarket:
 *   1. read the four legs;
 *   2. prepend 78 (LP vault exists with shares) and 87 + stake 12 (bound
 *      insurance-mode pool with real stakers) to the SAME transaction, ahead of
 *      ResolveMarket — both clamp to the shared pool, which equals the sum of
 *      the legs, so a landed crank drains its leg;
 *   3. refuse if a Live-only leg is owed and cannot be cranked (it would be
 *      lost), or if the creator's own claimable fees (tag 90) are unclaimed.
 * Protocol fees owed are reported as a warning (the claim is the platform's).
 *
 * Builders are ported from percolator-oracle-keeper `lp-fee-cranker.ts` /
 * `stake-fee-pusher.ts` (feat/keeper-fee-loop @ b004a0c, security-reviewed;
 * account lists checked against wrapper 6377376a :17071 and stake e62aa4a
 * :2761), which use the SDK encoders + account specs.
 */
import { parseLpVaultRegistry } from "@/lib/v22/records";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import {
  ACCOUNTS_LP_VAULT_CRANK_FEES,
  ACCOUNTS_WITHDRAW_INSURANCE_RESERVE_TO_STAKE,
  buildAccountMetas,
  decodeStakePool,
  deriveLpBackingLedger,
  deriveLpVaultRegistry,
  deriveMarketVaultAccounts,
  deriveStakePool,
  encodeLpVaultCrankFees,
  encodeStakeAccrueFees,
  encodeWithdrawInsuranceReserveToStake,
  parseWrapperConfigV17,
} from "@percolatorct/sdk";
import { readCreatorFeeClaimable } from "@/lib/v17-creator-fee";
import { decodeLpVaultRegistryBound } from "@/lib/limits/decode";
import { deriveVaultLpState, withBoundVaultLpTail } from "@/lib/limits/p3-ix";
import { TAG_LP_VAULT_CRANK_FEES } from "@/lib/limits/constants";
import { computeBudgetPrefix, connectionSelfHealDeps, parseCustomInstructionError } from "@/lib/self-heal";

import { WRAPPER_ERR } from "@/lib/wrapper-errors";
/** percolator-stake `state::MINIMUM_LIQUIDITY` (dead shares), e62aa4a state.rs:25. */
export const STAKE_MINIMUM_LIQUIDITY = 1_000n;
/** Keeper K-1 gate: dead shares may take at most this share of a push. */
export const STAKE_MAX_DEAD_SHARE_BPS = 100n;
export const PRE_RESOLVE_CRANK_CU = 250_000;

export interface FeeLegs {
  protocolOwed: bigint;
  lpOwed: bigint;
  stakeOwed: bigint;
  creatorClaimable: bigint | null;
}

export function readFeeLegs(data: Uint8Array): FeeLegs {
  const cfg = parseWrapperConfigV17(data);
  let creatorClaimable: bigint | null = null;
  try {
    creatorClaimable = readCreatorFeeClaimable(data)?.atoms ?? null;
  } catch {
    creatorClaimable = null;
  }
  return {
    protocolOwed: cfg.protocolFeeAccruedAtoms - cfg.protocolFeeWithdrawnAtoms,
    lpOwed: cfg.lpFeeAccruedAtoms - cfg.lpFeeWithdrawnAtoms,
    stakeOwed: cfg.insuranceReserveAccruedAtoms - cfg.insuranceReserveWithdrawnAtoms,
    creatorClaimable,
  };
}

export interface PoolState {
  slab: PublicKey;
  poolMode: number;
  totalLpSupply: bigint;
  isInitialized: boolean;
  percolatorProgram: PublicKey;
  vault: PublicKey;
}

export type StakeLegPlan = { action: "push" } | { action: "none" } | { action: "stuck"; reason: string };
export type LpLegPlan = { action: "crank"; domain: number } | { action: "none" } | { action: "stuck"; reason: string };

/** Mirrors the keeper's decideStakeFeePush (incl. the K-1 dead-share ratio gate). */
export function decideStakeLeg(owed: bigint, market: PublicKey, wrapper: PublicKey, pool: PoolState | null): StakeLegPlan {
  if (owed <= 0n) return { action: "none" };
  if (!pool || !pool.isInitialized) return { action: "stuck", reason: "the market has no initialised stake pool" };
  if (!pool.slab.equals(market) || !pool.percolatorProgram.equals(wrapper)) {
    return { action: "stuck", reason: "the stake pool is not bound to this market" };
  }
  if (pool.poolMode !== 0) return { action: "stuck", reason: "the stake pool is not an insurance pool" };
  const real = pool.totalLpSupply > STAKE_MINIMUM_LIQUIDITY ? pool.totalLpSupply - STAKE_MINIMUM_LIQUIDITY : 0n;
  if (real === 0n) return { action: "stuck", reason: "the stake pool has no stakers" };
  if (STAKE_MINIMUM_LIQUIDITY * 10_000n > STAKE_MAX_DEAD_SHARE_BPS * pool.totalLpSupply) {
    return { action: "stuck", reason: "the stake pool has too few stakers (the push would mostly go to dead shares)" };
  }
  return { action: "push" };
}

export interface PreResolveRegistry {
  domain: number;
  sharesOutstanding: bigint;
  /** P3: a vault-owned LP is bound (registry `_reserved[0] == 1`). */
  bound?: boolean;
}

export function decideLpLeg(owed: bigint, registry: PreResolveRegistry | null): LpLegPlan {
  if (owed <= 0n) return { action: "none" };
  if (!registry) return { action: "stuck", reason: "the market has no Earn vault" };
  // P3-L1: on a BOUND vault with no real senior shares the crank credits the junior tranche, so
  // it still moves the leg; only an unbound vault with no depositors has nowhere to put it.
  if (registry.sharesOutstanding === 0n && !registry.bound) return { action: "stuck", reason: "the Earn vault has no depositors" };
  return { action: "crank", domain: registry.domain };
}

/**
 * Tag 78 before ResolveMarket. On a P3 BOUND vault the handler REQUIRES the vault-LP state at
 * [6] (fail closed), so without the tail the crank - and with it the whole reclaim tx - fails.
 * It matters more on P3: 78 is Live-only, and a bound vault's ExecuteRedemption refuses
 * VaultLpHarvestPending (84) while fees are harvestable, so fees left at resolution lock every
 * Earn senior (reproduced on P3 424fe7e4 BPF; see plan section 9).
 */
export function buildLpCrankIx(programId: PublicKey, cranker: PublicKey, market: PublicKey, domain: number, bound = false): TransactionInstruction {
  const [registry] = deriveLpVaultRegistry(programId, market);
  const [ledger] = deriveLpBackingLedger(programId, market, domain);
  const [siblingLedger] = deriveLpBackingLedger(programId, market, domain ^ 1);
  const base = buildAccountMetas(ACCOUNTS_LP_VAULT_CRANK_FEES, {
    cranker,
    market,
    registry,
    ledger,
    siblingLedger,
    systemProgram: SystemProgram.programId,
  });
  const keys = bound ? withBoundVaultLpTail(TAG_LP_VAULT_CRANK_FEES, base, deriveVaultLpState(programId, market)) : base;
  return new TransactionInstruction({ programId, keys, data: Buffer.from(encodeLpVaultCrankFees({ domain })) });
}

export function buildStakePushIxs(p: {
  programId: PublicKey;
  stakeProgramId: PublicKey;
  cranker: PublicKey;
  market: PublicKey;
  collateralMint: PublicKey;
  pool: PublicKey;
  poolVault: PublicKey;
}): TransactionInstruction[] {
  const v = deriveMarketVaultAccounts(p.programId, p.market, p.collateralMint);
  return [
    new TransactionInstruction({
      programId: p.programId,
      keys: buildAccountMetas(ACCOUNTS_WITHDRAW_INSURANCE_RESERVE_TO_STAKE, {
        cranker: p.cranker,
        market: p.market,
        stakePool: p.pool,
        stakeVault: p.poolVault,
        vaultToken: v.vaultToken,
        vaultAuthority: v.vaultAuthority,
        tokenProgram: v.tokenProgram,
      }),
      data: Buffer.from(encodeWithdrawInsuranceReserveToStake()),
    }),
    new TransactionInstruction({
      programId: p.stakeProgramId,
      keys: [
        { pubkey: p.cranker, isSigner: true, isWritable: false },
        { pubkey: p.pool, isSigner: false, isWritable: true },
        { pubkey: p.poolVault, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: p.market, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(encodeStakeAccrueFees()),
    }),
  ];
}

export interface PreResolvePlan {
  legs: FeeLegs;
  /** Instructions to put BEFORE ResolveMarket in the same transaction. */
  cranks: TransactionInstruction[];
  /** Non-empty → do not resolve (the user-facing reasons). */
  blockers: string[];
  warnings: string[];
  extraComputeUnits: number;
}

function atoms(a: bigint): string {
  return `${(Number(a) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")} (collateral units)`;
}

/** Pure planning over already-read state (unit-tested). */
export function planPreResolve(p: {
  programId: PublicKey;
  stakeProgramId: PublicKey;
  cranker: PublicKey;
  market: PublicKey;
  marketData: Uint8Array;
  registry: PreResolveRegistry | null;
  pool: PoolState | null;
  poolAddress: PublicKey;
}): PreResolvePlan {
  const legs = readFeeLegs(p.marketData);
  const collateralMint = parseWrapperConfigV17(p.marketData).collateralMint;
  const cranks: TransactionInstruction[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];
  const lp = decideLpLeg(legs.lpOwed, p.registry);
  if (lp.action === "crank") cranks.push(buildLpCrankIx(p.programId, p.cranker, p.market, lp.domain, p.registry?.bound === true));
  if (lp.action === "stuck") blockers.push(`${atoms(legs.lpOwed)} of LP fees can only be paid out while the market is live, and ${lp.reason}. Resolving now would burn them.`);
  const st = decideStakeLeg(legs.stakeOwed, p.market, p.programId, p.pool);
  if (st.action === "push" && p.pool) {
    cranks.push(
      ...buildStakePushIxs({
        programId: p.programId,
        stakeProgramId: p.stakeProgramId,
        cranker: p.cranker,
        market: p.market,
        collateralMint,
        pool: p.poolAddress,
        poolVault: p.pool.vault,
      }),
    );
  }
  if (st.action === "stuck") blockers.push(`${atoms(legs.stakeOwed)} of staker fees can only be paid out while the market is live, and ${st.reason}. Resolving now would burn them.`);
  if (legs.creatorClaimable !== null && legs.creatorClaimable > 0n) {
    blockers.push(`You have ${atoms(legs.creatorClaimable)} of creator fees to claim. Claim them first (My Markets → Claim); closing the market burns them.`);
  }
  if (legs.creatorClaimable === null) warnings.push("Creator fees could not be read; check My Markets before closing.");
  if (legs.protocolOwed > 0n) warnings.push(`${atoms(legs.protocolOwed)} of protocol fees are unclaimed and will be burned at close.`);
  return { legs, cranks, blockers, warnings, extraComputeUnits: cranks.length > 0 ? PRE_RESOLVE_CRANK_CU : 0 };
}

/** Read registry + pool, then plan. Registry/pool read failures count as "absent". */
export async function readAndPlanPreResolve(
  connection: Connection,
  p: { programId: PublicKey; stakeProgramId: PublicKey; cranker: PublicKey; market: PublicKey; marketData: Uint8Array },
): Promise<PreResolvePlan> {
  const [registryPk] = deriveLpVaultRegistry(p.programId, p.market);
  const [poolPk] = deriveStakePool(p.market, p.stakeProgramId);
  const [ri, pi] = await connection.getMultipleAccountsInfo([registryPk, poolPk], "confirmed");
  let registry: PreResolveRegistry | null = null;
  if (ri && ri.owner.equals(p.programId)) {
    try {
      const raw = new Uint8Array(ri.data);
      const r = parseLpVaultRegistry(raw);
      registry = { domain: Number(r.domain), sharesOutstanding: r.totalLpSharesOutstanding, bound: decodeLpVaultRegistryBound(raw) === true };
    } catch {
      registry = null;
    }
  }
  let pool: PoolState | null = null;
  if (pi && pi.owner.equals(p.stakeProgramId)) {
    try {
      const d = decodeStakePool(new Uint8Array(pi.data));
      pool = {
        slab: d.slab,
        poolMode: d.poolMode,
        totalLpSupply: d.totalLpSupply,
        isInitialized: d.isInitialized,
        percolatorProgram: d.percolatorProgram,
        vault: d.vault,
      };
    } catch {
      pool = null;
    }
  }
  const plan = planPreResolve({ ...p, registry, pool, poolAddress: poolPk });
  if (plan.cranks.length === 0) return plan;
  // Simulate the planned cranks alone (sigVerify=false). A crank the program
  // refuses (e.g. Custom(56): the market's insurance authority was never bound
  // to its stake pool — fee-flow audit F2a) would revert the whole reclaim tx;
  // report it as a blocker instead. Nothing is signed here.
  try {
    const sim = await connectionSelfHealDeps(connection, p.market, p.cranker).simulate([
      ...computeBudgetPrefix(PRE_RESOLVE_CRANK_CU),
      ...plan.cranks,
    ]);
    const ie = parseCustomInstructionError(sim.err);
    if (sim.err) {
      const code = ie?.code;
      const why =
        code === WRAPPER_ERR.StakePoolAuthorityMismatch || code === WRAPPER_ERR.StakePoolNotBound
          ? "the market's insurance is not bound to its stake pool (an operator must run stake Bind first)"
          : `the fee crank was refused (${code !== undefined ? `Custom(${code})` : JSON.stringify(sim.err)})`;
      return { ...plan, cranks: [], blockers: [...plan.blockers, `Outstanding fees can't be paid out before resolving: ${why}. Resolving now would burn them.`] };
    }
  } catch {
    // Simulation RPC failed: keep the plan; the reclaim tx's own preflight still guards the send.
  }
  return plan;
}
