/*
 * LOCAL ADAPTER PORT, not original code: verbatim from percolator-sdk feat/v22-sdk @ ecb6215 (draft dcccrypto/percolator-sdk#406, sdk 9.0.0-candidate),
 * src/solana/p3-vault-lp.ts. Only the imports are retargeted (the vendored v22 layout/slab ports, sibling records ports, and the installed @percolatorct/sdk 8.0.0 root).
 * Delete when @percolatorct/sdk >= 9.0.0 ships and point ../../records.ts at the package. Do not edit here; fix upstream in percolator-sdk.
 */
/**
 * P3 vault-owned LP — account decoders, PDAs, instruction builders, the bound-vault tail for
 * Earn tags 75/77/78, and the vault-LP refresh crank. Additive to SDK 8.0.0.
 *
 * Source: percolator-prog `feat/p3-vault-owned-lp` @ `5e4c15ff66a4176cf9b0204ef35aef6df058f018` (P3 candidate FINAL: senior draw, recall cap, pause 89, cross-pot 77, resolved-lock fixes A–D, worse-of 75/77 pricing)
 * (`state::{VaultLpStateV18, AssetVaultLpV18, read_asset_vault_lp}`, `load_bound_vault_lp_tail`,
 * `vault_lp_refresh_snapshot`). Offsets are pinned by `test/p3.test.ts` against rustc
 * `offset_of!` on the REAL P3 structs, and the per-asset record offset against a market
 * account built by the P3 crate itself.
 *
 * Relaunch wrapper = P1 + P3 (`5e4c15ff`). On an older v18.2 market every AssetVaultLpV18
 * record is zero ("no vault LP bound").
 *
 * @module p3-vault-lp
 */
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import type { AccountMeta } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { buildAccountMetas, ACCOUNTS_CLAIM_RESOLVED_PAYOUT_TOPUP } from "@percolatorct/sdk";
import type { AccountSpec } from "@percolatorct/sdk";
import { encodeExecuteRedemption, encodePermissionlessCrank } from "@percolatorct/sdk";
import type { CrankObservationHint } from "@percolatorct/sdk";
import {
  ACCOUNTS_DEPOSIT_JUNIOR_TRANCHE_P3,
  ACCOUNTS_INIT_VAULT_LP_P3,
  ACCOUNTS_SET_VAULT_LP_RISK_P3,
  ACCOUNTS_VAULT_LP_CONVERT_PNL_P3,
  ACCOUNTS_VAULT_LP_RECALL_P3,
  ACCOUNTS_VAULT_LP_RELEASE_SURPLUS_P3,
  ACCOUNTS_VAULT_LP_RELEASE_SURPLUS_RESOLVED_TAIL_P3,
  ACCOUNTS_VAULT_LP_SET_MATCHER_P3,
  ACCOUNTS_VAULT_LP_SETTLE_RESOLVED_P3,
  ACCOUNTS_WITHDRAW_JUNIOR_TRANCHE_P3,
  encodeDepositJuniorTrancheP3,
  encodeInitVaultLpP3,
  encodeSetVaultLpRiskP3,
  encodeVaultLpConvertPnlP3,
  encodeVaultLpRecallP3,
  encodeVaultLpReleaseSurplusP3,
  encodeVaultLpSetMatcherP3,
  encodeVaultLpSettleResolvedP3,
  encodeWithdrawJuniorTrancheP3,
  CANONICAL_VAULT_LP_MATCHER_PROGRAM_DEVNET_P3,
} from "@percolatorct/sdk";
import type { SetVaultLpRiskArgsP3, VaultLpSetMatcherArgsP3 } from "@percolatorct/sdk";
import { deriveInsuranceLpMint, deriveLpBackingLedger, deriveLpEscrow, deriveLpRedemption, deriveLpVaultRegistry, deriveMatcherDelegate, deriveNftRegistry, deriveVaultAuthority } from "@percolatorct/sdk";
import { V17_HEADER_LEN } from "../slab";
import { LAYOUT_V21, resolveLayout, resolveMarketGeometry, resolvePortfolioLayout } from "../layout";
import type { LayoutTable } from "../layout";

// ============================================================================
// Layout constants (verified against P3 rustc layout)
// ============================================================================

/** `KIND_VAULT_LP_STATE`. */
export const V18_KIND_VAULT_LP_STATE_P3 = 9;
/** `size_of::<VaultLpStateV18>()`. */
export const VAULT_LP_STATE_BODY_LEN_P3 = 256;
/** `vault_lp_state_account_len()` = 16 + 256. */
export const VAULT_LP_STATE_ACCOUNT_LEN_P3 = V17_HEADER_LEN + VAULT_LP_STATE_BODY_LEN_P3;
/** `ASSET_VAULT_LP_OFF` inside each asset's 1024-byte wrapper slot. */
export const ASSET_VAULT_LP_SLOT_OFF_P3 = 896;
/** `ASSET_VAULT_LP_LEN`. */
export const ASSET_VAULT_LP_LEN_P3 = 128;
/** `ASSET_VAULT_LP_FLAG_BOUND`. */
export const ASSET_VAULT_LP_FLAG_BOUND_P3 = 1;
/** Account offset of `LpVaultRegistryV16._reserved[0]` = the "vault LP bound" flag (16 + 144). */
export const LP_VAULT_REGISTRY_BOUND_FLAG_OFF_P3 = 160;

/** Account offsets of `VaultLpStateV18` fields (header included). */
export const VAULT_LP_STATE_OFF_P3 = Object.freeze({
  marketGroup: 16, registry: 48, lpPortfolio: 80, juniorOwner: 112,
  seniorClaimAtoms: 144, juniorDepositedAtoms: 160, juniorWithdrawnAtoms: 176,
  seniorFeeCreditedAtoms: 192, recalledAtoms: 208, assetIndex: 224, juniorFloorBps: 226,
  seniorFeeShareBps: 228, version: 230, bump: 231,
  /** `_padding` [232..240) must be zero (program `validate_vault_lp_state`). */
  padding: 232,
  /** P3 senior draw FINAL `d119eebd` (was `_reserved`). */
  seniorDrawnAtoms: 240, seniorDrawOutstandingAtoms: 256,
} as const);

/** `ASSET_VAULT_LP_DRAW_OFF` inside each asset's wrapper slot (P3 senior draw FINAL `d119eebd`). */
export const ASSET_VAULT_LP_DRAW_SLOT_OFF_P3 = 832;
/** `ASSET_VAULT_LP_DRAW_LEN` (`size_of::<AssetVaultLpDrawV18>()`); ends at {@link ASSET_VAULT_LP_SLOT_OFF_P3}. */
export const ASSET_VAULT_LP_DRAW_LEN_P3 = 64;

/** Offsets of `AssetVaultLpV18` fields inside the 128-byte record. */
export const ASSET_VAULT_LP_FIELD_OFF_P3 = Object.freeze({
  vaultLpPortfolio: 0, lpNetQ: 32, levCapQ: 48, lpNetSlot: 64, skewSlopeE9: 72, skewMaxE9: 80,
  levMaxImrBps: 88, flags: 90, reserved0: 91, vaultLpMaxLevBps: 92, approvedMatcherProgram: 96,
} as const);

/**
 * Record offset of `AssetVaultLpV18::p2b_flags` (P2b, percolator-prog #526: was the zero `_reserved0`,
 * which is why {@link ASSET_VAULT_LP_FIELD_OFF_P3} still names byte 91 `reserved0` to stay equal to the P3 fixture).
 */
export const ASSET_VAULT_LP_P2B_FLAGS_OFF_P3 = 91;

/**
 * Account offset of asset `i`'s `AssetVaultLpV18` record in a market account:
 * `MARKET_GROUP_OFF + MARKET_GROUP_LEN + i·MARKET_ASSET_SLOT_LEN + 896` (= 2246 + 2325·i).
 *
 * @param assetIndex  Asset slot index.
 * @param layout      Layout table of the account's VERSION (default {@link LAYOUT_V21}; pass `LAYOUT_V22` for v2.2).
 * @returns Byte offset.
 * @example
 * ```ts
 * assetVaultLpAccountOffsetP3(0); // 2246
 * ```
 */
export function assetVaultLpAccountOffsetP3(assetIndex: number, layout: LayoutTable = LAYOUT_V21): number {
  if (!Number.isInteger(assetIndex) || assetIndex < 0) throw new Error(`assetIndex must be a non-negative integer, got ${assetIndex}`);
  return layout.marketGroupOff + layout.marketGroupLen + assetIndex * layout.assetSlotStride + layout.wrapperSlot.vaultLp;
}

/**
 * Recommended compute-unit limits for P3 transactions (measured worst cases on the relaunch head,
 * security review 2026-09-30, with headroom). The runtime default is 200k per instruction, which
 * FAILS a vault-LP TradeCpi, a large CloseResolved and 101: always set an explicit limit.
 *   tradeCpi 600k (worst 405,386; matches the app's useTrade) · closeResolved 300k (worst 204k) ·
 *   vaultLpSettleResolved (101) 400k (worst 285k) · lpVaultCrankFees (78) 120k (worst 63k) ·
 *   keeperCrank 250k (worst 151k). Sum the limits when bundling several instructions.
 */
export const RECOMMENDED_CU_P3 = Object.freeze({
  tradeCpi: 600_000,
  closeResolved: 300_000,
  vaultLpSettleResolved: 400_000,
  lpVaultCrankFees: 120_000,
  keeperCrank: 250_000,
} as const);

/** `offset_of!(AssetStateV16Account, raw_oracle_target_price)` (rustc, engine `35ddd692`). */
export const ASSET_STATE_RAW_ORACLE_TARGET_PRICE_OFF_P3 = 17;
/** `offset_of!(AssetStateV16Account, effective_price)` (rustc). */
export const ASSET_STATE_EFFECTIVE_PRICE_OFF_P3 = 25;
/** Engine `POS_SCALE` (position quantity scale). */
export const POS_SCALE_P3 = 1_000_000n;
/** Wrapper prefix of each asset slot (`ASSET_ORACLE_WRAPPER_LEN`); the engine `AssetStateV16Account` starts right after it. */
const ASSET_SLOT_WRAPPER_LEN_P3 = 1024;

/**
 * Read asset `assetIndex`'s engine prices: the lagging `effective_price` and the pending oracle
 * `raw_oracle_target_price` (the inputs of the `ede691b6` worse-of Earn pricing).
 * @param marketData  Market (slab) account data.
 * @param assetIndex  Asset slot index.
 * @returns `{ effectivePriceE6, rawOracleTargetPriceE6 }`.
 * @throws If the account is too short.
 * @example
 * ```ts
 * const { effectivePriceE6, rawOracleTargetPriceE6 } = readAssetPricesP3(slab.data, 0);
 * ```
 */
export function readAssetPricesP3(marketData: Uint8Array, assetIndex: number): { effectivePriceE6: bigint; rawOracleTargetPriceE6: bigint } {
  if (!Number.isInteger(assetIndex) || assetIndex < 0) throw new Error(`assetIndex must be a non-negative integer, got ${assetIndex}`);
  const g = resolveMarketGeometry(marketData, { parser: "readAssetPricesP3", strictLength: false });
  const base = g.engineOff(assetIndex);
  if (marketData.length < base + g.layout.assetState.effectivePrice + 8) throw new Error(`market data too short for asset ${assetIndex}`);
  const v = new DataView(marketData.buffer, marketData.byteOffset, marketData.byteLength);
  return {
    rawOracleTargetPriceE6: v.getBigUint64(base + g.layout.assetState.rawOracleTargetPrice, true),
    effectivePriceE6: v.getBigUint64(base + g.layout.assetState.effectivePrice, true),
  };
}

// ============================================================================
// Decoders
// ============================================================================

/** Decoded `VaultLpStateV18` (PDA `["vault_lp", market]`). */
export interface VaultLpStateP3 {
  marketGroup: PublicKey;
  registry: PublicKey;
  lpPortfolio: PublicKey;
  juniorOwner: PublicKey;
  /** C — the number that prices Earn shares while the junior is solvent. */
  seniorClaimAtoms: bigint;
  juniorDepositedAtoms: bigint;
  juniorWithdrawnAtoms: bigint;
  seniorFeeCreditedAtoms: bigint;
  recalledAtoms: bigint;
  assetIndex: number;
  juniorFloorBps: number;
  seniorFeeShareBps: number;
  version: number;
  bump: number;
  /** Cumulative senior backing moved into the vault LP's capital by booked draws (junior cover excluded). */
  seniorDrawnAtoms: bigint;
  /**
   * Senior loss still OUTSTANDING (C was cut by it; a later recovery restores C first). While
   * > 0 the vault LP's risk-increasing fills, 97 and 102 are halted.
   */
  seniorDrawOutstandingAtoms: bigint;
}

function view(d: Uint8Array): DataView {
  return new DataView(d.buffer, d.byteOffset, d.byteLength);
}
function u128(v: DataView, o: number): bigint {
  return (v.getBigUint64(o + 8, true) << 64n) | v.getBigUint64(o, true);
}
function i128(v: DataView, o: number): bigint {
  const x = u128(v, o);
  return x >= 1n << 127n ? x - (1n << 128n) : x;
}
function key(d: Uint8Array, o: number): PublicKey {
  return new PublicKey(d.subarray(o, o + 32));
}

/**
 * Decode a `VaultLpStateV18` account (kind 9, >= 272 bytes). Mirrors `read_vault_lp_state`'s
 * header + validation (version 1, floor 1000..=10000, senior fee share 10000, zero padding).
 *
 * @param data  Raw account bytes.
 * @returns Decoded state.
 * @throws If the kind, length or any validated field is wrong.
 * @example
 * ```ts
 * const st = decodeVaultLpStateP3(info.data);
 * ```
 */
export function decodeVaultLpStateP3(data: Uint8Array): VaultLpStateP3 {
  if (data.length < VAULT_LP_STATE_ACCOUNT_LEN_P3) throw new Error(`VaultLpStateV18: need ${VAULT_LP_STATE_ACCOUNT_LEN_P3} bytes, got ${data.length}`);
  resolveLayout(data, { parser: "decodeVaultLpStateP3", kind: V18_KIND_VAULT_LP_STATE_P3 });
  const v = view(data);
  const O = VAULT_LP_STATE_OFF_P3;
  const st: VaultLpStateP3 = {
    marketGroup: key(data, O.marketGroup), registry: key(data, O.registry), lpPortfolio: key(data, O.lpPortfolio),
    juniorOwner: key(data, O.juniorOwner), seniorClaimAtoms: u128(v, O.seniorClaimAtoms),
    juniorDepositedAtoms: u128(v, O.juniorDepositedAtoms), juniorWithdrawnAtoms: u128(v, O.juniorWithdrawnAtoms),
    seniorFeeCreditedAtoms: u128(v, O.seniorFeeCreditedAtoms), recalledAtoms: u128(v, O.recalledAtoms),
    assetIndex: v.getUint16(O.assetIndex, true), juniorFloorBps: v.getUint16(O.juniorFloorBps, true),
    seniorFeeShareBps: v.getUint16(O.seniorFeeShareBps, true), version: data[O.version], bump: data[O.bump],
    seniorDrawnAtoms: u128(v, O.seniorDrawnAtoms), seniorDrawOutstandingAtoms: u128(v, O.seniorDrawOutstandingAtoms),
  };
  // Only `_padding` must be zero: from `d119eebd` bytes [240..272) hold the senior-draw counters.
  const padZero = data.subarray(O.padding, O.padding + 8).every((b) => b === 0);
  if (st.version !== 1 || st.juniorFloorBps < 1_000 || st.juniorFloorBps > 10_000 || st.seniorFeeShareBps !== 10_000 || !padZero) {
    throw new Error("VaultLpStateV18: invalid (version/floor/fee share/padding) — the program would reject it too");
  }
  return st;
}

/** Decoded `AssetVaultLpDrawV18` (per asset, P3 senior draw FINAL `d119eebd`). */
export interface AssetVaultLpDrawP3 {
  /** Pending (unbooked) draw out of the EVEN-domain pot (domain `2·asset`). */
  pendingOutEvenAtoms: bigint;
  /** Pending (unbooked) draw out of the ODD-domain pot (domain `2·asset + 1`). */
  pendingOutOddAtoms: bigint;
  /** Mirror of `VaultLpStateV18.senior_draw_outstanding_atoms` (fill-time halt). */
  outstandingMirrorAtoms: bigint;
  /** Pending moved atoms (junior cover + senior draw) not yet booked. */
  pendingMovedAtoms: bigint;
  /**
   * A draw is pending: the next 75/77/78/97/98/102 books it and needs the drawn pots' ledgers
   * WRITABLE (the SDK builders and {@link withBoundVaultLpTailP3} always pass them writable).
   */
  hasPendingDraw: boolean;
}

/**
 * Decode asset `assetIndex`'s `AssetVaultLpDrawV18` from a market account
 * (at {@link assetVaultLpAccountOffsetP3} − {@link ASSET_VAULT_LP_DRAW_LEN_P3}).
 * @param marketData  Market (slab) account data.
 * @param assetIndex  Asset slot index.
 * @returns The draw record.
 * @throws If the account is too short.
 * @example
 * ```ts
 * const draw = decodeAssetVaultLpDrawP3(slab.data, 0);
 * if (draw.hasPendingDraw) console.log("next Earn ix books the draw");
 * ```
 */
export function decodeAssetVaultLpDrawP3(marketData: Uint8Array, assetIndex: number): AssetVaultLpDrawP3 {
  const g = resolveMarketGeometry(marketData, { parser: "decodeAssetVaultLpDrawP3", strictLength: false });
  const off = assetVaultLpAccountOffsetP3(assetIndex, g.layout) - ASSET_VAULT_LP_DRAW_LEN_P3;
  if (marketData.length < off + ASSET_VAULT_LP_DRAW_LEN_P3) throw new Error(`AssetVaultLpDrawV18: market data too short for asset ${assetIndex}`);
  const v = view(marketData);
  const r = {
    pendingOutEvenAtoms: u128(v, off), pendingOutOddAtoms: u128(v, off + 16),
    outstandingMirrorAtoms: u128(v, off + 32), pendingMovedAtoms: u128(v, off + 48),
  };
  return { ...r, hasPendingDraw: r.pendingMovedAtoms !== 0n || r.pendingOutEvenAtoms !== 0n || r.pendingOutOddAtoms !== 0n };
}

/** Decoded `AssetVaultLpV18`. */
export interface AssetVaultLpP3 {
  /** null when no vault LP is bound on this asset. */
  vaultLpPortfolio: PublicKey | null;
  /** Vault LP signed position snapshot (engine Q); traders' net = −lpNetQ. */
  lpNetQ: bigint;
  levCapQ: bigint;
  lpNetSlot: bigint;
  skewSlopeE9: bigint;
  skewMaxE9: bigint;
  levMaxImrBps: number;
  flags: number;
  bound: boolean;
  /**
   * P2b `p2b_flags` (record byte 91, formerly a zero `_reserved0`). Bit 0: creator fees are not
   * vested (the G6 junior cushion is below its target), so tag 90 returns 102 while Live.
   */
  p2bFlags: number;
  /** `p2bFlags` bit 0: creator discretionary fees are locked until the cushion reaches its target. */
  creatorFeeVesting: boolean;
  /** Raw stored value; 0 means the 1x default. */
  vaultLpMaxLevBps: number;
  /** null = no matcher approved yet. */
  approvedMatcherProgram: PublicKey | null;
}

/**
 * Decode one 128-byte `AssetVaultLpV18` record (mirrors `validate_asset_vault_lp`).
 *
 * @param rec  The 128 bytes.
 * @returns Decoded record.
 * @throws On unknown flag bits (`flags` other than bound; `p2b_flags` other than bit 0), out-of-range caps, or bound ≠ (portfolio ≠ 0).
 * @example
 * ```ts
 * const r = decodeAssetVaultLpRecordP3(bytes);
 * ```
 */
export function decodeAssetVaultLpRecordP3(rec: Uint8Array): AssetVaultLpP3 {
  if (rec.length !== ASSET_VAULT_LP_LEN_P3) throw new Error(`AssetVaultLpV18 record must be 128 bytes, got ${rec.length}`);
  const v = view(rec);
  const F = ASSET_VAULT_LP_FIELD_OFF_P3;
  const zero32 = (o: number): boolean => rec.subarray(o, o + 32).every((b) => b === 0);
  const flags = rec[F.flags];
  const bound = (flags & ASSET_VAULT_LP_FLAG_BOUND_P3) !== 0;
  const out: AssetVaultLpP3 = {
    vaultLpPortfolio: zero32(F.vaultLpPortfolio) ? null : key(rec, F.vaultLpPortfolio),
    lpNetQ: i128(v, F.lpNetQ), levCapQ: u128(v, F.levCapQ), lpNetSlot: v.getBigUint64(F.lpNetSlot, true),
    skewSlopeE9: v.getBigUint64(F.skewSlopeE9, true), skewMaxE9: v.getBigUint64(F.skewMaxE9, true),
    levMaxImrBps: v.getUint16(F.levMaxImrBps, true), flags, bound,
    p2bFlags: rec[ASSET_VAULT_LP_P2B_FLAGS_OFF_P3], creatorFeeVesting: (rec[ASSET_VAULT_LP_P2B_FLAGS_OFF_P3] & 1) !== 0,
    vaultLpMaxLevBps: v.getUint32(F.vaultLpMaxLevBps, true),
    approvedMatcherProgram: zero32(F.approvedMatcherProgram) ? null : key(rec, F.approvedMatcherProgram),
  };
  if ((flags & ~ASSET_VAULT_LP_FLAG_BOUND_P3) !== 0 || (rec[ASSET_VAULT_LP_P2B_FLAGS_OFF_P3] & ~1) !== 0 || out.vaultLpMaxLevBps > 50_000 ||
    out.levMaxImrBps > 10_000 || bound !== (out.vaultLpPortfolio !== null)) {
    throw new Error("AssetVaultLpV18: invalid record — the program would reject it too");
  }
  return out;
}

/**
 * Decode asset `assetIndex`'s `AssetVaultLpV18` from a raw market account (kind 1).
 *
 * @param marketData  Raw market account bytes.
 * @param assetIndex  Asset slot.
 * @returns Decoded record (all-zero on a market without P3 state).
 * @example
 * ```ts
 * const r = decodeAssetVaultLpP3(marketInfo.data, 0);
 * if (r.bound) console.log(r.vaultLpPortfolio?.toBase58());
 * ```
 */
export function decodeAssetVaultLpP3(marketData: Uint8Array, assetIndex: number): AssetVaultLpP3 {
  const g = resolveMarketGeometry(marketData, { parser: "decodeAssetVaultLpP3", strictLength: false });
  const off = assetVaultLpAccountOffsetP3(assetIndex, g.layout);
  if (marketData.length < off + ASSET_VAULT_LP_LEN_P3) throw new Error(`market account too short for asset ${assetIndex}`);
  return decodeAssetVaultLpRecordP3(marketData.subarray(off, off + ASSET_VAULT_LP_LEN_P3));
}

/**
 * True if an LP-vault registry account has its "vault LP bound" flag set (`_reserved[0] == 1`).
 * While bound, tags 75/77/78 REQUIRE the vault-LP tail ({@link withBoundVaultLpTailP3}).
 *
 * @param registryData  Raw LpVaultRegistry account bytes.
 * @returns Whether a vault LP is bound.
 * @throws If the flag byte is neither 0 nor 1.
 * @example
 * ```ts
 * if (isLpVaultRegistryBoundP3(reg.data)) ix = withBoundVaultLpTailP3(ix, ...);
 * ```
 */
export function isLpVaultRegistryBoundP3(registryData: Uint8Array): boolean {
  const b = registryData[LP_VAULT_REGISTRY_BOUND_FLAG_OFF_P3];
  if (b !== 0 && b !== 1) throw new Error(`registry bound flag must be 0|1, got ${b}`);
  return b === 1;
}

// ============================================================================
// PDAs
// ============================================================================

/**
 * `["vault_lp", market]` under the wrapper.
 * @param programId  Wrapper program id.
 * @param market     Market account.
 * @returns [pda, bump].
 * @example
 * ```ts
 * const [vaultLpState] = deriveVaultLpStateP3(WRAPPER, market);
 * ```
 */
export function deriveVaultLpStateP3(programId: PublicKey, market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([new TextEncoder().encode("vault_lp"), market.toBytes()], programId);
}

/** BPF upgradeable loader id. */
export const BPF_LOADER_UPGRADEABLE_ID_P3 = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

/**
 * The wrapper's ProgramData account (`[program_id]` under the upgradeable loader) — required by
 * the upgrade-authority tags 95 and 99.
 * @param programId  Wrapper program id.
 * @returns [programData, bump].
 * @example
 * ```ts
 * const [programData] = deriveProgramDataAddressP3(WRAPPER);
 * ```
 */
export function deriveProgramDataAddressP3(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([programId.toBytes()], BPF_LOADER_UPGRADEABLE_ID_P3);
}

/** Own + sibling backing-ledger PDAs for a registry domain (`sibling = domain ^ 1`). */
function ledgers(programId: PublicKey, market: PublicKey, registryDomain: number): { ledger: PublicKey; siblingLedger: PublicKey } {
  return {
    ledger: deriveLpBackingLedger(programId, market, registryDomain)[0],
    siblingLedger: deriveLpBackingLedger(programId, market, registryDomain ^ 1)[0],
  };
}

function ix(programId: PublicKey, spec: readonly AccountSpec[], keys: Record<string, PublicKey>, data: Uint8Array, extra: AccountMeta[] = []): TransactionInstruction {
  return new TransactionInstruction({ programId, keys: [...buildAccountMetas(spec, keys), ...extra], data: Buffer.from(data) });
}

// ============================================================================
// Instruction builders (tags 94..=102)
// ============================================================================

/** Common market context for P3 builders. */
export interface VaultLpMarketP3 {
  programId: PublicKey;
  market: PublicKey;
  /** `LpVaultRegistryV16.domain` — selects which backing ledger is "own". */
  registryDomain: number;
  /** The vault-owned LP portfolio. */
  lpPortfolio: PublicKey;
  /**
   * P2b (percolator-prog #526): the market's `VaultLpExtV19` PDA (`["vault_lp_ext", market]`,
   * {@link deriveVaultLpExtP2b}). Set it once the registry's ext flag is raised
   * ({@link isLpVaultRegistryExtP2b}); from then on tags 98 (`[8]`) and 97 (`[11]`) REQUIRE it and
   * bound 78 requires `[7]` ext + `[8]` LP (fail closed). Leave unset on a pre-P2b program or before
   * any tag 103 / dials call created the ext: an extra account there is harmless but a missing
   * one fails.
   */
  vaultLpExt?: PublicKey;
}

/** Matcher context size a tag-94 auto-pin needs (`MATCHER_CONTEXT_LEN`). */
export const VAULT_LP_MATCHER_CTX_LEN_P3 = 320;

/**
 * Pre-create the matcher context tag 94 auto-pins: `SystemProgram.createAccount` of 320 zeroed
 * bytes owned by the matcher program. `matcherCtx` must be a fresh keypair and SIGN this
 * transaction. Send before (or in the same transaction as) {@link buildInitVaultLpIxP3}.
 *
 * @param payer           Funds the rent.
 * @param matcherCtx      New account address (fresh keypair's public key).
 * @param lamports        Rent-exempt minimum for 320 bytes (`getMinimumBalanceForRentExemption(320)`).
 * @param matcherProgram  Owner (default: the devnet v2.1 canonical matcher DfTxJUT5…; pass PROGRAM_IDS_DEVNET_V1.matcher for a v1 market).
 * @returns SystemProgram createAccount instruction.
 * @example
 * ```ts
 * const ctx = Keypair.generate();
 * const lamports = await connection.getMinimumBalanceForRentExemption(VAULT_LP_MATCHER_CTX_LEN_P3);
 * const ixs = [buildCreateVaultLpMatcherCtxIxP3(payer, ctx.publicKey, lamports), buildInitVaultLpIxP3(m, marketauth, 2_000, ctx.publicKey)];
 * ```
 */
export function buildCreateVaultLpMatcherCtxIxP3(
  payer: PublicKey, matcherCtx: PublicKey, lamports: number,
  matcherProgram: PublicKey = new PublicKey(CANONICAL_VAULT_LP_MATCHER_PROGRAM_DEVNET_P3),
): TransactionInstruction {
  return SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: matcherCtx, lamports, space: VAULT_LP_MATCHER_CTX_LEN_P3, programId: matcherProgram });
}

/**
 * Tag 94 InitVaultLp (P3 FINAL `58e379f1`), marketauth only: the marketauth signs and becomes the
 * junior owner. SINGLE-ASSET markets only: create the market with `maxPortfolioAssets: 1`
 * (`max_market_slots == 1`), otherwise 86 VaultLpMultiAssetMarket. Auto-pins the vault LP to the canonical matcher: pass the pre-created `matcherCtx`
 * ({@link buildCreateVaultLpMatcherCtxIxP3}); the delegate PDA is derived with the REGISTRY as
 * the LP owner. On a stake-bound market the marketauth is the keyless stake-pool PDA, so bind
 * the vault LP before InitPool rotates it.
 *
 * @param m               Market context.
 * @param marketauth      The market's marketauth (signer; becomes the junior owner).
 * @param juniorFloorBps  1000..=10000.
 * @param matcherCtx      Pre-created 320-byte ctx owned by the matcher program (writable).
 * @param matcherProgram  Must be the canonical matcher (default: devnet v2.1 DfTxJUT5…; PROGRAM_IDS_DEVNET_V1.matcher for a v1 market).
 * @returns Instruction (11 accounts).
 * @example
 * ```ts
 * const ix = buildInitVaultLpIxP3({ programId, market, registryDomain: 0, lpPortfolio }, marketauth, 2_000);
 * ```
 */
export function buildInitVaultLpIxP3(
  m: VaultLpMarketP3, marketauth: PublicKey, juniorFloorBps: number, matcherCtx: PublicKey,
  matcherProgram: PublicKey = new PublicKey(CANONICAL_VAULT_LP_MATCHER_PROGRAM_DEVNET_P3),
): TransactionInstruction {
  const [registry] = deriveLpVaultRegistry(m.programId, m.market);
  const [matcherDelegate] = deriveMatcherDelegate(m.programId, m.market, m.lpPortfolio, registry, matcherProgram, matcherCtx);
  return ix(m.programId, ACCOUNTS_INIT_VAULT_LP_P3, {
    authority: marketauth, market: m.market, registry,
    vaultLpState: deriveVaultLpStateP3(m.programId, m.market)[0], lpPortfolio: m.lpPortfolio,
    systemProgram: SystemProgram.programId, ...ledgers(m.programId, m.market, m.registryDomain),
    matcherProgram, matcherCtx, matcherDelegate,
  }, encodeInitVaultLpP3(juniorFloorBps));
}

/**
 * Tag 95 VaultLpSetMatcher (upgrade authority). The delegate is derived with the REGISTRY
 * as the LP owner, exactly as the handler does.
 *
 * @param m                 Market context.
 * @param upgradeAuthority  Wrapper upgrade authority (signer).
 * @param matcherProgram    Must equal the tag-99 approved matcher for the asset.
 * @param matcherCtx        Matcher context account (writable).
 * @param args              Wire fields.
 * @returns Instruction.
 * @example
 * ```ts
 * const ix = buildVaultLpSetMatcherIxP3(m, upgradeAuthority, MATCHER, ctx, args);
 * ```
 */
export function buildVaultLpSetMatcherIxP3(
  m: VaultLpMarketP3, upgradeAuthority: PublicKey, matcherProgram: PublicKey, matcherCtx: PublicKey, args: VaultLpSetMatcherArgsP3,
): TransactionInstruction {
  const [registry] = deriveLpVaultRegistry(m.programId, m.market);
  const [matcherDelegate] = deriveMatcherDelegate(m.programId, m.market, m.lpPortfolio, registry, matcherProgram, matcherCtx);
  return ix(m.programId, ACCOUNTS_VAULT_LP_SET_MATCHER_P3, {
    upgradeAuthority, programData: deriveProgramDataAddressP3(m.programId)[0], market: m.market,
    vaultLpState: deriveVaultLpStateP3(m.programId, m.market)[0], lpPortfolio: m.lpPortfolio,
    matcherProgram, matcherCtx, matcherDelegate,
  }, encodeVaultLpSetMatcherP3(args));
}

/**
 * Tag 96 DepositJuniorTranche (junior owner).
 * @param m            Market context.
 * @param juniorOwner  Signer.
 * @param sourceToken  Junior's collateral token account.
 * @param vaultToken   Market collateral vault.
 * @param amount       Atoms.
 * @returns Instruction.
 * @example
 * ```ts
 * buildDepositJuniorTrancheIxP3(m, junior, juniorAta, vault, 1_000_000n);
 * ```
 */
export function buildDepositJuniorTrancheIxP3(m: VaultLpMarketP3, juniorOwner: PublicKey, sourceToken: PublicKey, vaultToken: PublicKey, amount: bigint): TransactionInstruction {
  return ix(m.programId, ACCOUNTS_DEPOSIT_JUNIOR_TRANCHE_P3, {
    juniorOwner, market: m.market, vaultLpState: deriveVaultLpStateP3(m.programId, m.market)[0], lpPortfolio: m.lpPortfolio,
    sourceToken, vaultToken, tokenProgram: TOKEN_PROGRAM_ID,
  }, encodeDepositJuniorTrancheP3(amount));
}

/**
 * Tag 97 WithdrawJuniorTranche (junior owner). `destToken` must be owned by the junior.
 * Refused with 89 VaultLpPausedForSeniorDraw while a senior draw is pending/outstanding (`4b1a5d30`).
 * @param m            Market context.
 * @param juniorOwner  Signer.
 * @param destToken    Junior's collateral token account.
 * @param vaultToken   Market collateral vault.
 * @param amount       Atoms.
 * @returns Instruction.
 * @example
 * ```ts
 * buildWithdrawJuniorTrancheIxP3(m, junior, juniorAta, vault, 500_000n);
 * ```
 */
export function buildWithdrawJuniorTrancheIxP3(m: VaultLpMarketP3, juniorOwner: PublicKey, destToken: PublicKey, vaultToken: PublicKey, amount: bigint): TransactionInstruction {
  return ix(m.programId, ACCOUNTS_WITHDRAW_JUNIOR_TRANCHE_P3, {
    juniorOwner, market: m.market, registry: deriveLpVaultRegistry(m.programId, m.market)[0],
    vaultLpState: deriveVaultLpStateP3(m.programId, m.market)[0], lpPortfolio: m.lpPortfolio,
    ...ledgers(m.programId, m.market, m.registryDomain), destToken, vaultToken,
    vaultAuthority: deriveVaultAuthority(m.programId, m.market)[0], tokenProgram: TOKEN_PROGRAM_ID,
  }, encodeWithdrawJuniorTrancheP3(amount), m.vaultLpExt ? [{ pubkey: m.vaultLpExt, isSigner: false, isWritable: true }] : []);
}

/**
 * Tag 98 VaultLpRecall (permissionless). Needed before a bound redemption when the value sits
 * in the LP: a Live 75/77 otherwise fails 88 VaultLpRedeemNeedsRecall (`d119eebd`).
 * `39b138c8` (D-P3-30) / `4b1a5d30`: `amount` is capped at `min(recall_limit, max(vault LP
 * POST-maintenance-fee certified equity, 0))` (above the cap: VaultLpRecallRefused); while a senior
 * draw is pending or outstanding the recall is refused with 89 VaultLpPausedForSeniorDraw (see
 * {@link decodeAssetVaultLpDrawP3}). The vault LP must be flat.
 * @param m             Market context.
 * @param cranker       Signer (pays rent if the target ledger is created).
 * @param amount        Atoms.
 * @param targetDomain  Receiving backing domain.
 * @returns Instruction.
 * @example
 * ```ts
 * buildVaultLpRecallIxP3(m, keeper, shortfall, m.registryDomain);
 * ```
 */
export function buildVaultLpRecallIxP3(m: VaultLpMarketP3, cranker: PublicKey, amount: bigint, targetDomain: number): TransactionInstruction {
  return ix(m.programId, ACCOUNTS_VAULT_LP_RECALL_P3, {
    cranker, market: m.market, registry: deriveLpVaultRegistry(m.programId, m.market)[0],
    vaultLpState: deriveVaultLpStateP3(m.programId, m.market)[0], lpPortfolio: m.lpPortfolio,
    ...ledgers(m.programId, m.market, m.registryDomain), systemProgram: SystemProgram.programId,
  }, encodeVaultLpRecallP3(amount, targetDomain), m.vaultLpExt ? [{ pubkey: m.vaultLpExt, isSigner: false, isWritable: true }] : []);
}

/**
 * Tag 99 SetVaultLpRisk (upgrade authority).
 * @param programId         Wrapper program id.
 * @param market            Market account.
 * @param upgradeAuthority  Signer.
 * @param args              Wire fields.
 * @returns Instruction.
 * @example
 * ```ts
 * buildSetVaultLpRiskIxP3(WRAPPER, market, upgradeAuthority, { assetIndex: 0, ... });
 * ```
 */
export function buildSetVaultLpRiskIxP3(programId: PublicKey, market: PublicKey, upgradeAuthority: PublicKey, args: SetVaultLpRiskArgsP3): TransactionInstruction {
  return ix(programId, ACCOUNTS_SET_VAULT_LP_RISK_P3, {
    upgradeAuthority, programData: deriveProgramDataAddressP3(programId)[0], market,
  }, encodeSetVaultLpRiskP3(args));
}

/**
 * Tag 100 VaultLpConvertPnl (permissionless).
 * @param m       Market context.
 * @param caller  Signer.
 * @param amount  Atoms.
 * @returns Instruction.
 * @example
 * ```ts
 * buildVaultLpConvertPnlIxP3(m, keeper, 1n);
 * ```
 */
export function buildVaultLpConvertPnlIxP3(m: VaultLpMarketP3, caller: PublicKey, amount: bigint): TransactionInstruction {
  return ix(m.programId, ACCOUNTS_VAULT_LP_CONVERT_PNL_P3, {
    caller, market: m.market, vaultLpState: deriveVaultLpStateP3(m.programId, m.market)[0], lpPortfolio: m.lpPortfolio,
  }, encodeVaultLpConvertPnlP3(amount));
}

/**
 * Tag 101 VaultLpSettleResolved (permissionless, Resolved). Replaces tags 30/46 for the vault LP.
 * Compute: set ≥ {@link RECOMMENDED_CU_P3}`.vaultLpSettleResolved` (400k; measured worst 285k). The
 * close step can be ProgressOnly several times while a large residual is chunked: repeat it until
 * the vault LP can be closed (tag 8).
 * P3 FINAL (`58e379f1`): moves NO SPL — the payout goes into the vault's own backing pot. The
 * `juniorDestToken` / `vaultToken` accounts are still required and validated. Exit order after
 * settlement: {@link planResolvedVaultLpExitP3} (78 → 77 per senior → 102 junior).
 * @param m                Market context.
 * @param caller           Signer.
 * @param juniorDestToken  Junior owner's collateral token account.
 * @param vaultToken       Market collateral vault.
 * @param topup            0 = close step, 1 = topup claim.
 * @returns Instruction.
 * @example
 * ```ts
 * buildVaultLpSettleResolvedIxP3(m, keeper, juniorAta, vault, 0);
 * ```
 */
export function buildVaultLpSettleResolvedIxP3(m: VaultLpMarketP3, caller: PublicKey, juniorDestToken: PublicKey, vaultToken: PublicKey, topup: 0 | 1): TransactionInstruction {
  return ix(m.programId, ACCOUNTS_VAULT_LP_SETTLE_RESOLVED_P3, {
    caller, market: m.market, registry: deriveLpVaultRegistry(m.programId, m.market)[0],
    vaultLpState: deriveVaultLpStateP3(m.programId, m.market)[0], lpPortfolio: m.lpPortfolio,
    ...ledgers(m.programId, m.market, m.registryDomain), juniorDestToken, vaultToken,
    vaultAuthority: deriveVaultAuthority(m.programId, m.market)[0], tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  }, encodeVaultLpSettleResolvedP3(topup));
}

/**
 * Tag 102 VaultLpReleaseSurplus (junior owner). Pass `resolved` for the Resolved-mode SPL payout tail.
 * Refused with 89 VaultLpPausedForSeniorDraw while a senior draw is outstanding (`4b1a5d30`);
 * Resolved: request at most physical − C (C keeps ≈1,005 atoms of dead-share dust), else 83.
 * @param m             Market context.
 * @param juniorOwner   Signer.
 * @param amount        Atoms.
 * @param sourceDomain  Backing domain.
 * @param resolved      Resolved-mode tail: junior dest token + market vault token.
 * @returns Instruction.
 * @example
 * ```ts
 * buildVaultLpReleaseSurplusIxP3(m, junior, 10n, 0);
 * ```
 */
export function buildVaultLpReleaseSurplusIxP3(
  m: VaultLpMarketP3, juniorOwner: PublicKey, amount: bigint, sourceDomain: number,
  resolved?: { juniorDestToken: PublicKey; vaultToken: PublicKey },
): TransactionInstruction {
  const extra = resolved
    ? buildAccountMetas(ACCOUNTS_VAULT_LP_RELEASE_SURPLUS_RESOLVED_TAIL_P3, {
      juniorDestToken: resolved.juniorDestToken, vaultToken: resolved.vaultToken,
      vaultAuthority: deriveVaultAuthority(m.programId, m.market)[0], tokenProgram: TOKEN_PROGRAM_ID,
    })
    : [];
  return ix(m.programId, ACCOUNTS_VAULT_LP_RELEASE_SURPLUS_P3, {
    juniorOwner, market: m.market, registry: deriveLpVaultRegistry(m.programId, m.market)[0],
    vaultLpState: deriveVaultLpStateP3(m.programId, m.market)[0], lpPortfolio: m.lpPortfolio,
    ...ledgers(m.programId, m.market, m.registryDomain),
  }, encodeVaultLpReleaseSurplusP3(amount, sourceDomain), extra);
}

// ============================================================================
// Bound-vault tail for Earn tags 75 / 77 / 78
// ============================================================================

/** Base account count each Earn tag must have before the P3 tail (tail index = this). */
export const BOUND_VAULT_LP_TAIL_INDEX_P3 = Object.freeze({ 75: 11, 77: 13, 78: 6 } as const);

/**
 * Base-account slots of the two pot ledgers (own, sibling) per Earn tag. From percolator-prog
 * `d119eebd`, a pending senior draw is booked into BOTH pot ledgers before any instruction that
 * prices off C, so {@link withBoundVaultLpTailP3} forces these slots writable.
 */
export const BOUND_VAULT_LP_LEDGER_SLOTS_P3 = Object.freeze({ 75: [7, 10], 77: [8, 11], 78: [3, 4] } as const);

/** Options for {@link withBoundVaultLpTailP3}. */
export interface BoundVaultLpTailOptsP3 {
  /**
   * Pass the 75/77 vault-LP tail account READ-ONLY. Default `false` (writable): on a Live market
   * a writable vault LP lets the program run the senior draw in the same instruction; a
   * read-only one with an undrawn deficit is refused with 87 VaultLpSeniorDrawRequired.
   * Ignored for tag 78 (no LP in its tail).
   */
  lpReadOnly?: boolean;
  /**
   * P2b (percolator-prog #526): the market's `VaultLpExtV19` ({@link deriveVaultLpExtP2b}). For tag 78
   * on a market whose registry ext flag is set, the tail becomes `[6] vault_lp_state, [7] ext (w),
   * [8] vault LP portfolio (w)`; without it a pre-P2b keeper's 78 fails (fail closed) and bound 77
   * needs a prior harvest, so every redemption would break. The program reads `[8]` only while the
   * G6 cushion is on and the market is Live; sending it always is harmless. Ignored for 75 / 77
   * (the ext does not govern them).
   */
  vaultLpExt?: PublicKey;
}

/**
 * Append the REQUIRED bound-vault tail to an Earn instruction (fail closed on a bound vault):
 * 75 DepositToLpVault → [11] vault_lp_state (w), [12] vault LP portfolio (w);
 * 77 ExecuteRedemption → [13] vault_lp_state (w), [14] vault LP portfolio (w);
 * 78 LpVaultCrankFees → [6] vault_lp_state (w) (+ [7] ext (w), [8] vault LP (w) once the P2b ext exists, see {@link BoundVaultLpTailOptsP3.vaultLpExt}).
 * The pot-ledger slots ({@link BOUND_VAULT_LP_LEDGER_SLOTS_P3}) are forced writable.
 *
 * P3 senior draw FINAL (`d119eebd`): the vault LP is WRITABLE by default so a Live 75/77 can run
 * the draw itself (otherwise 87 VaultLpSeniorDrawRequired); a pending draw is booked into both
 * pot ledgers (read-only ones fail closed). A 77 that needs value held in the vault LP's capital
 * returns 88 VaultLpRedeemNeedsRecall: send VaultLpRecall (98) first.
 * Tag 76 (RequestRedeemLpShares) takes no tail on P3.
 *
 * P3 FINAL (`58e379f1`), no wire change: in Resolved mode the tag-77 [14] vault LP is only
 * KEY-pinned (it may already be settled, closed and garbage-collected, so it is not required to
 * be wrapper-owned); tag 78 is additionally allowed in Resolved mode once the market is
 * terminal-flat (no materialized portfolio, c_tot == 0) — the [6] tail is still required.
 *
 * @param base         The unbound-form instruction (tag + exact base account count checked).
 * @param vaultLpState `["vault_lp", market]`.
 * @param lpPortfolio  The vault-owned LP portfolio (ignored for tag 78).
 * @param opts         {@link BoundVaultLpTailOptsP3} (default: vault LP writable).
 * @returns A new instruction with the tail appended.
 * @throws If the tag is not 75/77/78 or the base account count is wrong.
 * @example
 * ```ts
 * const ix = withBoundVaultLpTailP3(depositIx, vaultLpState, lpPortfolio);
 * ```
 */
export function withBoundVaultLpTailP3(
  base: TransactionInstruction, vaultLpState: PublicKey, lpPortfolio: PublicKey, opts: BoundVaultLpTailOptsP3 = {},
): TransactionInstruction {
  const tag = base.data[0];
  if (tag !== 75 && tag !== 77 && tag !== 78) throw new Error(`withBoundVaultLpTailP3: tag ${tag} takes no vault-LP tail (only 75/77/78)`);
  const want = BOUND_VAULT_LP_TAIL_INDEX_P3[tag];
  if (base.keys.length !== want) throw new Error(`withBoundVaultLpTailP3: tag ${tag} must have exactly ${want} base accounts, got ${base.keys.length}`);
  // d119eebd senior draw: both pot ledgers must be writable whenever a draw is pending
  // (fail-closed otherwise), so force them writable regardless of how the base was built.
  const ledgerSlots: readonly number[] = BOUND_VAULT_LP_LEDGER_SLOTS_P3[tag];
  const keys: AccountMeta[] = base.keys.map((k, i) => (ledgerSlots.includes(i) ? { ...k, isWritable: true } : k));
  keys.push({ pubkey: vaultLpState, isSigner: false, isWritable: true });
  if (tag !== 78) keys.push({ pubkey: lpPortfolio, isSigner: false, isWritable: opts.lpReadOnly !== true });
  else if (opts.vaultLpExt) {
    keys.push({ pubkey: opts.vaultLpExt, isSigner: false, isWritable: true });
    keys.push({ pubkey: lpPortfolio, isSigner: false, isWritable: true });
  }
  return new TransactionInstruction({ programId: base.programId, keys, data: base.data });
}

/**
 * Tag 77 ExecuteRedemption on a BOUND (P3) vault, fully assembled: 13 base accounts + the bound
 * tail. Security condition on `221cf006`: BOTH pot ledgers are ALWAYS writable ([8] registry-domain
 * ledger, [11] sibling). The program tops the chosen pot up from its sibling in the same
 * instruction only when both are writable; with a read-only one the top-up is skipped and a senior
 * larger than one pot gets 88 (Live) / 21 (Resolved) instead of exiting. The vault LP [14] is
 * writable too (a Live 77 runs the senior draw first; in Resolved it is only key-pinned).
 *
 * Accounts: 0 cranker [s,w] · 1 market [w] · 2 registry [w] · 3 redemption [w]
 * (`["lp_redemption", registry, redeemer]`) · 4 LP mint [w] · 5 escrow [w] · 6 market vault token [w]
 * · 7 vault authority · 8 own ledger [w] · 9 redeemer collateral ATA [w] · 10 token program ·
 * 11 sibling ledger [w] · 12 redeemer (rent destination) [w] · 13 vault_lp_state [w] · 14 vault LP [w].
 *
 * @param m             Market context (`registryDomain` picks the own ledger).
 * @param cranker       Signer (anyone; the payout always goes to the redeemer).
 * @param redeemer      The redemption's owner (`redemption.redeemer`).
 * @param redeemerDest  Redeemer's collateral token account (must be owned by the redeemer).
 * @param vaultToken    Market collateral vault token account.
 * @param sourceDomain  Pot to redeem from (the program tops it up from the sibling when short).
 * @param opts          `redeemerSigns`: mark `[12]` a signer. NOT required on a bound vault (the program
 *                      only demands it on a Live NON-bound one, see {@link buildExecuteRedemptionIxNonBoundP2b});
 *                      default false.
 * @returns Instruction.
 * @example
 * ```ts
 * const ix = buildExecuteRedemptionIxP3(m, keeper, senior, seniorAta, vaultAta, m.registryDomain);
 * ```
 */
export function buildExecuteRedemptionIxP3(
  m: VaultLpMarketP3, cranker: PublicKey, redeemer: PublicKey, redeemerDest: PublicKey, vaultToken: PublicKey, sourceDomain: number,
  opts: { redeemerSigns?: boolean } = {},
): TransactionInstruction {
  const [registry] = deriveLpVaultRegistry(m.programId, m.market);
  const { ledger, siblingLedger } = ledgers(m.programId, m.market, m.registryDomain);
  const w = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
  const r = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
  const base = new TransactionInstruction({
    programId: m.programId,
    data: Buffer.from(encodeExecuteRedemption({ domain: sourceDomain })),
    keys: [
      w(cranker, true), w(m.market), w(registry), w(deriveLpRedemption(m.programId, registry, redeemer)[0]),
      w(deriveInsuranceLpMint(m.programId, m.market)[0]), w(deriveLpEscrow(m.programId, m.market)[0]), w(vaultToken),
      r(deriveVaultAuthority(m.programId, m.market)[0]), w(ledger), w(redeemerDest), r(TOKEN_PROGRAM_ID),
      w(siblingLedger), w(redeemer, opts.redeemerSigns === true),
    ],
  });
  return withBoundVaultLpTailP3(base, deriveVaultLpStateP3(m.programId, m.market)[0], m.lpPortfolio);
}

// ============================================================================
// Vault-LP refresh crank (tag 5 on the vault LP portfolio)
// ============================================================================

/** Inputs for {@link buildVaultLpRefreshCrankIxP3}. */
export interface VaultLpRefreshCrankArgsP3 {
  programId: PublicKey;
  cranker: PublicKey;
  market: PublicKey;
  vaultLpPortfolio: PublicKey;
  nowSlot: bigint;
  /** One hint per asset whose oracle accounts follow, in order. */
  observations: CrankObservationHint[];
  /** Read-only oracle accounts, in the order the observations describe. */
  oracleAccounts: PublicKey[];
}

/**
 * The vault-LP refresh crank: a permissionless tag-5 crank whose portfolio is the vault LP.
 * On P3 it refreshes the vault LP's health cert (clears VaultLpValuationStale, error 85, for
 * a following Earn 75/77) and re-snapshots `AssetVaultLpV18.lp_net_q` for skew funding
 * (`vault_lp_refresh_snapshot`). Prepend it in the same transaction.
 *
 * @param a  Crank inputs.
 * @returns Instruction.
 * @example
 * ```ts
 * const crank = buildVaultLpRefreshCrankIxP3({ programId, cranker, market, vaultLpPortfolio, nowSlot, observations: [{ assetIndex: 0, oracleAccounts: 0 }], oracleAccounts: [] });
 * ```
 */
export function buildVaultLpRefreshCrankIxP3(a: VaultLpRefreshCrankArgsP3): TransactionInstruction {
  const want = a.observations.reduce((s, o) => s + o.oracleAccounts, 0);
  if (want !== a.oracleAccounts.length) throw new Error(`observations name ${want} oracle accounts, got ${a.oracleAccounts.length}`);
  return new TransactionInstruction({
    programId: a.programId,
    keys: [
      { pubkey: a.cranker, isSigner: true, isWritable: true },
      { pubkey: a.market, isSigner: false, isWritable: true },
      { pubkey: a.vaultLpPortfolio, isSigner: false, isWritable: true },
      ...a.oracleAccounts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
    ],
    data: Buffer.from(encodePermissionlessCrank({ nowSlot: a.nowSlot, observations: a.observations })),
  });
}

// ============================================================================
// Bound-vault NAV (floored) + senior share pricing — ports of P3 FINAL `58e379f1`
// (`lp_vault_domain_nav_terms`, `lp_vault_combined_nav_parts_p3`, `vault_owned_backing_atoms`,
// `vault_lp_v18::{tranche_split, effective_senior_claim, senior_shares_for_deposit,
// senior_atoms_for_redemption}`, and the tag-75 / tag-77 bound pricing)
// ============================================================================

/** Engine `BOUND_SCALE` (backing `_num` fields are in 1e-12 atoms). */
const BOUND_SCALE_P3 = 1_000_000_000_000n;
/** `LP_VAULT_MINIMUM_LIQUIDITY` dead shares burned from the genesis deposit. */
export const LP_VAULT_MINIMUM_LIQUIDITY_P3 = 1_000n;

/** One backing pot's synced ledger counters (read the ledger AFTER a sync, i.e. as the program sees them). */
export interface BackingPotTermsP3 {
  totalPrincipalAtoms: bigint;
  totalEarningsAtoms: bigint;
  totalEarningsWithdrawnAtoms: bigint;
  cumulativeLossAtoms: bigint;
  cumulativeRecoveryAtoms: bigint;
}

const sat = (a: bigint, b: bigint): bigint => (a > b ? a - b : 0n);
const minB = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/**
 * `vault_pot_held_atoms` (P3 senior draw FINAL `d119eebd`): backing HELD by one pot =
 * floor((fresh_unliened_backing_num + valid_liened_backing_num) / BOUND_SCALE).
 * @param bucket  The pot's backing-bucket `_num` fields.
 * @returns Held atoms.
 * @example
 * ```ts
 * const held = vaultPotHeldAtomsP3({ freshUnlienedBackingNum: a, validLienedBackingNum: b });
 * ```
 */
export function vaultPotHeldAtomsP3(bucket: { freshUnlienedBackingNum: bigint; validLienedBackingNum: bigint }): bigint {
  return (bucket.freshUnlienedBackingNum + bucket.validLienedBackingNum) / BOUND_SCALE_P3;
}

/**
 * `vault_physical_idle_backing_atoms` (Resolved senior pricing): Σ floor(fresh_unliened_backing_num / BOUND_SCALE)
 * over both buckets (floored per bucket, as the program does).
 * @param freshUnlienedBackingNums  The two buckets' `fresh_unliened_backing_num`.
 * @returns Idle backing atoms.
 * @example
 * ```ts
 * vaultPhysicalIdleBackingAtomsP3([own.freshUnlienedBackingNum, sib.freshUnlienedBackingNum]);
 * ```
 */
export function vaultPhysicalIdleBackingAtomsP3(freshUnlienedBackingNums: bigint[]): bigint {
  return freshUnlienedBackingNums.reduce((t, n) => t + n / BOUND_SCALE_P3, 0n);
}

/**
 * Bound-vault NAV, bit-exact with `lp_vault_combined_nav_parts_p3` / `vault_lp_v18::bound_vault_nav`
 * at percolator-prog `d119eebd` (P3 senior draw / B24): per pot the vault owns
 * `min(principal, held)`, where `held` = {@link vaultPotHeldAtomsP3}. Backing above a pot's
 * principal is the vault LP's settled loss reserved for winners, and backing below it is a real
 * loss. The ledgers' impairment counters are NOT used any more. LP earnings are floored per pot:
 * `floor((earnings − withdrawn)·fee_share_bps / 10000)`, saturating.
 *
 * BREAKING vs the pre-`d119eebd` port: the 4th argument is now the per-pot held backing
 * (`{ own, sibling }`), not one combined owned-backing total.
 *
 * @param own           Own-domain (registry.domain) ledger terms.
 * @param sibling       Sibling-domain (domain ^ 1) ledger terms.
 * @param feeShareBps   `registry.fee_share_bps` (<= 10000).
 * @param held          Held backing per pot ({@link vaultPotHeldAtomsP3} of each bucket).
 * @returns `{ availablePrincipal, lpEarnings, nav }`.
 * @example
 * ```ts
 * const { nav } = boundVaultNavFlooredP3(ownLedger, siblingLedger, registry.feeShareBps,
 *   { own: vaultPotHeldAtomsP3(ownBucket), sibling: vaultPotHeldAtomsP3(siblingBucket) });
 * ```
 */
export function boundVaultNavFlooredP3(
  own: BackingPotTermsP3, sibling: BackingPotTermsP3, feeShareBps: number, held: { own: bigint; sibling: bigint },
): { availablePrincipal: bigint; lpEarnings: bigint; nav: bigint } {
  if (!Number.isInteger(feeShareBps) || feeShareBps < 0 || feeShareBps > 10_000) throw new Error("feeShareBps must be 0..=10000");
  const earn = (p: BackingPotTermsP3): bigint => (sat(p.totalEarningsAtoms, p.totalEarningsWithdrawnAtoms) * BigInt(feeShareBps)) / 10_000n;
  const availablePrincipal = minB(own.totalPrincipalAtoms, held.own) + minB(sibling.totalPrincipalAtoms, held.sibling);
  const lpEarnings = earn(own) + earn(sibling);
  return { availablePrincipal, lpEarnings, nav: availablePrincipal + lpEarnings };
}

/** One active vault-LP leg for {@link vaultLpEquityLagBoundsP3}. */
export interface VaultLpLegPricesP3 {
  /** Signed `basis_pos_q` (positive = long); `|q|` is used (conservative upper bound). */
  basisPosQ: bigint;
  /** The leg's asset `effective_price` ({@link readAssetPricesP3}). */
  effectivePriceE6: bigint;
  /** The leg's asset `raw_oracle_target_price` ({@link readAssetPricesP3}). */
  rawOracleTargetPriceE6: bigint;
}

const ceilDiv = (n: bigint, d: bigint): bigint => (n + d - 1n) / d;

/**
 * `vault_lp_equity_lag_bounds_ro` (percolator-prog `ede691b6`, Earn front-run fix): the vault LP's
 * equity re-valued at the price WORSE for the vault (`worse`, prices a senior EXIT, tag 77) and at
 * the price BETTER for it (`better`, prices a senior ENTRY, tag 75, only while a draw is
 * outstanding), comparing each leg's lagging `effective_price` with the pending
 * `raw_oracle_target_price`. Per active leg, q = |basis_pos_q|, ceil per side:
 *   long:  adverse = ceil(q · max(0, eff − target) / POS_SCALE), favorable = ceil(q · max(0, target − eff) / POS_SCALE)
 *   short: adverse = ceil(q · max(0, target − eff) / POS_SCALE), favorable = ceil(q · max(0, eff − target) / POS_SCALE)
 *   worse = certifiedEquity − Σ adverse; better = certifiedEquity + Σ favorable.
 * A FLAT vault LP (no legs) has no lag: both = `capital + min(pnl,0) + min(fee_credits,0)`, floored at 0.
 * The program requires a CURRENT health certificate for a non-flat LP (else 85); this preview takes
 * the certificate's `certifiedEquity` as given.
 *
 * @param a  `legs` (active legs; empty = flat), `certifiedEquity` (non-flat), and `capital`/`pnl`/`feeCredits` (flat).
 * @returns `{ worse, better }` (signed atoms).
 * @example
 * ```ts
 * const { worse } = vaultLpEquityLagBoundsP3({ legs: [{ basisPosQ: -q, ...readAssetPricesP3(slab, 0) }], certifiedEquity: eq, capital: 0n, pnl: 0n, feeCredits: 0n });
 * ```
 */
export function vaultLpEquityLagBoundsP3(a: {
  legs: VaultLpLegPricesP3[]; certifiedEquity: bigint; capital: bigint; pnl: bigint; feeCredits: bigint;
}): { worse: bigint; better: bigint } {
  if (a.legs.length === 0) {
    const e = a.capital + (a.pnl < 0n ? a.pnl : 0n) + (a.feeCredits < 0n ? a.feeCredits : 0n);
    const eq = e <= 0n ? 0n : e;
    return { worse: eq, better: eq };
  }
  let adverse = 0n;
  let favorable = 0n;
  for (const l of a.legs) {
    const q = l.basisPosQ < 0n ? -l.basisPosQ : l.basisPosQ;
    const up = l.rawOracleTargetPriceE6 > l.effectivePriceE6 ? l.rawOracleTargetPriceE6 - l.effectivePriceE6 : 0n; // target above eff
    const down = l.effectivePriceE6 > l.rawOracleTargetPriceE6 ? l.effectivePriceE6 - l.rawOracleTargetPriceE6 : 0n; // target below eff
    const [adv, fav] = l.basisPosQ >= 0n ? [down, up] : [up, down];
    adverse += ceilDiv(q * adv, POS_SCALE_P3);
    favorable += ceilDiv(q * fav, POS_SCALE_P3);
  }
  return { worse: a.certifiedEquity - adverse, better: a.certifiedEquity + favorable };
}

/**
 * `vault_lp_senior_pricing_claim(c, undrawn, junior_surplus)` = `c − max(0, undrawn − junior_surplus)` (saturating).
 * @param c              Senior claim C.
 * @param undrawn        Deficit not covered yet.
 * @param juniorSurplus  Pot backing above C that absorbs first.
 * @returns Pricing claim.
 * @example
 * ```ts
 * vaultLpSeniorPricingClaimP3(1_000n, 300n, 100n); // 800n
 * ```
 */
export function vaultLpSeniorPricingClaimP3(c: bigint, undrawn: bigint, juniorSurplus: bigint): bigint {
  const loss = undrawn > juniorSurplus ? undrawn - juniorSurplus : 0n;
  return c > loss ? c - loss : 0n;
}

/**
 * Senior value used by tag 77 on a bound vault (floored everywhere):
 * Resolved → `min(physicalIdleBacking, C)`. Live (`592a77e2`, E-1) → {@link liveExitSeniorValueP3}
 * (always at the worse-for-the-vault price; a negative bound cuts both the claim and the value).
 * `lpEquityWorse` = {@link vaultLpEquityLagBoundsP3}`.worse` (ignored when resolved).
 * Live precondition (`d119eebd`): the vault LP has NO undrawn deficit; otherwise the program
 * refuses 75/77 with 87 VaultLpSeniorDrawRequired (pass the vault LP writable, or crank it).
 * @param a  `nav` (floored, {@link boundVaultNavFlooredP3}), `seniorClaim` (C), `lpValue`,
 *           `resolved`, `physicalIdleBacking` (Σ fresh_unliened_backing_num / 1e12, Resolved only),
 *           `lpEquityWorse` (worse-of vault-LP equity; pass 0n when resolved).
 * @returns Senior tranche value (atoms).
 * @example
 * ```ts
 * const senior = boundVaultSeniorValueP3({ nav, seniorClaim: st.seniorClaimAtoms, lpValue, resolved: false, physicalIdleBacking: 0n, lpEquityWorse: worse });
 * ```
 */
export function boundVaultSeniorValueP3(a: { nav: bigint; seniorClaim: bigint; lpValue: bigint; resolved: boolean; physicalIdleBacking: bigint; lpEquityWorse: bigint }): bigint {
  if (a.resolved) return minB(a.physicalIdleBacking, a.seniorClaim);
  return liveExitSeniorValueP3(a.seniorClaim, a.nav, a.lpEquityWorse >= 0n ? a.lpValue : 0n, a.lpEquityWorse);
}

/**
 * `vault_lp_v18::live_exit_senior_value` (percolator-prog `592a77e2`, security fix E-1): the Live 77
 * senior value, ALWAYS at the price worse for the vault (no `nav >= C` shortcut).
 *   worse >= 0: min(nav + min(lpValueAtEff, worse), C)
 *   worse <  0: d = −worse; C' = vaultLpSeniorPricingClaimP3(C, d, max(0, nav − C)); min(max(0, nav − d), C')
 * @param c              Senior claim C (after the 87 undrawn check).
 * @param nav            Floored bound-vault NAV.
 * @param lpValueAtEff   Vault-LP value at effective prices (0 when worse < 0).
 * @param lpEquityWorse  {@link vaultLpEquityLagBoundsP3}`.worse`.
 * @returns Senior value.
 * @example
 * ```ts
 * liveExitSeniorValueP3(1_000_000n, 800_000n, 200_000n, -100_000n); // 700_000n
 * ```
 */
export function liveExitSeniorValueP3(c: bigint, nav: bigint, lpValueAtEff: bigint, lpEquityWorse: bigint): bigint {
  if (lpEquityWorse >= 0n) return minB(nav + minB(lpValueAtEff, lpEquityWorse), c);
  const d = -lpEquityWorse;
  const cP = vaultLpSeniorPricingClaimP3(c, d, nav > c ? nav - c : 0n);
  return minB(nav > d ? nav - d : 0n, cP);
}

/**
 * Tag-77 payout for `shares` on a bound vault: `floor(shares · senior / S)` (null when S == 0 or
 * shares > S — the program fails closed). Requires harvestable == 0 (bundle tag 78 first).
 * @param shares       Shares redeemed.
 * @param totalShares  `registry.total_lp_shares_outstanding` (S).
 * @param seniorValue  {@link boundVaultSeniorValueP3}.
 * @returns Atoms paid, or null.
 * @example
 * ```ts
 * boundVaultRedemptionAtomsP3(1_000n, 10_000n, 5_000n); // 500n
 * ```
 */
export function boundVaultRedemptionAtomsP3(shares: bigint, totalShares: bigint, seniorValue: bigint): bigint | null {
  if (totalShares === 0n || shares > totalShares) return null;
  return (shares * seniorValue) / totalShares;
}

/**
 * Tag-75 deposit quote on a bound vault: `C_eff = C + floor(H · senior_fee_share / 10000)`;
 * refused (VaultLpSeniorImpaired) when `nav + H < C_eff` and `nav + H + lpValue < C_eff`;
 * genesis (S == 0) refused (VaultLpHarvestPending) while H > 0, else 1:1 minus the 1000 dead
 * shares; otherwise `floor(amount · S / C_eff)`.
 * @param a  amount, totalShares (S), seniorClaim (C), harvestable (H), seniorFeeShareBps, nav (floored), lpValue.
 * @returns `{ ok: true, shares, minted, cEff }` or `{ ok: false, error }`.
 * @example
 * ```ts
 * const q = boundVaultDepositQuoteP3({ amount, totalShares, seniorClaim, harvestable, seniorFeeShareBps: 10_000, nav, lpValue });
 * ```
 */
export function boundVaultDepositQuoteP3(a: {
  amount: bigint; totalShares: bigint; seniorClaim: bigint; harvestable: bigint; seniorFeeShareBps: number; nav: bigint; lpValue: bigint;
  /** `VaultLpStateP3.seniorDrawOutstandingAtoms`; when non-zero the entry is priced better-of (ede691b6). */
  seniorDrawOutstandingAtoms: bigint;
  /** {@link vaultLpEquityLagBoundsP3}`.better` (used only while a draw is outstanding). */
  lpEquityBetter: bigint;
}): { ok: true; shares: bigint; minted: bigint; cEff: bigint } | { ok: false; error: "VaultLpHarvestPending" | "VaultLpSeniorImpaired" | "LpVaultDepositBelowMinimumLiquidity" | "LpVaultZeroSharesMinted" | "EngineInvalidConfig" } {
  if (a.totalShares === 0n && a.harvestable !== 0n) return { ok: false, error: "VaultLpHarvestPending" };
  let cEff = a.seniorClaim + (a.harvestable * BigInt(a.seniorFeeShareBps)) / 10_000n;
  const navH = a.nav + a.harvestable;
  if (a.seniorDrawOutstandingAtoms !== 0n) {
    // ede691b6: priced as if the pending target were effective when better for the vault LP — the
    // recovery restores C seniors-first (vault_lp_recover: min(value above C, outstanding)).
    const vBetter = navH + (a.lpEquityBetter > 0n ? a.lpEquityBetter : 0n);
    const above = vBetter > cEff ? vBetter - cEff : 0n;
    cEff += minB(above, a.seniorDrawOutstandingAtoms);
  }
  if (navH < cEff && navH + a.lpValue < cEff) return { ok: false, error: "VaultLpSeniorImpaired" };
  let shares: bigint;
  if (a.totalShares === 0n) shares = a.amount;
  else if (cEff === 0n) return { ok: false, error: "EngineInvalidConfig" }; // senior_shares_for_deposit → None
  else shares = (a.amount * a.totalShares) / cEff;
  if (shares === 0n) return { ok: false, error: "LpVaultZeroSharesMinted" };
  const minted = a.totalShares === 0n ? shares - LP_VAULT_MINIMUM_LIQUIDITY_P3 : shares;
  if (minted <= 0n) return { ok: false, error: "LpVaultDepositBelowMinimumLiquidity" };
  return { ok: true, shares, minted, cEff };
}

// ============================================================================
// Resolved exit planner (P3 FINAL `58e379f1`, F-14: seniors first)
// ============================================================================

/** Inputs for {@link planResolvedVaultLpExitP3}. */
export interface ResolvedVaultLpExitArgsP3 {
  market: VaultLpMarketP3;
  /** Unbound-form tag-78 LpVaultCrankFees instruction (6 accounts; see ACCOUNTS_LP_VAULT_CRANK_FEES). */
  crankFeesIx: TransactionInstruction;
  /** Unbound-form tag-77 ExecuteRedemption instructions, one per senior (13 accounts each). */
  seniorRedemptionIxs: TransactionInstruction[];
  /** Junior release (tag 102, Resolved tail). Omit to plan the seniors only. */
  junior?: { juniorOwner: PublicKey; amount: bigint; sourceDomain: number; juniorDestToken: PublicKey; vaultToken: PublicKey };
}

/**
 * Terminal exit of a bound vault on a Resolved market, in the program's required order:
 *   1. tag 78 LpVaultCrankFees (+[6] vault_lp_state tail) — Resolved + terminal-flat it harvests
 *      the fee leg and absorbs any claim-free residual into the pots (a no-op success otherwise);
 *   2. tag 77 ExecuteRedemption per senior (+[13] state, [14] vault LP tail; [14] is key-pinned
 *      and may be garbage-collected) — each senior should bundle step 1 in the SAME transaction
 *      (77 refuses with 84 VaultLpHarvestPending while fees are harvestable);
 *   3. tag 102 VaultLpReleaseSurplus for the junior, with the Resolved SPL tail — pays the
 *      remainder over C once seniors are out.
 * PRECONDITIONS: market Resolved and terminal-flat — the vault LP settled by tag 101 (moves no SPL
 * on this head) and closed by tag 8, no materialized portfolio, c_tot == 0.
 * Getting there: loop 101 (close step) and every trader's CloseResolved (tag 30) until each
 * portfolio can be closed by tag 8 — both can be ProgressOnly many times (rehearsals: 1,334 steps
 * at a 1-USDC chunk). Compute: 101 ≥ 400k, CloseResolved ≥ 300k, the [78, 77] pair ≥ 120k + the
 * 77 cost ({@link RECOMMENDED_CU_P3}); pass the 77s built by {@link buildExecuteRedemptionIxP3}.
 *
 * @param a  Market context, the unbound 78 / 77 instructions, and the optional junior release.
 * @returns `{ perSeniorTxs, junior }`: one `[78, 77]` instruction pair per senior, then the 102 ix (or null).
 * @example
 * ```ts
 * const plan = planResolvedVaultLpExitP3({ market: m, crankFeesIx, seniorRedemptionIxs, junior });
 * for (const ixs of plan.perSeniorTxs) await send(ixs);
 * if (plan.junior) await send([plan.junior]);
 * ```
 */
export function planResolvedVaultLpExitP3(a: ResolvedVaultLpExitArgsP3): {
  perSeniorTxs: TransactionInstruction[][];
  junior: TransactionInstruction | null;
} {
  const [vaultLpState] = deriveVaultLpStateP3(a.market.programId, a.market.market);
  const crank = withBoundVaultLpTailP3(a.crankFeesIx, vaultLpState, a.market.lpPortfolio, { vaultLpExt: a.market.vaultLpExt });
  const perSeniorTxs = a.seniorRedemptionIxs.map((r) => [crank, withBoundVaultLpTailP3(r, vaultLpState, a.market.lpPortfolio)]);
  const junior = a.junior
    ? buildVaultLpReleaseSurplusIxP3(a.market, a.junior.juniorOwner, a.junior.amount, a.junior.sourceDomain, {
      juniorDestToken: a.junior.juniorDestToken, vaultToken: a.junior.vaultToken,
    })
    : null;
  return { perSeniorTxs, junior };
}

// ============================================================================
// Resolved payout receipts + tag-46 top-up sweep (percolator-prog 5544302a, option B)
// ============================================================================

/** Account offset of `PortfolioAccountV16Account.resolved_payout_receipt` (HEADER_LEN + rustc offset_of; pinned by the parity fixture). */
export const RESOLVED_RECEIPT_ACCOUNT_OFF_P3 = 9369;
/** `size_of::<ResolvedPayoutReceiptV16Account>()`. */
export const RESOLVED_RECEIPT_LEN_P3 = 66;

/** Decoded `ResolvedPayoutReceiptV16Account`. */
export interface ResolvedPayoutReceiptP3 {
  priorBoundContributionNum: bigint;
  liveReleasedFaceAtReceipt: bigint;
  terminalPositiveClaimFace: bigint;
  paidEffective: bigint;
  present: boolean;
  finalized: boolean;
  /** `present && !finalized`: a PARTIAL receipt that a tag-46 top-up finalises. */
  open: boolean;
}

/**
 * Decode a portfolio account's resolved payout receipt.
 * @param portfolioData  Portfolio account data (V17_PORTFOLIO_ACCOUNT_LEN bytes).
 * @returns The receipt.
 * @throws If the account is too short.
 * @example
 * ```ts
 * const r = decodeResolvedPayoutReceiptP3(info.data);
 * if (r.open) console.log("needs a tag-46 top-up");
 * ```
 */
export function decodeResolvedPayoutReceiptP3(portfolioData: Uint8Array): ResolvedPayoutReceiptP3 {
  const L = resolvePortfolioLayout(portfolioData, { parser: "decodeResolvedPayoutReceiptP3" });
  const o = L.portfolio.resolvedPayoutReceiptOff;
  if (portfolioData.length < o + RESOLVED_RECEIPT_LEN_P3) throw new Error(`portfolio data too short for the resolved receipt (${portfolioData.length} B)`);
  const v = new DataView(portfolioData.buffer, portfolioData.byteOffset, portfolioData.byteLength);
  const present = portfolioData[o + 64] !== 0;
  const finalized = portfolioData[o + 65] !== 0;
  return {
    priorBoundContributionNum: u128(v, o), liveReleasedFaceAtReceipt: u128(v, o + 16),
    terminalPositiveClaimFace: u128(v, o + 32), paidEffective: u128(v, o + 48),
    present, finalized, open: present && !finalized,
  };
}

/**
 * Tag 46 ClaimResolvedPayoutTopup. Default = the PERMISSIONLESS form (owner NOT signing, the
 * market's `nft_registry` PDA at [7] as the #497 escrow proof; the payout still goes to the owner's
 * token account). `signed: true` builds the owner-signed 7-account form instead. Data = `[46]`.
 * An NFT-escrowed portfolio (owner = the NFT program's PDA) refuses the unsigned form (ExpectedSigner):
 * its holder must use the signed/holder-auth path.
 * @param a  programId, market, portfolio, owner, destToken (owner's collateral ATA), vaultToken, optional `signed`.
 * @returns Instruction.
 * @example
 * ```ts
 * const ix = buildClaimResolvedPayoutTopupIxP3({ programId: W, market, portfolio, owner, destToken, vaultToken });
 * ```
 */
export function buildClaimResolvedPayoutTopupIxP3(a: {
  programId: PublicKey; market: PublicKey; portfolio: PublicKey; owner: PublicKey; destToken: PublicKey; vaultToken: PublicKey; signed?: boolean;
}): TransactionInstruction {
  const keys = buildAccountMetas(ACCOUNTS_CLAIM_RESOLVED_PAYOUT_TOPUP, {
    owner: a.owner, market: a.market, portfolio: a.portfolio, destToken: a.destToken, vaultToken: a.vaultToken,
    vaultAuthority: deriveVaultAuthority(a.programId, a.market)[0], tokenProgram: TOKEN_PROGRAM_ID,
  });
  if (!a.signed) {
    keys[0] = { pubkey: a.owner, isSigner: false, isWritable: false };
    keys.push({ pubkey: deriveNftRegistry(a.programId, a.market)[0], isSigner: false, isWritable: false });
  }
  return new TransactionInstruction({ programId: a.programId, keys, data: Buffer.from([46]) });
}

/** A portfolio with a present, non-finalised resolved receipt. */
export interface OpenResolvedReceiptP3 {
  portfolio: PublicKey;
  owner: PublicKey;
  receipt: ResolvedPayoutReceiptP3;
  /** The vault LP (owner = LP-vault registry PDA): settles via 101, never 46. */
  isVaultLp: boolean;
  /** Owner is off-curve (e.g. an NFT-escrow PDA): the permissionless 46 is refused; the holder must sign. */
  needsHolder: boolean;
}

/**
 * List every portfolio of `market` with an OPEN (present, non-finalised) resolved receipt, via
 * getProgramAccounts (dataSize + market at offset 16).
 * @param conn       Connection.
 * @param programId  Wrapper program id.
 * @param market     Market (slab) account.
 * @returns Open receipts (vault LP flagged, escrowed owners flagged).
 * @example
 * ```ts
 * const open = await listOpenResolvedReceiptsP3(conn, W, market);
 * ```
 */
export async function listOpenResolvedReceiptsP3(conn: Pick<Connection, "getProgramAccounts">, programId: PublicKey, market: PublicKey, layout: LayoutTable = LAYOUT_V21): Promise<OpenResolvedReceiptP3[]> {
  const accs = await conn.getProgramAccounts(programId, {
    commitment: "confirmed",
    filters: [{ dataSize: layout.portfolio.accountLen }, { memcmp: { offset: 16, bytes: market.toBase58() } }],
  });
  const [registry] = deriveLpVaultRegistry(programId, market);
  const out: OpenResolvedReceiptP3[] = [];
  for (const { pubkey, account } of accs) {
    const data = new Uint8Array(account.data);
    const receipt = decodeResolvedPayoutReceiptP3(data);
    if (!receipt.open) continue;
    const owner = new PublicKey(data.subarray(80, 112)); // provenance owner (16 + 64)
    out.push({ portfolio: pubkey, owner, receipt, isVaultLp: owner.equals(registry), needsHolder: !PublicKey.isOnCurve(owner.toBytes()) && !owner.equals(registry) });
  }
  return out;
}

/**
 * Tag 30 CloseResolved, permissionless form (owner unsigned, `nft_registry` at [7]); data
 * `[30][fee_rate_per_slot u128 = 0]`. The receipt-revisit fallback when a 46 is refused.
 * @param a  programId, market, portfolio, owner, destToken (owner's collateral ATA), vaultToken.
 * @returns Instruction.
 * @example
 * ```ts
 * const ix = buildCloseResolvedUnsignedIxP3({ programId: W, market, portfolio, owner, destToken, vaultToken });
 * ```
 */
export function buildCloseResolvedUnsignedIxP3(a: {
  programId: PublicKey; market: PublicKey; portfolio: PublicKey; owner: PublicKey; destToken: PublicKey; vaultToken: PublicKey;
}): TransactionInstruction {
  const ix = buildClaimResolvedPayoutTopupIxP3(a);
  return new TransactionInstruction({ programId: a.programId, keys: ix.keys, data: Buffer.alloc(17, 0).fill(30, 0, 1) });
}

/** One receipt-revisit step: try `topup46` first; if its simulation is refused, send `closeResolved`. */
export interface ReceiptRevisitStepP3 {
  portfolio: PublicKey;
  owner: PublicKey;
  topup46: TransactionInstruction;
  closeResolved: TransactionInstruction;
}

/**
 * Plan one ROUND of the resolved-receipt revisit (percolator-prog 5e4c15ff rule): dilution comes
 * from ANY claimant whose pot-backed claim is still unreceipted, so after the claimants' closes and
 * after the vault LP's 101 settles, every portfolio whose receipt is present && !finalized gets a
 * tag 46 (or, if that is refused, a repeat CloseResolved) — and the caller REPEATS rounds (re-listing
 * with {@link listOpenResolvedReceiptsP3}) every cycle until none is open. Only then are the
 * portfolios closed (tag 8) and the seniors' 77 run (an open receipt blocks terminal-flat → 21).
 * The vault LP is excluded (it settles via 101); off-curve (NFT-escrowed) owners are returned in
 * `needsHolder` (the permissionless forms are refused for them).
 * @param a  programId, market, vaultToken, collateralMint, the open receipts of this round.
 * @returns `{ steps, needsHolder }` — `steps` empty ⇒ nothing left to revisit.
 * @example
 * ```ts
 * for (let round = 0; round < 50; round++) {
 *   const plan = planResolvedReceiptRevisitP3({ programId: W, market, vaultToken, collateralMint, open: await listOpenResolvedReceiptsP3(conn, W, market) });
 *   if (plan.steps.length === 0) break;
 *   for (const s of plan.steps) await sendFirstThatSimulates([s.topup46], [s.closeResolved]);
 * }
 * ```
 */
export function planResolvedReceiptRevisitP3(a: {
  programId: PublicKey; market: PublicKey; vaultToken: PublicKey; collateralMint: PublicKey; open: OpenResolvedReceiptP3[];
}): { steps: ReceiptRevisitStepP3[]; needsHolder: OpenResolvedReceiptP3[] } {
  const steps: ReceiptRevisitStepP3[] = [];
  const needsHolder: OpenResolvedReceiptP3[] = [];
  for (const r of a.open) {
    if (r.isVaultLp) continue;
    if (r.needsHolder) { needsHolder.push(r); continue; }
    const destToken = getAssociatedTokenAddressSync(a.collateralMint, r.owner, false, TOKEN_PROGRAM_ID);
    const base = { programId: a.programId, market: a.market, portfolio: r.portfolio, owner: r.owner, destToken, vaultToken: a.vaultToken };
    steps.push({ portfolio: r.portfolio, owner: r.owner, topup46: buildClaimResolvedPayoutTopupIxP3(base), closeResolved: buildCloseResolvedUnsignedIxP3(base) });
  }
  return { steps, needsHolder };
}
