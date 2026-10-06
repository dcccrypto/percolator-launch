/**
 * P2b Earn-as-counterparty client ABI: tag 103 `VaultLpAllocate`, the `VaultLpExtV19` PDA and
 * its decoder, and the error block 100..=103.
 *
 * LOCAL ADAPTER. The SDK 9.0.0 candidate (percolator-sdk #397 / #399) does not carry the #526
 * additions yet; this is the thin local stand-in the app codes against. When 9.0.0 ships these
 * exports, delete this file and re-point `./index.ts` (the only import site) at the package.
 *
 * Source of truth (read, every offset verified): percolator-prog #526 head `d9e3e2d7`
 * (`feat/p2b-earn-allocation` merged with `integration/p2b-merged`):
 *  - `handle_vault_lp_allocate` account list (src/v16_program.rs, the doc above it);
 *  - `state::VaultLpExtV19` (128 B, `["vault_lp_ext", market]`, HEADER_LEN = 16 in front);
 *  - `PercolatorError` 100..=103 explicit discriminants.
 */
import { PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from "@solana/web3.js";

export const TAG_VAULT_LP_ALLOCATE = 103;
/** `constants::VAULT_LP_EXT_SEED`. */
export const VAULT_LP_EXT_SEED = "vault_lp_ext";
const HEADER_LEN = 16;
export const VAULT_LP_EXT_RECORD_LEN = 128;
export const VAULT_LP_EXT_ACCOUNT_LEN = HEADER_LEN + VAULT_LP_EXT_RECORD_LEN;
export const VAULT_LP_EXT_VERSION = 1;

const U128_MAX = (1n << 128n) - 1n;

/** `["vault_lp_ext", market]`. */
export function deriveVaultLpExt(programId: PublicKey, market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([new TextEncoder().encode(VAULT_LP_EXT_SEED), market.toBytes()], programId)[0];
}

/** Wire: `[103, amount u128]` (17 B). The wrapper moves `min(amount, alpha room, buffer room)`. */
export function encodeVaultLpAllocate(amount: bigint): Uint8Array {
  if (amount < 0n || amount > U128_MAX) throw new Error(`amount must be a u128, got ${amount}`);
  const out = new Uint8Array(17);
  out[0] = TAG_VAULT_LP_ALLOCATE;
  const dv = new DataView(out.buffer);
  dv.setBigUint64(1, amount & 0xffff_ffff_ffff_ffffn, true);
  dv.setBigUint64(9, amount >> 64n, true);
  return out;
}

/** The accounts tag 103 needs (all of them exist for any bound market; the ext is created on first use). */
export interface VaultLpAllocateAccounts {
  programId: PublicKey;
  cranker: PublicKey;
  market: PublicKey;
  registry: PublicKey;
  vaultLpState: PublicKey;
  lpPortfolio: PublicKey;
  /** The registry's own domain ledger and its sibling (domain ^ 1). */
  ledger: PublicKey;
  siblingLedger: PublicKey;
}

const m = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean): AccountMeta => ({ pubkey, isSigner, isWritable });

/**
 * Tag 103, permissionless, Live only. Accounts: 0 cranker (s,w) · 1 market (w) · 2 registry (w) ·
 * 3 vault_lp_state (w) · 4 lp_portfolio (w) · 5 own ledger (w) · 6 sibling ledger (w) ·
 * 7 vault_lp_ext (w) · 8 system program.
 */
export function buildVaultLpAllocateIx(a: VaultLpAllocateAccounts, amount: bigint = U128_MAX): TransactionInstruction {
  return new TransactionInstruction({
    programId: a.programId,
    keys: [
      m(a.cranker, true, true),
      m(a.market, false, true),
      m(a.registry, false, true),
      m(a.vaultLpState, false, true),
      m(a.lpPortfolio, false, true),
      m(a.ledger, false, true),
      m(a.siblingLedger, false, true),
      m(deriveVaultLpExt(a.programId, a.market), false, true),
      m(SystemProgram.programId, false, false),
    ],
    data: Buffer.from(encodeVaultLpAllocate(amount)),
  });
}

/** Decoded `VaultLpExtV19`. */
export interface VaultLpExtV19 {
  marketGroup: Uint8Array;
  /** Senior principal sitting in the vault LP's engine capital because of tag 103 (less recalls). */
  allocatedAtoms: bigint;
  cushionAccruedAtoms: bigint;
  allocatedTotalAtoms: bigint;
  deallocatedTotalAtoms: bigint;
  /** Allocation fraction of C_eff (bps). */
  allocAlphaBps: number;
  /** Redemption buffer kept liquid in the pots (bps; the wrapper's minimum is 30%). */
  allocBufferBps: number;
  cushionTargetBps: number;
  cushionShareBps: number;
  version: number;
}

function u128le(d: DataView, off: number): bigint {
  return d.getBigUint64(off, true) | (d.getBigUint64(off + 8, true) << 64n);
}

/** Decode a whole ext ACCOUNT (header + record). `null` when too short or not version 1. */
export function decodeVaultLpExtV19(account: Uint8Array): VaultLpExtV19 | null {
  if (account.length < VAULT_LP_EXT_ACCOUNT_LEN) return null;
  const r = account.subarray(HEADER_LEN, HEADER_LEN + VAULT_LP_EXT_RECORD_LEN);
  const d = new DataView(r.buffer, r.byteOffset, r.byteLength);
  const version = r[104] as number;
  if (version !== VAULT_LP_EXT_VERSION) return null;
  return {
    marketGroup: r.slice(0, 32),
    allocatedAtoms: u128le(d, 32),
    cushionAccruedAtoms: u128le(d, 48),
    allocatedTotalAtoms: u128le(d, 64),
    deallocatedTotalAtoms: u128le(d, 80),
    allocAlphaBps: d.getUint16(96, true),
    allocBufferBps: d.getUint16(98, true),
    cushionTargetBps: d.getUint16(100, true),
    cushionShareBps: d.getUint16(102, true),
    version,
  };
}

/** Error block 100..=103 (explicit discriminants in the wrapper). */
export const P2B_EARN_ERRORS = Object.freeze({
  VaultLpAllocateRefused: 100,
  VaultLpCapacityLocked: 101,
  VaultLpCreatorFeeVesting: 102,
  VaultLpSeniorCapitalHalt: 103,
} as const);
