/**
 * @module stake
 * Percolator Insurance LP Staking program — instruction encoders, PDA derivation, and account specs.
 *
 * Program: percolator-stake (dcccrypto/percolator-stake)
 * Deployed devnet: 4mJ8Cas... (TODO: confirm full address from devops)
 */

import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

// ═══════════════════════════════════════════════════════════════
// Program ID
// ═══════════════════════════════════════════════════════════════

/** Percolator Stake program ID (devnet). Update for mainnet. */
export const STAKE_PROGRAM_ID = new PublicKey(
  '4mJ8CasWfJCGEjGNaJThNfFfUWJTfZLBwz6qmUGqxVMc'
);

// ═══════════════════════════════════════════════════════════════
// Instruction Tags (match src/instruction.rs)
// ═══════════════════════════════════════════════════════════════

export const STAKE_IX = {
  InitPool: 0,
  Deposit: 1,
  Withdraw: 2,
  FlushToInsurance: 3,
  UpdateConfig: 4,
  TransferAdmin: 5,
  AdminSetOracleAuthority: 6,
  AdminSetRiskThreshold: 7,
  AdminSetMaintenanceFee: 8,
  AdminResolveMarket: 9,
  AdminWithdrawInsurance: 10,
  AdminSetInsurancePolicy: 11,
} as const;

// ═══════════════════════════════════════════════════════════════
// PDA Derivation
// ═══════════════════════════════════════════════════════════════

/** Derive the stake pool PDA for a given slab (market). */
export function deriveStakePool(slab: PublicKey, programId = STAKE_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('stake_pool'), slab.toBuffer()],
    programId,
  );
}

/** Derive the vault authority PDA (signs CPI, owns LP mint + vault). */
export function deriveStakeVaultAuth(pool: PublicKey, programId = STAKE_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vault_auth'), pool.toBuffer()],
    programId,
  );
}

/** Derive the per-user deposit PDA (tracks cooldown, deposit time). */
export function deriveDepositPda(pool: PublicKey, user: PublicKey, programId = STAKE_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('deposit'), pool.toBuffer(), user.toBuffer()],
    programId,
  );
}

// ═══════════════════════════════════════════════════════════════
// Instruction Encoders
// ═══════════════════════════════════════════════════════════════

function u64Le(v: bigint | number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(v));
  return buf;
}

function u128Le(v: bigint | number): Buffer {
  const buf = Buffer.alloc(16);
  const big = BigInt(v);
  buf.writeBigUInt64LE(big & 0xFFFFFFFFFFFFFFFFn, 0);
  buf.writeBigUInt64LE(big >> 64n, 8);
  return buf;
}

function u16Le(v: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(v);
  return buf;
}

/** Tag 0: InitPool — create stake pool for a slab. */
export function encodeStakeInitPool(cooldownSlots: bigint | number, depositCap: bigint | number): Buffer {
  return Buffer.concat([
    Buffer.from([STAKE_IX.InitPool]),
    u64Le(cooldownSlots),
    u64Le(depositCap),
  ]);
}

/** Tag 1: Deposit — deposit collateral, receive LP tokens. */
export function encodeStakeDeposit(amount: bigint | number): Buffer {
  return Buffer.concat([Buffer.from([STAKE_IX.Deposit]), u64Le(amount)]);
}

/** Tag 2: Withdraw — burn LP tokens, receive collateral (subject to cooldown). */
export function encodeStakeWithdraw(lpAmount: bigint | number): Buffer {
  return Buffer.concat([Buffer.from([STAKE_IX.Withdraw]), u64Le(lpAmount)]);
}

/** Tag 3: FlushToInsurance — move collateral from stake vault to wrapper insurance. */
export function encodeStakeFlushToInsurance(amount: bigint | number): Buffer {
  return Buffer.concat([Buffer.from([STAKE_IX.FlushToInsurance]), u64Le(amount)]);
}

/** Tag 4: UpdateConfig — update cooldown and/or deposit cap. */
export function encodeStakeUpdateConfig(
  newCooldownSlots?: bigint | number,
  newDepositCap?: bigint | number,
): Buffer {
  return Buffer.concat([
    Buffer.from([STAKE_IX.UpdateConfig]),
    Buffer.from([newCooldownSlots != null ? 1 : 0]),
    u64Le(newCooldownSlots ?? 0n),
    Buffer.from([newDepositCap != null ? 1 : 0]),
    u64Le(newDepositCap ?? 0n),
  ]);
}

/** Tag 5: TransferAdmin — transfer wrapper admin to pool PDA. */
export function encodeStakeTransferAdmin(): Buffer {
  return Buffer.from([STAKE_IX.TransferAdmin]);
}

/** Tag 6: AdminSetOracleAuthority — forward to wrapper via CPI. */
export function encodeStakeAdminSetOracleAuthority(newAuthority: PublicKey): Buffer {
  return Buffer.concat([
    Buffer.from([STAKE_IX.AdminSetOracleAuthority]),
    newAuthority.toBuffer(),
  ]);
}

/** Tag 7: AdminSetRiskThreshold — forward to wrapper via CPI. */
export function encodeStakeAdminSetRiskThreshold(newThreshold: bigint | number): Buffer {
  return Buffer.concat([
    Buffer.from([STAKE_IX.AdminSetRiskThreshold]),
    u128Le(newThreshold),
  ]);
}

/** Tag 8: AdminSetMaintenanceFee — forward to wrapper via CPI. */
export function encodeStakeAdminSetMaintenanceFee(newFee: bigint | number): Buffer {
  return Buffer.concat([
    Buffer.from([STAKE_IX.AdminSetMaintenanceFee]),
    u128Le(newFee),
  ]);
}

/** Tag 9: AdminResolveMarket — forward to wrapper via CPI. */
export function encodeStakeAdminResolveMarket(): Buffer {
  return Buffer.from([STAKE_IX.AdminResolveMarket]);
}

/** Tag 10: AdminWithdrawInsurance — withdraw insurance after market resolution. */
export function encodeStakeAdminWithdrawInsurance(amount: bigint | number): Buffer {
  return Buffer.concat([
    Buffer.from([STAKE_IX.AdminWithdrawInsurance]),
    u64Le(amount),
  ]);
}

/** Tag 11: AdminSetInsurancePolicy — set withdrawal policy on wrapper. */
export function encodeStakeAdminSetInsurancePolicy(
  authority: PublicKey,
  minWithdrawBase: bigint | number,
  maxWithdrawBps: number,
  cooldownSlots: bigint | number,
): Buffer {
  return Buffer.concat([
    Buffer.from([STAKE_IX.AdminSetInsurancePolicy]),
    authority.toBuffer(),
    u64Le(minWithdrawBase),
    u16Le(maxWithdrawBps),
    u64Le(cooldownSlots),
  ]);
}

// ═══════════════════════════════════════════════════════════════
// Account Specs (for building TransactionInstructions)
// ═══════════════════════════════════════════════════════════════

export interface StakeAccounts {
  /** InitPool accounts */
  initPool: {
    admin: PublicKey;
    slab: PublicKey;
    pool: PublicKey;
    lpMint: PublicKey;
    vault: PublicKey;
    vaultAuth: PublicKey;
    collateralMint: PublicKey;
    percolatorProgram: PublicKey;
  };
  /** Deposit accounts */
  deposit: {
    user: PublicKey;
    pool: PublicKey;
    userCollateralAta: PublicKey;
    vault: PublicKey;
    lpMint: PublicKey;
    userLpAta: PublicKey;
    vaultAuth: PublicKey;
    depositPda: PublicKey;
  };
  /** Withdraw accounts */
  withdraw: {
    user: PublicKey;
    pool: PublicKey;
    userLpAta: PublicKey;
    lpMint: PublicKey;
    vault: PublicKey;
    userCollateralAta: PublicKey;
    vaultAuth: PublicKey;
    depositPda: PublicKey;
  };
  /** FlushToInsurance accounts (CPI from stake → percolator) */
  flushToInsurance: {
    caller: PublicKey;
    pool: PublicKey;
    vault: PublicKey;
    vaultAuth: PublicKey;
    slab: PublicKey;
    wrapperVault: PublicKey;
    percolatorProgram: PublicKey;
  };
}

/**
 * Build account keys for InitPool instruction.
 * Returns array of {pubkey, isSigner, isWritable} in the order the program expects.
 */
export function initPoolAccounts(a: StakeAccounts['initPool']) {
  return [
    { pubkey: a.admin, isSigner: true, isWritable: true },
    { pubkey: a.slab, isSigner: false, isWritable: false },
    { pubkey: a.pool, isSigner: false, isWritable: true },
    { pubkey: a.lpMint, isSigner: false, isWritable: true },
    { pubkey: a.vault, isSigner: false, isWritable: true },
    { pubkey: a.vaultAuth, isSigner: false, isWritable: false },
    { pubkey: a.collateralMint, isSigner: false, isWritable: false },
    { pubkey: a.percolatorProgram, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ];
}

/**
 * Build account keys for Deposit instruction.
 */
export function depositAccounts(a: StakeAccounts['deposit']) {
  return [
    { pubkey: a.user, isSigner: true, isWritable: false },
    { pubkey: a.pool, isSigner: false, isWritable: true },
    { pubkey: a.userCollateralAta, isSigner: false, isWritable: true },
    { pubkey: a.vault, isSigner: false, isWritable: true },
    { pubkey: a.lpMint, isSigner: false, isWritable: true },
    { pubkey: a.userLpAta, isSigner: false, isWritable: true },
    { pubkey: a.vaultAuth, isSigner: false, isWritable: false },
    { pubkey: a.depositPda, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
}

/**
 * Build account keys for Withdraw instruction.
 */
export function withdrawAccounts(a: StakeAccounts['withdraw']) {
  return [
    { pubkey: a.user, isSigner: true, isWritable: false },
    { pubkey: a.pool, isSigner: false, isWritable: true },
    { pubkey: a.userLpAta, isSigner: false, isWritable: true },
    { pubkey: a.lpMint, isSigner: false, isWritable: true },
    { pubkey: a.vault, isSigner: false, isWritable: true },
    { pubkey: a.userCollateralAta, isSigner: false, isWritable: true },
    { pubkey: a.vaultAuth, isSigner: false, isWritable: false },
    { pubkey: a.depositPda, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
  ];
}

/**
 * Build account keys for FlushToInsurance instruction.
 */
export function flushToInsuranceAccounts(a: StakeAccounts['flushToInsurance']) {
  return [
    { pubkey: a.caller, isSigner: true, isWritable: false },
    { pubkey: a.pool, isSigner: false, isWritable: true },
    { pubkey: a.vault, isSigner: false, isWritable: true },
    { pubkey: a.vaultAuth, isSigner: false, isWritable: false },
    { pubkey: a.slab, isSigner: false, isWritable: true },
    { pubkey: a.wrapperVault, isSigner: false, isWritable: true },
    { pubkey: a.percolatorProgram, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
}
