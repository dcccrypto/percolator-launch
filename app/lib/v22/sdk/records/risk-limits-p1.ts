/*
 * LOCAL ADAPTER PORT, not original code: verbatim from percolator-sdk feat/v22-sdk @ ecb6215 (draft dcccrypto/percolator-sdk#406, sdk 9.0.0-candidate),
 * src/abi/risk-limits-p1.ts. Only the imports are retargeted (the vendored v22 layout/slab ports, sibling records ports, and the installed @percolatorct/sdk 8.0.0 root).
 * Delete when @percolatorct/sdk >= 9.0.0 ships and point ../../records.ts at the package. Do not edit here; fix upstream in percolator-sdk.
 */
/**
 * P1 per-asset risk limits — wrapper tag 93 `SetAssetRiskLimits` and the `AssetRiskLimitsV17`
 * record. Additive to SDK 8.0.0.
 *
 * Source: percolator-prog `58e379f1` (the relaunch wrapper, P1 + P3), `src/v16_program.rs`:
 * decode arm `TAG_SET_ASSET_RISK_LIMITS` (93), its encoder (optional tail), `handle_set_asset_risk_limits`,
 * `state::AssetRiskLimitsV17` at wrapper-slot offset `ASSET_RISK_LIMITS_OFF` (608).
 *
 * @module risk-limits-p1
 */
import { LAYOUT_V21, resolveMarketGeometry } from "../layout";
import type { LayoutTable } from "../layout";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { concatBytes, encU8, encU16, encU32, encU128 } from "@percolatorct/sdk";
import type { AccountSpec } from "@percolatorct/sdk";
import { buildAccountMetas } from "@percolatorct/sdk";

/** P1 tag table. */
export const IX_TAG_P1 = Object.freeze({ SetAssetRiskLimits: 93 } as const);

/** `risk_limits_v17::MAX_EXEC_BAND_BPS`. */
export const MAX_EXEC_BAND_BPS_P1 = 10_000;
/** `risk_limits_v17::MAX_LP_EXPOSURE_K_BPS`. */
export const MAX_LP_EXPOSURE_K_BPS_P1 = 10_000_000;
/** Engine `MAX_OI_SIDE_Q`. */
export const MAX_OI_SIDE_Q_P1 = 100_000_000_000_000n;
/** `state::MATCHER_EXT_MODE_V1` (the only non-zero mode). */
export const MATCHER_EXT_MODE_V1_P1 = 1;
/** `risk_limits_v17::MAX_REQUESTED_FEE_BPS`. */
export const MAX_REQUESTED_FEE_BPS_P1 = 1023;

/** Tag 93 fields. Every 0 means "use the protocol default" (see the record docs). */
export interface SetAssetRiskLimitsArgsP1 {
  assetIndex: number;
  /** Execution-price band (bps); 0 = default. <= 10000. */
  execBandBps: number;
  /** LP exposure multiplier k (bps of equity); 0 = 1e8 / initial_margin_bps. <= 1e7. */
  lpExposureKBps: number;
  /** Auto-halt floor on the matcher LP's IM equity (atoms); 0 = halt only a depleted LP. */
  lpFloorAtoms: bigint;
  /** Max effective OI per side (Q); 0 = engine MAX_OI_SIDE_Q. <= 1e14. */
  sideOiCapQ: bigint;
  /** 0 = legacy call bytes; 1 = send the P2 ext block. Optional wire tail. Default 0. */
  matcherExtMode?: number;
  /**
   * P2 fee-request channel cap (bps); 0 = channel OFF. Optional wire tail. Default 0.
   * Keep 0 on the relaunch until the frontend ships with LIMITS_P2=1 and the matcher is v2 —
   * a non-zero value makes every trade with a non-zero quote fail for older app builds.
   */
  maxRequestedFeeBps?: number;
}

function int(name: string, v: number, max: number): void {
  if (!Number.isInteger(v) || v < 0 || v > max) throw new Error(`${name} must be an integer in 0..=${max}, got ${v}`);
}

/**
 * Encode tag 93 exactly like the wrapper's own encoder: 41 bytes, then the optional tail —
 * `matcher_ext_mode` (u8) if either tail field is non-zero, then `max_requested_fee_bps`
 * (u16) if it is non-zero. The decoder reads a missing tail as 0.
 *
 * @param a  Fields (validated against the handler's bounds).
 * @returns 41, 42 or 44 bytes.
 * @example
 * ```ts
 * const data = encodeSetAssetRiskLimitsP1({ assetIndex: 0, execBandBps: 300, lpExposureKBps: 50_000,
 *   lpFloorAtoms: 250_000_000n, sideOiCapQ: 7_000_000_000n });
 * ```
 */
export function encodeSetAssetRiskLimitsP1(a: SetAssetRiskLimitsArgsP1): Uint8Array {
  const ext = a.matcherExtMode ?? 0;
  const fee = a.maxRequestedFeeBps ?? 0;
  int("assetIndex", a.assetIndex, 0xffff);
  int("execBandBps", a.execBandBps, MAX_EXEC_BAND_BPS_P1);
  int("lpExposureKBps", a.lpExposureKBps, MAX_LP_EXPOSURE_K_BPS_P1);
  int("matcherExtMode", ext, MATCHER_EXT_MODE_V1_P1);
  int("maxRequestedFeeBps", fee, MAX_REQUESTED_FEE_BPS_P1);
  if (a.lpFloorAtoms < 0n || a.lpFloorAtoms > (1n << 128n) - 1n) throw new Error("lpFloorAtoms out of u128 range");
  if (a.sideOiCapQ < 0n || a.sideOiCapQ > MAX_OI_SIDE_Q_P1) throw new Error(`sideOiCapQ must be in 0..=${MAX_OI_SIDE_Q_P1}`);
  const parts = [
    encU8(IX_TAG_P1.SetAssetRiskLimits), encU16(a.assetIndex), encU16(a.execBandBps), encU32(a.lpExposureKBps),
    encU128(a.lpFloorAtoms), encU128(a.sideOiCapQ),
  ];
  if (ext !== 0 || fee !== 0) parts.push(encU8(ext));
  if (fee !== 0) parts.push(encU16(fee));
  return concatBytes(...parts);
}

/** Tag 93 accounts: `[upgrade_authority (s), ProgramData, market (w)]`. */
export const ACCOUNTS_SET_ASSET_RISK_LIMITS_P1: readonly AccountSpec[] = [
  { name: "upgradeAuthority", signer: true, writable: false },
  { name: "programData", signer: false, writable: false },
  { name: "market", signer: false, writable: true },
] as const;

const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

/**
 * Build tag 93 (upgrade-authority gated; ProgramData derived from the wrapper id).
 *
 * @param programId         Wrapper program id.
 * @param market            Market account.
 * @param upgradeAuthority  The wrapper's upgrade authority (signer).
 * @param args              Fields.
 * @returns TransactionInstruction.
 * @example
 * ```ts
 * const ix = buildSetAssetRiskLimitsIxP1(WRAPPER, market, upgradeAuthority, { assetIndex: 0, ... });
 * ```
 */
export function buildSetAssetRiskLimitsIxP1(
  programId: PublicKey, market: PublicKey, upgradeAuthority: PublicKey, args: SetAssetRiskLimitsArgsP1,
): TransactionInstruction {
  const [programData] = PublicKey.findProgramAddressSync([programId.toBytes()], BPF_LOADER_UPGRADEABLE);
  return new TransactionInstruction({
    programId,
    keys: buildAccountMetas(ACCOUNTS_SET_ASSET_RISK_LIMITS_P1, { upgradeAuthority, programData, market }),
    data: Buffer.from(encodeSetAssetRiskLimitsP1(args)),
  });
}

// ============================================================================
// AssetRiskLimitsV17 decoder
// ============================================================================

/** Field offsets inside the 64-byte record (rustc layout of `state::AssetRiskLimitsV17`). */
export const ASSET_RISK_LIMITS_FIELD_OFF_P1 = Object.freeze({
  sideOiCapQ: 0, lpFloorAtoms: 16, lpExposureKBps: 32, execBandBps: 36, matcherExtMode: 38,
  reserved0: 39, maxRequestedFeeBps: 40, reserved: 42,
} as const);
/** `ASSET_RISK_LIMITS_LEN`. */
export const ASSET_RISK_LIMITS_LEN_P1 = 64;
/** `ASSET_RISK_LIMITS_OFF` inside each asset's 1024-byte wrapper slot. */
export const ASSET_RISK_LIMITS_SLOT_OFF_P1 = 608;

/**
 * Account offset of asset `i`'s record: 592 + 758 + 2325·i + 608 = 1958 + 2325·i.
 * @param assetIndex  Asset slot.
 * @param layout      Layout table of the account's VERSION (default LAYOUT_V21; LAYOUT_V22 for v2.2).
 * @returns Byte offset.
 * @example
 * ```ts
 * assetRiskLimitsAccountOffsetP1(0); // 1958
 * ```
 */
export function assetRiskLimitsAccountOffsetP1(assetIndex: number, layout: LayoutTable = LAYOUT_V21): number {
  if (!Number.isInteger(assetIndex) || assetIndex < 0) throw new Error(`bad assetIndex ${assetIndex}`);
  return layout.marketGroupOff + layout.marketGroupLen + layout.assetSlotStride * assetIndex + layout.wrapperSlot.riskLimits;
}

/** Decoded `AssetRiskLimitsV17` (raw stored values; 0 = protocol default). */
export interface AssetRiskLimitsP1 {
  sideOiCapQ: bigint;
  lpFloorAtoms: bigint;
  lpExposureKBps: number;
  execBandBps: number;
  matcherExtMode: number;
  /** 0 = fee-request channel OFF (required at relaunch). */
  maxRequestedFeeBps: number;
}

/**
 * Decode one 64-byte `AssetRiskLimitsV17` record.
 * @param rec  The 64 bytes.
 * @returns Decoded limits.
 * @example
 * ```ts
 * decodeAssetRiskLimitsRecordP1(bytes).maxRequestedFeeBps;
 * ```
 */
export function decodeAssetRiskLimitsRecordP1(rec: Uint8Array): AssetRiskLimitsP1 {
  if (rec.length !== ASSET_RISK_LIMITS_LEN_P1) throw new Error(`AssetRiskLimitsV17 record must be 64 bytes, got ${rec.length}`);
  const v = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
  const u128 = (o: number): bigint => (v.getBigUint64(o + 8, true) << 64n) | v.getBigUint64(o, true);
  const F = ASSET_RISK_LIMITS_FIELD_OFF_P1;
  return {
    sideOiCapQ: u128(F.sideOiCapQ), lpFloorAtoms: u128(F.lpFloorAtoms), lpExposureKBps: v.getUint32(F.lpExposureKBps, true),
    execBandBps: v.getUint16(F.execBandBps, true), matcherExtMode: rec[F.matcherExtMode],
    maxRequestedFeeBps: v.getUint16(F.maxRequestedFeeBps, true),
  };
}

/**
 * Decode asset `i`'s `AssetRiskLimitsV17` from a raw market account (kind 1).
 * @param marketData  Raw market bytes.
 * @param assetIndex  Asset slot.
 * @returns Decoded limits.
 * @example
 * ```ts
 * if (decodeAssetRiskLimitsP1(info.data, 0).maxRequestedFeeBps !== 0) throw new Error("fee channel must be off");
 * ```
 */
export function decodeAssetRiskLimitsP1(marketData: Uint8Array, assetIndex: number): AssetRiskLimitsP1 {
  const g = resolveMarketGeometry(marketData, { parser: "decodeAssetRiskLimitsP1", strictLength: false });
  const off = assetRiskLimitsAccountOffsetP1(assetIndex, g.layout);
  if (marketData.length < off + ASSET_RISK_LIMITS_LEN_P1) throw new Error(`market account too short for asset ${assetIndex}`);
  return decodeAssetRiskLimitsRecordP1(marketData.subarray(off, off + ASSET_RISK_LIMITS_LEN_P1));
}
