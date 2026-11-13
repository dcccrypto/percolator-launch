/*
 * LOCAL ADAPTER PORT, not original code: from percolator-sdk PR #438 (`feat/v22-587-creator-fee-payee` @ 5d0d86c, on feat/v22-sdk-growth
 * d13e1a48; additive, no version bump), src/abi/creator-fee-payee-v22.ts + src/solana/creator-fee-payee-v22.ts, verbatim except the
 * imports (retargeted to the installed @percolatorct/sdk 8.0.0 root, ./layout, ./v22-wire). Wire / accounts / rules read from
 * percolator-prog rc23 2b5dce8a (prog #644, #587): tag 125 SetCreatorFeePayee, the CreatorFeePayeeV22 record (kind 19), p4 bit 3,
 * error 136, and the tag 90 payee route. Byte parity is the SDK's (fixture generated from the real crate; app/__tests__ pin the bytes).
 * Delete when @percolatorct/sdk >= 9.0.0 ships these and point ./index.ts at the package. Do not edit here; fix upstream in percolator-sdk.
 */
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import {
  buildAccountMetas,
  concatBytes,
  deriveVaultAuthority,
  encPubkey,
  encU16,
  encU64,
  encU8,
  encodeWithdrawCreatorFee,
  parseAssetControlSequencesV17,
  parseAssetOracleProfileV17,
  parseWrapperConfigV17,
} from "@percolatorct/sdk";
import type { AccountSpec } from "@percolatorct/sdk";
import { ACCOUNT_KIND, LAYOUT_V22, UnknownLayoutError, resolveLayout, resolveMarketGeometry } from "./layout";
import type { LayoutTable } from "./layout";
import { P4_FLAG_CREATOR_FEE_PAYEE_V22 } from "./v22-wire";

// ============================================================================
// Constants
// ============================================================================

/** Wrapper instruction tag (`constants::TAG_SET_CREATOR_FEE_PAYEE`). */
export const TAG_SET_CREATOR_FEE_PAYEE_V22 = 125;
/** Tag 125 data length: `[125][asset_index u16][market_id u64][payee 32][authority_epoch u64]`. */
export const SET_CREATOR_FEE_PAYEE_LEN_V22 = 51;
/** PDA seed (`creator_fee_payee_v22::CREATOR_FEE_PAYEE_SEED`). */
export const CREATOR_FEE_PAYEE_SEED_V22 = "creator_fee_payee";
/** The only record version (`CREATOR_FEE_PAYEE_VERSION`). */
export const CREATOR_FEE_PAYEE_VERSION_V22 = 1;
/** `size_of::<CreatorFeePayeeV22>()`. */
export const CREATOR_FEE_PAYEE_BODY_LEN_V22 = 72;
/** Account length: 16-byte header + 72-byte body (the wrapper requires this exact length). */
export const CREATOR_FEE_PAYEE_ACCOUNT_LEN_V22 = 16 + CREATOR_FEE_PAYEE_BODY_LEN_V22;
/** Error code `PercolatorError::CreatorFeePayeeInvalid`. */
export const CREATOR_FEE_PAYEE_INVALID_ERROR_V22 = 136;
/** Tag 90 account index of the payee record on the payee route. */
export const WITHDRAW_CREATOR_FEE_PAYEE_ACCOUNT_INDEX_V22 = 6;

/** Field offsets inside the 72-byte body (after the 16-byte header). */
export const CREATOR_FEE_PAYEE_FIELD_OFF_V22 = Object.freeze({
  market: 0,
  payee: 32,
  assetIndex: 64,
  version: 66,
  bump: 67,
  reserved: 68,
} as const);

const ZERO32 = new Uint8Array(32);

function toBytes32(k: PublicKey | Uint8Array, what: string): Uint8Array {
  const b = k instanceof PublicKey ? k.toBytes() : k;
  if (b.length !== 32) throw new Error(`${what}: expected 32 bytes, got ${b.length}`);
  return b;
}

function eq32(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return false;
  return true;
}

function checkAssetIndex(assetIndex: number, fn: string): void {
  if (!Number.isInteger(assetIndex) || assetIndex < 0 || assetIndex > 0xffff) {
    throw new Error(`${fn}: assetIndex ${assetIndex} is not a u16`);
  }
}

// ============================================================================
// Instruction data + accounts
// ============================================================================

/** Inputs for {@link encodeSetCreatorFeePayeeV22}. */
export interface SetCreatorFeePayeeArgsV22 {
  /** Asset slot whose creator fee the payee receives. */
  assetIndex: number;
  /** The asset's live generation (`engine.asset.market_id`); a mismatch is 123 `AssetGenerationMismatch`. */
  marketId: bigint | string;
  /** Payee wallet. Never zero, never the market's vault authority PDA, never the payee already recorded (136). */
  payee: PublicKey | Uint8Array;
  /** Live-read current `authority_epoch` of this asset (CAS; the program advances it by one on success). */
  authorityEpoch: bigint | string;
}

/**
 * Encode tag 125 `SetCreatorFeePayee`: `[125][asset_index u16 LE][market_id u64 LE][payee 32][authority_epoch u64 LE]`
 * (51 bytes; `Instruction::SetCreatorFeePayee::encode`).
 *
 * @param args  Asset index, live generation, payee wallet, current authority epoch.
 * @returns Instruction data.
 * @throws If `assetIndex` is not a u16, the payee is not 32 bytes or is all zero, or a u64 is out of range.
 * @example
 * ```ts
 * const data = encodeSetCreatorFeePayeeV22({ assetIndex: 0, marketId: 1n, payee: creatorWallet, authorityEpoch: 0n });
 * ```
 */
export function encodeSetCreatorFeePayeeV22(args: SetCreatorFeePayeeArgsV22): Uint8Array {
  checkAssetIndex(args.assetIndex, "encodeSetCreatorFeePayeeV22");
  const payee = toBytes32(args.payee, "encodeSetCreatorFeePayeeV22 payee");
  if (eq32(payee, ZERO32)) throw new Error("encodeSetCreatorFeePayeeV22: payee must not be zero (the program refuses it with 136)");
  return concatBytes(
    encU8(TAG_SET_CREATOR_FEE_PAYEE_V22),
    encU16(args.assetIndex),
    encU64(args.marketId),
    encPubkey(new PublicKey(payee)),
    encU64(args.authorityEpoch),
  );
}

/**
 * Tag 125 accounts (`handle_set_creator_fee_payee`):
 *   [0] assetAdmin    signer, writable (pays the payee record's rent the first time)
 *   [1] market        writable
 *   [2] payeeRecord   writable (`["creator_fee_payee", market, asset_index u16 LE]`)
 *   [3] systemProgram
 */
export const ACCOUNTS_SET_CREATOR_FEE_PAYEE_V22: readonly AccountSpec[] = [
  { name: "assetAdmin", signer: true, writable: true },
  { name: "market", signer: false, writable: true },
  { name: "payeeRecord", signer: false, writable: true },
  { name: "systemProgram", signer: false, writable: false },
] as const;

/**
 * Tag 90 accounts on the PAYEE route (asset_admin burned, p4 bit 3 set; `handle_withdraw_creator_fee`):
 *   [0] caller        signer (anyone; not required writable)
 *   [1] market        writable
 *   [2] payeeToken    writable: MUST be the payee's canonical ATA for the vault mint (classic SPL Token), with no
 *                     delegate and no close authority ({@link creatorFeePayeeDestinationV22})
 *   [3] vaultToken    writable
 *   [4] vaultAuthority
 *   [5] tokenProgram
 *   [6] payeeRecord   the asset's payee PDA ({@link deriveCreatorFeePayeeV22})
 * The data is the unchanged 27-byte tag 90 (`encodeWithdrawCreatorFee`). On a LIVE admin the 6-account list
 * `ACCOUNTS_WITHDRAW_CREATOR_FEE` applies byte for byte (an extra `[6]` is ignored there).
 */
export const ACCOUNTS_WITHDRAW_CREATOR_FEE_TO_PAYEE_V22: readonly AccountSpec[] = [
  { name: "caller", signer: true, writable: false },
  { name: "market", signer: false, writable: true },
  { name: "payeeToken", signer: false, writable: true },
  { name: "vaultToken", signer: false, writable: true },
  { name: "vaultAuthority", signer: false, writable: false },
  { name: "tokenProgram", signer: false, writable: false },
  { name: "payeeRecord", signer: false, writable: false },
] as const;

// ============================================================================
// PDA + destination
// ============================================================================

/**
 * Derive the payee record PDA `["creator_fee_payee", market, asset_index u16 LE]` (`state::derive_creator_fee_payee`).
 *
 * @param programId   Wrapper program id.
 * @param market      Market (slab) account.
 * @param assetIndex  Asset slot (u16).
 * @returns `[pda, bump]`.
 * @example
 * ```ts
 * const [payeeRecord] = deriveCreatorFeePayeeV22(programId, market, 0);
 * ```
 */
export function deriveCreatorFeePayeeV22(programId: PublicKey, market: PublicKey, assetIndex: number): [PublicKey, number] {
  checkAssetIndex(assetIndex, "deriveCreatorFeePayeeV22");
  const idx = new Uint8Array(2);
  new DataView(idx.buffer).setUint16(0, assetIndex, true);
  return PublicKey.findProgramAddressSync([Buffer.from(CREATOR_FEE_PAYEE_SEED_V22), market.toBuffer(), Buffer.from(idx)], programId);
}

/** Associated Token Account program id (the one `canonical_vault_address` derives under). */
const ASSOCIATED_TOKEN_PROGRAM_ID_V22 = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/** Classic SPL Token program id (`spl_token::ID`, the only token program `canonical_vault_address` uses). */
const SPL_TOKEN_PROGRAM_ID_V22 = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/**
 * The ONLY destination tag 90 accepts on the payee route: the payee's canonical associated token account for the vault
 * mint, derived exactly like the wrapper's `canonical_vault_address(payee, mint)` (seeds `[payee, spl_token::ID, mint]`
 * under the ATA program; classic SPL Token, any payee including off-curve keys).
 *
 * @param payee      Recorded payee wallet.
 * @param vaultMint  The market's collateral (vault) mint.
 * @returns The payee ATA address.
 * @example
 * ```ts
 * const dest = creatorFeePayeeDestinationV22(rec.payee, collateralMint);
 * ```
 */
export function creatorFeePayeeDestinationV22(payee: PublicKey, vaultMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [payee.toBuffer(), SPL_TOKEN_PROGRAM_ID_V22.toBuffer(), vaultMint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID_V22,
  )[0];
}

// ============================================================================
// Record decoder
// ============================================================================

/** A decoded `CreatorFeePayeeV22` record. */
export interface CreatorFeePayeeV22 {
  market: PublicKey;
  payee: PublicKey;
  assetIndex: number;
  version: number;
  bump: number;
}

/**
 * Decode a payee record with the wrapper's own validity rules (`read_creator_fee_payee` + `validate_creator_fee_payee`):
 * exact length 88, header magic / VERSION / kind 19, record version 1, non-zero market and payee, reserved bytes zero.
 * A record the wrapper would refuse (136) is refused here.
 *
 * @param data   Raw account bytes.
 * @param table  Layout table (default {@link LAYOUT_V22}).
 * @returns The record.
 * @throws UnknownLayoutError on any mismatch.
 * @example
 * ```ts
 * const info = await connection.getAccountInfo(deriveCreatorFeePayeeV22(programId, market, 0)[0]);
 * const rec = info ? decodeCreatorFeePayeeV22(info.data) : null;
 * ```
 */
export function decodeCreatorFeePayeeV22(data: Uint8Array, table: LayoutTable = LAYOUT_V22): CreatorFeePayeeV22 {
  const parser = "decodeCreatorFeePayeeV22";
  const kind = ACCOUNT_KIND.CreatorFeePayee;
  const L = resolveLayout(data, { parser, kind, versions: [table.version] });
  if (data.length !== CREATOR_FEE_PAYEE_ACCOUNT_LEN_V22) {
    throw new UnknownLayoutError(
      data.length < CREATOR_FEE_PAYEE_ACCOUNT_LEN_V22 ? "TOO_SHORT" : "BAD_LENGTH",
      parser,
      `creator fee payee account length ${data.length} != ${CREATOR_FEE_PAYEE_ACCOUNT_LEN_V22}`,
      { version: L.version, kind },
    );
  }
  const b = 16;
  const F = CREATOR_FEE_PAYEE_FIELD_OFF_V22;
  const market = data.subarray(b + F.market, b + F.market + 32);
  const payee = data.subarray(b + F.payee, b + F.payee + 32);
  const version = data[b + F.version];
  const reserved = data.subarray(b + F.reserved, b + F.reserved + 4);
  const bad = (why: string): never => {
    throw new UnknownLayoutError("INVALID_RECORD", parser, `invalid creator fee payee record: ${why}`, { version: L.version, kind });
  };
  if (version !== CREATOR_FEE_PAYEE_VERSION_V22) bad(`version ${version}`);
  if (eq32(market, ZERO32)) bad("zero market");
  if (eq32(payee, ZERO32)) bad("zero payee");
  if (reserved.some((x) => x !== 0)) bad("reserved bytes not zero");
  return {
    market: new PublicKey(market.slice()),
    payee: new PublicKey(payee.slice()),
    assetIndex: data[b + F.assetIndex] | (data[b + F.assetIndex + 1] << 8),
    version,
    bump: data[b + F.bump],
  };
}

// ============================================================================
// Rules (mirrors of the pure wrapper functions; parity-checked)
// ============================================================================

/**
 * Profile `p4_flags` bit 3: a payee is recorded for this asset (`has_payee_bit`).
 *
 * @param p4Flags  Oracle profile byte +20 (`LAYOUT_V22.profileP4Flags`).
 * @returns Whether the bit is set.
 * @example
 * ```ts
 * const flagged = hasCreatorFeePayeeFlagV22(marketData[profileOff + LAYOUT_V22.profileP4Flags]);
 * ```
 */
export function hasCreatorFeePayeeFlagV22(p4Flags: number): boolean {
  return (p4Flags & P4_FLAG_CREATOR_FEE_PAYEE_V22) !== 0;
}

/** How tag 90 authorises a claim on one asset (`ClaimRoute`). */
export type CreatorFeeClaimRouteV22 = "AdminSigned" | "Payee" | "Refused";

/**
 * Tag 90's routing rule (`claim_route`): a live `asset_admin` signs (6 accounts, any token account it owns); a burned
 * admin with p4 bit 3 routes to the payee (permissionless, 7 accounts); a burned admin without it is refused (8).
 *
 * @param assetAdmin  The asset's `asset_admin` (all zero = burned).
 * @param payeeFlag   p4 bit 3 ({@link hasCreatorFeePayeeFlagV22}).
 * @returns The route.
 * @example
 * ```ts
 * if (creatorFeeClaimRouteV22(profile.assetAdmin, flagged) === "Payee") { ... }
 * ```
 */
export function creatorFeeClaimRouteV22(assetAdmin: PublicKey | Uint8Array, payeeFlag: boolean): CreatorFeeClaimRouteV22 {
  if (!eq32(toBytes32(assetAdmin, "creatorFeeClaimRouteV22 assetAdmin"), ZERO32)) return "AdminSigned";
  return payeeFlag ? "Payee" : "Refused";
}

/**
 * CloseSlab re-book rule (`creator_pot_orphaned`): a non-zero pot moves to the protocol leg ONLY when it has no claim
 * path (burned admin, no payee). Otherwise CloseSlab refuses with 71 until the pot is claimed through tag 90.
 *
 * @param assetAdmin  The asset's `asset_admin`.
 * @param payeeFlag   p4 bit 3.
 * @param pot         Owed creator atoms (asset 0: its profile counter plus the legacy market-wide counter).
 * @returns Whether CloseSlab re-books the pot itself.
 * @example
 * ```ts
 * const rebooked = creatorPotOrphanedV22(profile.assetAdmin, flagged, owed);
 * ```
 */
export function creatorPotOrphanedV22(assetAdmin: PublicKey | Uint8Array, payeeFlag: boolean, pot: bigint): boolean {
  return pot !== 0n && creatorFeeClaimRouteV22(assetAdmin, payeeFlag) === "Refused";
}

/**
 * Tag 125 preflight (`payee_update_allowed`): only the asset's LIVE `asset_admin`, to a non-zero payee that is not the
 * market's vault authority PDA and differs from the payee already recorded. `false` = the program refuses with 136.
 *
 * @param assetAdmin      The asset's `asset_admin`.
 * @param signer          The signer of tag 125.
 * @param currentPayee    The recorded payee when p4 bit 3 is set, else null.
 * @param newPayee        The payee to record.
 * @param vaultAuthority  The market's vault authority PDA (`["vault", market]`).
 * @returns Whether the program would accept the update.
 * @example
 * ```ts
 * if (!payeeUpdateAllowedV22(profile.assetAdmin, wallet, null, wallet, vaultAuthority)) throw new Error("refused");
 * ```
 */
export function payeeUpdateAllowedV22(
  assetAdmin: PublicKey | Uint8Array,
  signer: PublicKey | Uint8Array,
  currentPayee: PublicKey | Uint8Array | null,
  newPayee: PublicKey | Uint8Array,
  vaultAuthority: PublicKey | Uint8Array,
): boolean {
  const admin = toBytes32(assetAdmin, "assetAdmin");
  const next = toBytes32(newPayee, "newPayee");
  return (
    !eq32(admin, ZERO32) &&
    eq32(admin, toBytes32(signer, "signer")) &&
    !eq32(next, ZERO32) &&
    !eq32(next, toBytes32(vaultAuthority, "vaultAuthority")) &&
    !(currentPayee !== null && eq32(toBytes32(currentPayee, "currentPayee"), next))
  );
}

// ============================================================================
// Tag 125
// ============================================================================

/** Inputs for {@link buildSetCreatorFeePayeeIxV22}. */
export interface SetCreatorFeePayeeIxArgsV22 {
  programId: PublicKey;
  market: PublicKey;
  /** The asset's LIVE `asset_admin` (signer; pays the record's rent the first time). */
  assetAdmin: PublicKey;
  assetIndex: number;
  /** The asset's live generation (`engine.asset.market_id`). */
  marketId: bigint;
  payee: PublicKey;
  /** Live-read current `authority_epoch` of this asset (the program advances it by one). */
  authorityEpoch: bigint;
}

/**
 * Build tag 125 `SetCreatorFeePayee`. Send it BEFORE the stake `BurnAssetAdmin` (tag 21): after the burn no key can set
 * a payee, and the creator fee then has no claim path (CloseSlab re-books it to the protocol leg).
 *
 * @param a  See {@link SetCreatorFeePayeeIxArgsV22}.
 * @returns The instruction (4 accounts, 51 data bytes).
 * @example
 * ```ts
 * const ix = buildSetCreatorFeePayeeIxV22({ programId, market, assetAdmin: wallet, assetIndex: 0, marketId, payee: wallet, authorityEpoch });
 * ```
 */
export function buildSetCreatorFeePayeeIxV22(a: SetCreatorFeePayeeIxArgsV22): TransactionInstruction {
  const [payeeRecord] = deriveCreatorFeePayeeV22(a.programId, a.market, a.assetIndex);
  return new TransactionInstruction({
    programId: a.programId,
    keys: buildAccountMetas(ACCOUNTS_SET_CREATOR_FEE_PAYEE_V22, {
      assetAdmin: a.assetAdmin, market: a.market, payeeRecord, systemProgram: SystemProgram.programId,
    }),
    data: Buffer.from(encodeSetCreatorFeePayeeV22({
      assetIndex: a.assetIndex, marketId: a.marketId, payee: a.payee, authorityEpoch: a.authorityEpoch,
    })),
  });
}

// ============================================================================
// Tag 90, payee route
// ============================================================================

/** Inputs for {@link buildClaimCreatorFeeToPayeeIxsV22}. */
export interface ClaimCreatorFeeToPayeeArgsV22 {
  programId: PublicKey;
  market: PublicKey;
  /** Any signer (keeper, closer, the payee itself). Pays the payee ATA rent when `createPayeeAta` is on. */
  caller: PublicKey;
  assetIndex: number;
  /** The recorded payee (from {@link decodeCreatorFeePayeeV22} or the planner input). */
  payee: PublicKey;
  /** The market's collateral (vault) mint. */
  vaultMint: PublicKey;
  /** The market's vault token account. */
  vaultToken: PublicKey;
  /** Exact atoms to pay (> 0, <= this asset's pot; asset 0 also draws the legacy market-wide pot). */
  amount: bigint;
  /** Live-read current `authority_epoch` of this asset (check only, not advanced). */
  authorityEpoch: bigint;
  /** Prepend an idempotent create of the payee ATA (default true: tag 90 needs the account to exist). */
  createPayeeAta?: boolean;
}

/**
 * Build the permissionless creator-fee claim to the recorded payee (tag 90, 7 accounts): optional idempotent ATA create,
 * then tag 90 paying `creatorFeePayeeDestinationV22(payee, vaultMint)`. Valid only when the asset's `asset_admin` is
 * burned and p4 bit 3 is set (route "Payee"); otherwise the program refuses (live admin: 8 unless the caller is the
 * admin; burned without payee: 8).
 *
 * @param a  See {@link ClaimCreatorFeeToPayeeArgsV22}.
 * @returns 1 or 2 instructions, in order.
 * @throws If `amount` is not positive.
 * @example
 * ```ts
 * const ixs = buildClaimCreatorFeeToPayeeIxsV22({ programId, market, caller: keeper, assetIndex: 0, payee, vaultMint, vaultToken, amount: owed, authorityEpoch });
 * ```
 */
export function buildClaimCreatorFeeToPayeeIxsV22(a: ClaimCreatorFeeToPayeeArgsV22): TransactionInstruction[] {
  if (a.amount <= 0n) throw new Error("buildClaimCreatorFeeToPayeeIxsV22: amount must be > 0 (tag 90 refuses a zero claim)");
  const [payeeRecord] = deriveCreatorFeePayeeV22(a.programId, a.market, a.assetIndex);
  const [vaultAuthority] = deriveVaultAuthority(a.programId, a.market);
  const payeeToken = creatorFeePayeeDestinationV22(a.payee, a.vaultMint);
  const ixs: TransactionInstruction[] = [];
  if (a.createPayeeAta ?? true) {
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(a.caller, payeeToken, a.payee, a.vaultMint, TOKEN_PROGRAM_ID));
  }
  ixs.push(new TransactionInstruction({
    programId: a.programId,
    keys: buildAccountMetas(ACCOUNTS_WITHDRAW_CREATOR_FEE_TO_PAYEE_V22, {
      caller: a.caller, market: a.market, payeeToken, vaultToken: a.vaultToken, vaultAuthority,
      tokenProgram: TOKEN_PROGRAM_ID, payeeRecord,
    }),
    data: Buffer.from(encodeWithdrawCreatorFee({ amount: a.amount, assetIndex: a.assetIndex, authorityEpoch: a.authorityEpoch })),
  }));
  return ixs;
}

// ============================================================================
// Market reader
// ============================================================================

/** Per-asset creator-fee claim state read from a market account. */
export interface CreatorFeeClaimStateV22 {
  assetIndex: number;
  assetAdmin: PublicKey;
  /** p4 bit 3: a payee is recorded (read the record at {@link deriveCreatorFeePayeeV22} for the wallet). */
  payeeFlag: boolean;
  route: CreatorFeeClaimRouteV22;
  /** What tag 90 can pay for this asset: its own counter, plus (asset 0 only) the legacy market-wide counter. */
  owed: bigint;
  /** Current `authority_epoch` of this asset (tag 90 / tag 125 CAS input). */
  authorityEpoch: bigint;
}

/**
 * Read one asset's creator-fee claim state from a v2.2 market account (profile `asset_admin`, `p4_flags`, the asset's
 * `creator_fee_claimable_atoms`, the legacy `WrapperConfig.creator_fee_claimable_atoms` for asset 0, and the asset's
 * authority epoch).
 *
 * @param marketData  Raw market account bytes.
 * @param assetIndex  Asset slot.
 * @returns The state.
 * @throws UnknownLayoutError if the account is not a known market layout; Error if the slot is not present.
 * @example
 * ```ts
 * const s = readCreatorFeeClaimStateV22(info.data, 0);
 * if (s.route === "Payee" && s.owed > 0n) { ... }
 * ```
 */
export function readCreatorFeeClaimStateV22(marketData: Uint8Array, assetIndex: number): CreatorFeeClaimStateV22 {
  const g = resolveMarketGeometry(marketData, { parser: "readCreatorFeeClaimStateV22", strictLength: false });
  if (!Number.isInteger(assetIndex) || assetIndex < 0 || assetIndex >= g.slotCount) {
    throw new Error(`readCreatorFeeClaimStateV22: asset ${assetIndex} is not present (${g.slotCount} slots)`);
  }
  const slot = g.slotOff(assetIndex);
  const profileOff = slot + g.layout.wrapperSlot.oracleProfile;
  const profile = parseAssetOracleProfileV17(marketData, profileOff);
  const payeeFlag = hasCreatorFeePayeeFlagV22(marketData[profileOff + g.layout.wrapperSlot.profileP4Flags]);
  const legacy = assetIndex === 0 ? parseWrapperConfigV17(marketData).creatorFeeClaimableAtoms : 0n;
  return {
    assetIndex,
    assetAdmin: profile.assetAdmin,
    payeeFlag,
    route: creatorFeeClaimRouteV22(profile.assetAdmin, payeeFlag),
    owed: profile.creatorFeeClaimableAtoms + legacy,
    authorityEpoch: parseAssetControlSequencesV17(marketData, slot).authorityEpoch,
  };
}
