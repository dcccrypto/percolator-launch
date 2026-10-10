/*
 * LOCAL ADAPTER PORT, not original code: verbatim from percolator-sdk feat/v22-sdk @ ecb6215 (draft dcccrypto/percolator-sdk#406, sdk 9.0.0-candidate),
 * src/abi/v22-stake.ts. Only the imports are retargeted (the installed @percolatorct/sdk 8.0.0 root, the v2.1 txv1 port, and the sibling v22 ports).
 * Delete when @percolatorct/sdk >= 9.0.0 ships and point ./index.ts at the package. Do not edit here; fix upstream in percolator-sdk.
 */
/**
 * percolator-stake v5 (Phase 4 item 6, first-loss insurance staking): wire, accounts, the
 * `StakePool` v5 decoder and the error table for codes 33 to 45.
 *
 * Source: percolator-stake `release/v22-stake` `49e27e7` (PR #304 `feat/v22-stake-v5` head `480fe29`
 * plus the layout PR #306): `src/instruction.rs` (`unpack` at 764..850, docs at 93..172 and 722..759 of that head),
 * `src/state.rs` (`StakePool`, offsets pinned by const asserts at 246..293), `src/error.rs` (33..45 at 113..149).
 * DRAFT, not deployed; stake v5 and wrapper v2.2 deploy TOGETHER (the stake fails closed on any
 * `InsuranceUnitsV20` kind / version / size / owner mismatch).
 *
 * The v1 / v2.1 stake surface (`STAKE_IX`, `STAKE_ERRORS`, `decodeStakePool` for pool versions 1..4)
 * is untouched; this module is additive. `decodeStakePool` refuses a v5 pool with a version error,
 * which is the correct fail-closed behaviour: use {@link decodeStakePoolV5}.
 *
 * @module v22-stake
 */
import { PublicKey, SYSVAR_CLOCK_PUBKEY, SystemProgram } from "@solana/web3.js";
import type { AccountMeta } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { concatBytes, encU16, encU64, encU8 } from "@percolatorct/sdk";
import type { ErrorInfo } from "@percolatorct/sdk";

// ============================================================================
// Constants
// ============================================================================

/** New stake tags (the stake program's own namespace, NOT the wrapper's). */
export const STAKE_IX_V5 = Object.freeze({
  SyncInsuranceDeployment: 31,
  ProposeDeployTarget: 32,
  CommitDeployTarget: 33,
} as const);

/** `StakePool` v5: 480 bytes, version byte (`_reserved[8]` at 328) = 5. */
export const STAKE_POOL_SIZE_V5 = 480;
export const STAKE_POOL_VERSION_V5 = 5;
/** Risk modes (`RISK_MODE_*`). */
export const STAKE_RISK_MODE = Object.freeze({ Legacy: 0, FirstLoss: 1, FeeOnly: 2 } as const);
/** `CONSENT_VERSION_FIRST_LOSS` (round 2: 1 -> 2). A deposit must carry the pool's `consent_version`. */
export const CONSENT_VERSION_FIRST_LOSS_V5 = 2;
/** Deployment bounds (`state.rs` 333..343). */
export const DEPLOY_TARGET_MAX_BPS_V5 = 8_000;
export const DEPLOY_TARGET_DEFAULT_BPS_V5 = 5_000;
export const LIQUID_BUFFER_DEFAULT_BPS_V5 = 3_000;
export const HYSTERESIS_DEFAULT_BPS_V5 = 500;
export const HYSTERESIS_MAX_BPS_V5 = 2_000;
export const SYNC_COOLDOWN_DEFAULT_SLOTS_V5 = 150n;
/** The commit timelock is `max(pool.cooldown_slots, 216_000)` (S-6 / round 2). */
export const DEPLOY_TARGET_TIMELOCK_MIN_SLOTS_V5 = 216_000n;

/** `StakePool` v5 field offsets (rustc `offset_of!`; the v1..v4 prefix is unchanged). */
export const STAKE_POOL_FIELD_OFF_V5 = Object.freeze({
  isInitialized: 0, slab: 8, vault: 136, percolatorProgram: 224, poolMode: 280, reserved: 320, version: 328,
  riskMode: 408, consentVersion: 409, deployTargetBps: 410, liquidBufferBps: 412, hysteresisBps: 414,
  lastSyncSlot: 416, pendingTargetBps: 424, pendingTargetSlot: 432, syncCooldownSlots: 440,
  creatorForwardedAtoms: 448, v5Reserved: 456,
} as const);

function intIn(name: string, v: number, min: number, max: number): void {
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${name} must be an integer in ${min}..=${max}, got ${v}`);
}

// ============================================================================
// Encoders
// ============================================================================

/** Deployment parameters a FIRST_LOSS staker signs over (S-5: bound into the deposit consent). */
export interface StakeDeployParamsV5 {
  /** Target share of the pool deployed into insurance, bps, `<= 8_000`. */
  targetBps: number;
  /** Share kept liquid by a sync top-up, bps. */
  bufferBps: number;
  /** No sync while the deployed share is within this many bps of the target, `<= 2_000`. */
  hysteresisBps: number;
}

function assertDeployParams(p: StakeDeployParamsV5): void {
  intIn("targetBps", p.targetBps, 0, DEPLOY_TARGET_MAX_BPS_V5);
  intIn("bufferBps", p.bufferBps, 0, 10_000);
  intIn("hysteresisBps", p.hysteresisBps, 0, HYSTERESIS_MAX_BPS_V5);
}

/**
 * InitPool v5 (stake tag 0, 23-byte payload): `[0][cooldown u64][cap u64][risk_mode u8][target u16][buffer u16][hyst u16]`.
 * `risk_mode` 1 FIRST_LOSS (target `<= 8_000`), 2 FEE_ONLY (target 0). The 16-byte legacy InitPool creates a
 * FIRST_LOSS pool with the defaults 50% / 30% / 5%. Mirrors `instruction.rs:769..791`.
 *
 * @param cooldownSlots  Withdrawal cooldown.
 * @param depositCap     Deposit cap (0 = uncapped).
 * @param riskMode       1 or 2.
 * @param p              Deployment parameters (target must be 0 for FEE_ONLY).
 * @returns 24 bytes (tag + 23).
 * @example
 * ```ts
 * encodeStakeInitPoolV5(216_000n, 0n, STAKE_RISK_MODE.FirstLoss, { targetBps: 5000, bufferBps: 3000, hysteresisBps: 500 });
 * ```
 */
export function encodeStakeInitPoolV5(cooldownSlots: bigint, depositCap: bigint, riskMode: 1 | 2, p: StakeDeployParamsV5): Uint8Array {
  assertDeployParams(p);
  if (riskMode === STAKE_RISK_MODE.FeeOnly && p.targetBps !== 0) throw new Error("a FEE_ONLY pool deploys nothing: targetBps must be 0");
  return concatBytes(encU8(0), encU64(cooldownSlots), encU64(depositCap), encU8(riskMode), encU16(p.targetBps), encU16(p.bufferBps), encU16(p.hysteresisBps));
}

/**
 * Deposit with first-loss consent (stake tag 1, 15-byte payload):
 * `[1][amount u64][accept_first_loss_version u8][target u16][buffer u16][hyst u16]`. A FIRST_LOSS pool
 * REQUIRES this form with the version equal to `pool.consent_version` AND the deployment parameters the
 * staker accepts equal to the pool's (`target` = the larger of the committed and a pending target), else
 * `ConsentRequired` (33). The 9-byte form is refused on such a pool. Mirrors `instruction.rs:807..827`.
 *
 * @param amount   Collateral atoms.
 * @param p        The pool's current deployment parameters (read them from {@link decodeStakePoolV5}).
 * @param version  Consent version (default {@link CONSENT_VERSION_FIRST_LOSS_V5}).
 * @returns 16 bytes.
 * @example
 * ```ts
 * encodeStakeDepositWithConsentV5(1_000_000n, { targetBps: 5000, bufferBps: 3000, hysteresisBps: 500 });
 * ```
 */
export function encodeStakeDepositWithConsentV5(amount: bigint, p: StakeDeployParamsV5, version: number = CONSENT_VERSION_FIRST_LOSS_V5): Uint8Array {
  assertDeployParams(p);
  intIn("version", version, 1, 255);
  return concatBytes(encU8(1), encU64(amount), encU8(version), encU16(p.targetBps), encU16(p.bufferBps), encU16(p.hysteresisBps));
}

/**
 * The deployment parameters a deposit must sign over for `pool`: `target` is the LARGER of the committed
 * target and a pending one (S-5), so a staker cannot be surprised by a raise that commits after their deposit.
 *
 * @param pool  Decoded pool.
 * @returns The parameters to pass to {@link encodeStakeDepositWithConsentV5}.
 * @example
 * ```ts
 * const p = consentParamsForPoolV5(decodeStakePoolV5(info.data));
 * ```
 */
export function consentParamsForPoolV5(pool: StakePoolV5Fields): StakeDeployParamsV5 {
  const pending = pool.pendingTargetSlot !== 0n ? Number(pool.pendingTargetBps) : 0;
  return { targetBps: Math.max(pool.deployTargetBps, pending), bufferBps: pool.liquidBufferBps, hysteresisBps: pool.hysteresisBps };
}

/**
 * SyncInsuranceDeployment (stake tag 31): `[31]`. Permissionless, rate limited.
 *
 * @returns 1 byte.
 * @example
 * ```ts
 * encodeStakeSyncInsuranceDeploymentV5(); // [31]
 * ```
 */
export function encodeStakeSyncInsuranceDeploymentV5(): Uint8Array {
  return encU8(STAKE_IX_V5.SyncInsuranceDeployment);
}

/**
 * ProposeDeployTarget (stake tag 32): `[32][target_bps u16]`. The admin may only LOWER the target; raising needs
 * the stake program's upgrade authority. Takes effect via CommitDeployTarget after the cooldown.
 *
 * @param targetBps  Proposed target, `<= 8_000`.
 * @returns 3 bytes.
 * @example
 * ```ts
 * encodeStakeProposeDeployTargetV5(4000);
 * ```
 */
export function encodeStakeProposeDeployTargetV5(targetBps: number): Uint8Array {
  intIn("targetBps", targetBps, 0, DEPLOY_TARGET_MAX_BPS_V5);
  return concatBytes(encU8(STAKE_IX_V5.ProposeDeployTarget), encU16(targetBps));
}

/**
 * CommitDeployTarget (stake tag 33): `[33]`. Permissionless once `pending_target_slot + max(cooldown, 216_000)` has passed.
 *
 * @returns 1 byte.
 * @example
 * ```ts
 * encodeStakeCommitDeployTargetV5(); // [33]
 * ```
 */
export function encodeStakeCommitDeployTargetV5(): Uint8Array {
  return encU8(STAKE_IX_V5.CommitDeployTarget);
}

// ============================================================================
// Account lists (stake program)
// ============================================================================

/** Named account of a stake v5 instruction. */
export interface StakeAccountSpecV5 {
  name: string;
  signer: boolean;
  writable: boolean;
}

/**
 * Stake Deposit v5, FIRST_LOSS (14): `instruction.rs:106..135`. Mode-0 / legacy pools use `[0..11]` only (the
 * market at `[11]` is read-only there); a FIRST_LOSS pool needs `[11]` writable plus `[12]` units and `[13]` the wrapper.
 */
export const ACCOUNTS_STAKE_DEPOSIT_V5: readonly StakeAccountSpecV5[] = [
  { name: "user", signer: true, writable: false },
  { name: "pool", signer: false, writable: true },
  { name: "userCollateral", signer: false, writable: true },
  { name: "vault", signer: false, writable: true },
  { name: "lpMint", signer: false, writable: true },
  { name: "userLp", signer: false, writable: true },
  { name: "vaultAuthority", signer: false, writable: false },
  { name: "deposit", signer: false, writable: true },
  { name: "tokenProgram", signer: false, writable: false },
  { name: "clock", signer: false, writable: false },
  { name: "systemProgram", signer: false, writable: false },
  { name: "market", signer: false, writable: true },
  { name: "insuranceUnits", signer: false, writable: true },
  { name: "wrapperProgram", signer: false, writable: false },
] as const;

/** Stake Withdraw v5, FIRST_LOSS (14): `instruction.rs:150..172`. `[10]` market is REQUIRED and writable on first-loss pools. */
export const ACCOUNTS_STAKE_WITHDRAW_V5: readonly StakeAccountSpecV5[] = [
  { name: "user", signer: true, writable: false },
  { name: "pool", signer: false, writable: true },
  { name: "userLp", signer: false, writable: true },
  { name: "lpMint", signer: false, writable: true },
  { name: "vault", signer: false, writable: true },
  { name: "userCollateral", signer: false, writable: true },
  { name: "vaultAuthority", signer: false, writable: false },
  { name: "deposit", signer: false, writable: true },
  { name: "tokenProgram", signer: false, writable: false },
  { name: "clock", signer: false, writable: false },
  { name: "market", signer: false, writable: true },
  { name: "insuranceUnits", signer: false, writable: true },
  { name: "wrapperProgram", signer: false, writable: false },
  { name: "systemProgram", signer: false, writable: false },
] as const;

/** SyncInsuranceDeployment (11): `instruction.rs:722..739`. */
export const ACCOUNTS_STAKE_SYNC_V5: readonly StakeAccountSpecV5[] = [
  { name: "caller", signer: true, writable: true },
  { name: "pool", signer: false, writable: true },
  { name: "vault", signer: false, writable: true },
  { name: "vaultAuthority", signer: false, writable: false },
  { name: "market", signer: false, writable: true },
  { name: "wrapperVault", signer: false, writable: true },
  { name: "wrapperVaultAuthority", signer: false, writable: false },
  { name: "insuranceUnits", signer: false, writable: true },
  { name: "tokenProgram", signer: false, writable: false },
  { name: "wrapperProgram", signer: false, writable: false },
  { name: "systemProgram", signer: false, writable: false },
] as const;

/** ProposeDeployTarget (2 + optional program data to RAISE): `instruction.rs:741..751`. */
export const ACCOUNTS_STAKE_PROPOSE_DEPLOY_TARGET_V5: readonly StakeAccountSpecV5[] = [
  { name: "authority", signer: true, writable: false },
  { name: "pool", signer: false, writable: true },
] as const;

/** CommitDeployTarget (3): `instruction.rs:752..759`. */
export const ACCOUNTS_STAKE_COMMIT_DEPLOY_TARGET_V5: readonly StakeAccountSpecV5[] = [
  { name: "anyone", signer: true, writable: false },
  { name: "pool", signer: false, writable: true },
  { name: "clock", signer: false, writable: false },
] as const;

/**
 * Resolve named keys to metas for any spec list.
 *
 * @param spec  Spec list.
 * @param keys  Keys by name (`systemProgram`, `tokenProgram` and `clock` default to the well-known ids).
 * @returns Metas in spec order.
 * @throws If a name is missing.
 * @example
 * ```ts
 * const metas = stakeMetasV5(ACCOUNTS_STAKE_COMMIT_DEPLOY_TARGET_V5, { anyone, pool });
 * ```
 */
export function stakeMetasV5(spec: readonly StakeAccountSpecV5[], keys: Record<string, PublicKey>): AccountMeta[] {
  const defaults: Record<string, PublicKey> = { systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_ID, clock: SYSVAR_CLOCK_PUBKEY };
  return spec.map((s) => {
    const k = keys[s.name] ?? defaults[s.name];
    if (!k) throw new Error(`stakeMetasV5: missing key for account "${s.name}"`);
    return { pubkey: k, isSigner: s.signer, isWritable: s.writable };
  });
}

// ============================================================================
// StakePool v5 decoder
// ============================================================================

/** The v5 fields of a pool (the v1..v4 fields come from `decodeStakePool`). */
export interface StakePoolV5Fields {
  /** 0 legacy, 1 FIRST_LOSS, 2 FEE_ONLY. */
  riskMode: number;
  consentVersion: number;
  deployTargetBps: number;
  liquidBufferBps: number;
  hysteresisBps: number;
  lastSyncSlot: bigint;
  pendingTargetBps: bigint;
  /** 0 = no pending proposal. */
  pendingTargetSlot: bigint;
  syncCooldownSlots: bigint;
  creatorForwardedAtoms: bigint;
  /** `_v5_reserved[0]`: the pending target was proposed by the protocol authority (S-6). */
  pendingTargetByProtocol: boolean;
}

/** Decoded v5 pool: the v5 fields plus the identity fields every consumer needs. */
export interface StakePoolV5 extends StakePoolV5Fields {
  slab: PublicKey;
  admin: PublicKey;
  collateralMint: PublicKey;
  lpMint: PublicKey;
  vault: PublicKey;
  percolatorProgram: PublicKey;
  totalDeposited: bigint;
  totalLpSupply: bigint;
  cooldownSlots: bigint;
  depositCap: bigint;
  totalFlushed: bigint;
  totalReturned: bigint;
  totalWithdrawn: bigint;
  poolMode: number;
}

const STAKE_POOL_DISCRIMINATOR_V5 = Uint8Array.from([0x53, 0x50, 0x4f, 0x4f, 0x4c, 0x5f, 0x56, 0x31]); // "SPOOL_V1"

/**
 * Decode a `StakePool` v5 account. Checks the length (`>= 480`), the discriminator and the version byte (`== 5`)
 * before reading anything, and the same risk-mode bounds the program enforces.
 *
 * @param data  Raw pool account bytes.
 * @returns The pool.
 * @throws On a short buffer, a wrong discriminator, a version other than 5, or an out-of-range risk mode / bps.
 * @example
 * ```ts
 * const pool = decodeStakePoolV5(info.data);
 * const consent = consentParamsForPoolV5(pool);
 * ```
 */
export function decodeStakePoolV5(data: Uint8Array): StakePoolV5 {
  const F = STAKE_POOL_FIELD_OFF_V5;
  if (data.length < STAKE_POOL_SIZE_V5) throw new Error(`decodeStakePoolV5: data too short (${data.length} < ${STAKE_POOL_SIZE_V5})`);
  for (let i = 0; i < 8; i++) {
    if (data[F.reserved + i] !== STAKE_POOL_DISCRIMINATOR_V5[i]) throw new Error("decodeStakePoolV5: bad StakePool discriminator");
  }
  const version = data[F.version];
  if (version !== STAKE_POOL_VERSION_V5) throw new Error(`decodeStakePoolV5: unsupported pool version ${version} !== ${STAKE_POOL_VERSION_V5}`);
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u64 = (o: number) => v.getBigUint64(o, true);
  const pk = (o: number) => new PublicKey(data.subarray(o, o + 32));
  const riskMode = data[F.riskMode];
  const deployTargetBps = v.getUint16(F.deployTargetBps, true);
  const hysteresisBps = v.getUint16(F.hysteresisBps, true);
  if (riskMode > 2 || deployTargetBps > DEPLOY_TARGET_MAX_BPS_V5 || hysteresisBps > HYSTERESIS_MAX_BPS_V5) {
    throw new Error("decodeStakePoolV5: risk settings outside the program's bounds");
  }
  return {
    slab: pk(F.slab),
    admin: pk(40),
    collateralMint: pk(72),
    lpMint: pk(104),
    vault: pk(F.vault),
    percolatorProgram: pk(F.percolatorProgram),
    totalDeposited: u64(168),
    totalLpSupply: u64(176),
    cooldownSlots: u64(184),
    depositCap: u64(192),
    totalFlushed: u64(200),
    totalReturned: u64(208),
    totalWithdrawn: u64(216),
    poolMode: data[F.poolMode],
    riskMode,
    consentVersion: data[F.consentVersion],
    deployTargetBps,
    liquidBufferBps: v.getUint16(F.liquidBufferBps, true),
    hysteresisBps,
    lastSyncSlot: u64(F.lastSyncSlot),
    pendingTargetBps: u64(F.pendingTargetBps),
    pendingTargetSlot: u64(F.pendingTargetSlot),
    syncCooldownSlots: u64(F.syncCooldownSlots),
    creatorForwardedAtoms: u64(F.creatorForwardedAtoms),
    pendingTargetByProtocol: data[F.v5Reserved] === 1,
  };
}

/**
 * Slot at which a pending deploy target can be committed: `pending_target_slot + max(cooldown, 216_000)`.
 *
 * @param pool  Decoded pool.
 * @returns The slot, or `null` when nothing is pending.
 * @example
 * ```ts
 * const at = commitSlotForPendingTargetV5(pool);
 * ```
 */
export function commitSlotForPendingTargetV5(pool: Pick<StakePoolV5, "pendingTargetSlot" | "cooldownSlots">): bigint | null {
  if (pool.pendingTargetSlot === 0n) return null;
  const t = pool.cooldownSlots > DEPLOY_TARGET_TIMELOCK_MIN_SLOTS_V5 ? pool.cooldownSlots : DEPLOY_TARGET_TIMELOCK_MIN_SLOTS_V5;
  return pool.pendingTargetSlot + t;
}

// ============================================================================
// Errors 33..45, plus 28 (stable names from percolator-stake src/error.rs, one calm line each)
// ============================================================================

/**
 * StakeError codes 33 to 45 (v5), with the stable Rust variant name and a calm one-line user message.
 * Codes 0 to 32 are the v2.1 table (`STAKE_ERRORS`); {@link decodeStakeErrorV5} covers all of them. Note
 * `STAKE_ERRORS[32]` still says "VERSION 18": on a v2.2 stake it pins VERSION 19 (see the PR notes).
 */
export const STAKE_ERRORS_V5: Readonly<Record<number, ErrorInfo>> = Object.freeze({
  // Not a v5 code: the stake-side refusal the v2.2 deposit UI can reach. A first deposit of 1,000 atoms or less into an EMPTY
  // pool / senior / junior sub-pool cannot lock its dead-share floor (percolator-stake R-1, aebbff6). Nothing is locked.
  28: { name: "DepositBelowMinimumLiquidity", hint: "First deposit into this pool must be more than 1,000 units." },
  33: { name: "ConsentRequired", hint: "Please review and accept the current risk text, then try again." },
  34: { name: "DeprecatedV5", hint: "This action was removed in stake v5; deployment now happens through the automatic sync." },
  35: { name: "InsuranceUnitsInvalid", hint: "The market's insurance record is not available right now; try again in a moment." },
  36: { name: "LiquidityBufferExhausted", hint: "This withdrawal is larger than the liquid part of the pool; the rest returns after the next sync." },
  37: { name: "SyncCooldownActive", hint: "The pool was synced a moment ago; try again shortly." },
  38: { name: "InvalidDeployConfig", hint: "These deployment settings are not allowed for this pool." },
  39: { name: "NotProtocolAuthority", hint: "Raising the deployment target needs the protocol authority." },
  40: { name: "NoPendingDeployTarget", hint: "There is no pending target to apply yet, or its waiting period has not ended." },
  41: { name: "NotSupportedOnFirstLoss", hint: "This feature is not available on a first-loss pool." },
  42: { name: "AssetAdminNotBurned", hint: "The market admin must be burned before this pool can deploy into insurance." },
  43: { name: "NothingToSync", hint: "Nothing to sync: the pool is already close to its target." },
  44: { name: "InsuranceReadingsDiverged", hint: "The market's insurance is lent out right now; deposits and syncs wait until it is repaid." },
  45: { name: "InsuranceUnitsMismatch", hint: "The market's insurance record did not update as expected; nothing was changed." },
}) as Readonly<Record<number, ErrorInfo>>;

/**
 * Decode a stake error code (0..45) for a v5 program. Codes 33..45 come from {@link STAKE_ERRORS_V5}; the
 * rest are looked up by the caller in `STAKE_ERRORS` (returned as `undefined` here).
 *
 * @param code  Custom program error code.
 * @returns Name and message, or `undefined` for a code this table does not own.
 * @example
 * ```ts
 * decodeStakeErrorV5(33)?.name; // "ConsentRequired"
 * ```
 */
export function decodeStakeErrorV5(code: number): ErrorInfo | undefined {
  return STAKE_ERRORS_V5[code];
}
