/*
 * LOCAL ADAPTER PORT, not original code: verbatim from percolator-sdk feat/v22-sdk @ ecb6215 (draft dcccrypto/percolator-sdk#406, sdk 9.0.0-candidate),
 * src/abi/v22-state.ts. Only the imports are retargeted (the installed @percolatorct/sdk 8.0.0 root, the v2.1 txv1 port, and the sibling v22 ports).
 * Delete when @percolatorct/sdk >= 9.0.0 ships and point ./index.ts at the package. Do not edit here; fix upstream in percolator-sdk.
 */
/**
 * Decoders for the account types the v2.2 wrapper adds: `BondTrancheV20`, `BondPositionV20`,
 * `InsuranceUnitsV20` (192 B body), `G9FeedAllowlistV22`, and the 128-byte redemption request
 * (`LpRedemptionV16` + `LpRedemptionExtV22`).
 *
 * Every decoder runs the VERSION guard first ({@link resolveLayout}: magic, VERSION, kind) and then
 * applies the SAME reachable-state validation the program applies when it reads the account
 * (`state::validate_bond_tranche` and friends, `v16_program.rs:6828..7230`): an account the program
 * would refuse is refused here with a typed {@link UnknownLayoutError}, never partially decoded.
 * Sizes come from {@link LAYOUT_V22} only.
 *
 * @module v22-state
 */
import { PublicKey } from "@solana/web3.js";
import { ACCOUNT_KIND, LAYOUT_V22, UnknownLayoutError, resolveLayout } from "./layout";
import type { LayoutTable } from "./layout";

function dv(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}
function u128(v: DataView, off: number): bigint {
  return (v.getBigUint64(off + 8, true) << 64n) | v.getBigUint64(off, true);
}
function isZero(b: Uint8Array): boolean {
  for (const x of b) if (x !== 0) return false;
  return true;
}

function guard(data: Uint8Array, parser: string, kind: number, bodyLen: number, table: LayoutTable): number {
  const L = resolveLayout(data, { parser, kind, versions: [table.version] });
  const need = L.headerLen + bodyLen;
  if (data.length < need) {
    throw new UnknownLayoutError("TOO_SHORT", parser, `account too short: ${data.length} < ${need}`, { version: L.version, kind });
  }
  return L.headerLen;
}

function bad(parser: string, msg: string, kind: number): UnknownLayoutError {
  return new UnknownLayoutError("INVALID_RECORD", parser, `invalid account data: ${msg}`, { kind });
}

// ============================================================================
// BondTrancheV20 (kind 11, ["bond_tranche", market], 16 + 128)
// ============================================================================

/** Decoded `BondTrancheV20` (`v16_program.rs:6840..6870`; offsets pinned by const asserts there). */
export interface BondTrancheV20 {
  marketGroup: PublicKey;
  /** `C_b`: deposits + credited coupons - redeemed pro-rata slices. */
  cBAtoms: bigint;
  /** `B`: bond shares outstanding. */
  bSharesTotal: bigint;
  principalInLpAtoms: bigint;
  /** Informational mirror of the impairment; nothing prices off it. */
  bondDrawnOutstandingAtoms: bigint;
  lastCouponSlot: bigint;
  couponBpsPerYear: number;
  couponUtilBonusBps: number;
  bondCooldownSlots: number;
  bondCapBpsOfC: number;
  version: number;
  bump: number;
  lastUtilBps: number;
  couponPaidTotalAtoms: bigint;
}

/** Field offsets inside the 128-byte body (rustc `offset_of!`; add 16 for the account). */
export const BOND_TRANCHE_FIELD_OFF_V22 = Object.freeze({
  marketGroup: 0, cBAtoms: 32, bSharesTotal: 48, principalInLpAtoms: 64, bondDrawnOutstandingAtoms: 80,
  lastCouponSlot: 96, couponBpsPerYear: 104, couponUtilBonusBps: 106, bondCooldownSlots: 108,
  bondCapBpsOfC: 112, version: 114, bump: 115, lastUtilBps: 116, padding: 118, couponPaidTotalAtoms: 120,
} as const);

/**
 * Decode a bond tranche account.
 *
 * @param data   Raw account bytes (`16 + 128`).
 * @param table  Layout table (default {@link LAYOUT_V22}).
 * @returns The tranche.
 * @throws {@link UnknownLayoutError} on a wrong header, short data or an invalid record (dials outside
 *   `bond_config_ok`, `C_b == 0` xor `B == 0`, non-zero padding, `last_util_bps > 10000`).
 * @example
 * ```ts
 * const t = decodeBondTrancheV20(info.data);
 * ```
 */
export function decodeBondTrancheV20(data: Uint8Array, table: LayoutTable = LAYOUT_V22): BondTrancheV20 {
  const parser = "decodeBondTrancheV20";
  const b = guard(data, parser, ACCOUNT_KIND.BondTranche, table.accounts.bondTrancheBody, table);
  const v = dv(data);
  const F = BOND_TRANCHE_FIELD_OFF_V22;
  const t: BondTrancheV20 = {
    marketGroup: new PublicKey(data.subarray(b, b + 32)),
    cBAtoms: u128(v, b + F.cBAtoms),
    bSharesTotal: u128(v, b + F.bSharesTotal),
    principalInLpAtoms: u128(v, b + F.principalInLpAtoms),
    bondDrawnOutstandingAtoms: u128(v, b + F.bondDrawnOutstandingAtoms),
    lastCouponSlot: v.getBigUint64(b + F.lastCouponSlot, true),
    couponBpsPerYear: v.getUint16(b + F.couponBpsPerYear, true),
    couponUtilBonusBps: v.getUint16(b + F.couponUtilBonusBps, true),
    bondCooldownSlots: v.getUint32(b + F.bondCooldownSlots, true),
    bondCapBpsOfC: v.getUint16(b + F.bondCapBpsOfC, true),
    version: data[b + F.version],
    bump: data[b + F.bump],
    lastUtilBps: v.getUint16(b + F.lastUtilBps, true),
    couponPaidTotalAtoms: v.getBigUint64(b + F.couponPaidTotalAtoms, true),
  };
  // validate_bond_tranche
  const dialsOk =
    t.couponBpsPerYear <= 2_000 && t.couponUtilBonusBps === 0 && t.bondCooldownSlots >= 9_000 && t.bondCooldownSlots <= 1_512_000 && t.bondCapBpsOfC >= 1 && t.bondCapBpsOfC <= 5_000;
  if (t.version !== 1 || isZero(data.subarray(b, b + 32)) || !dialsOk || t.lastUtilBps > 10_000 || !isZero(data.subarray(b + F.padding, b + F.padding + 2)) || (t.cBAtoms === 0n) !== (t.bSharesTotal === 0n)) {
    throw bad(parser, "bond tranche fails the program's validate_bond_tranche", ACCOUNT_KIND.BondTranche);
  }
  return t;
}

// ============================================================================
// BondPositionV20 (kind 12, ["bond", market, owner], 16 + 96)
// ============================================================================

/** Decoded `BondPositionV20` (`v16_program.rs:6949..6962`). */
export interface BondPositionV20 {
  owner: PublicKey;
  shares: bigint;
  /** Requested for withdrawal (tag 109); still counted in `B` until tag 110. */
  pendingWithdrawShares: bigint;
  requestSlot: bigint;
  version: number;
  bump: number;
}

/** Field offsets inside the 96-byte body. */
export const BOND_POSITION_FIELD_OFF_V22 = Object.freeze({
  owner: 0, shares: 32, pendingWithdrawShares: 48, requestSlot: 64, version: 72, bump: 73, padding: 74, reserved: 80,
} as const);

/**
 * Decode a bond position account.
 *
 * @param data   Raw account bytes (`16 + 96`).
 * @param table  Layout table (default {@link LAYOUT_V22}).
 * @returns The position.
 * @throws {@link UnknownLayoutError} on a wrong header, short data, `pending > shares`, a zero owner or
 *   non-zero padding / reserved bytes.
 * @example
 * ```ts
 * const p = decodeBondPositionV20(info.data);
 * ```
 */
export function decodeBondPositionV20(data: Uint8Array, table: LayoutTable = LAYOUT_V22): BondPositionV20 {
  const parser = "decodeBondPositionV20";
  const b = guard(data, parser, ACCOUNT_KIND.BondPosition, table.accounts.bondPositionBody, table);
  const v = dv(data);
  const F = BOND_POSITION_FIELD_OFF_V22;
  const p: BondPositionV20 = {
    owner: new PublicKey(data.subarray(b, b + 32)),
    shares: u128(v, b + F.shares),
    pendingWithdrawShares: u128(v, b + F.pendingWithdrawShares),
    requestSlot: v.getBigUint64(b + F.requestSlot, true),
    version: data[b + F.version],
    bump: data[b + F.bump],
  };
  if (p.version !== 1 || isZero(data.subarray(b, b + 32)) || p.pendingWithdrawShares > p.shares || !isZero(data.subarray(b + F.padding, b + F.padding + 6)) || !isZero(data.subarray(b + F.reserved, b + F.reserved + 16))) {
    throw bad(parser, "bond position fails the program's validate_bond_position", ACCOUNT_KIND.BondPosition);
  }
  return p;
}

// ============================================================================
// InsuranceUnitsV20 (kind 13, ["ins_units", market], 16 + 192)
// ============================================================================

/** Decoded `InsuranceUnitsV20` (`v16_program.rs:7052..7100`; stake v5 pins the same offsets). */
export interface InsuranceUnitsV20 {
  marketGroup: PublicKey;
  /** `U = units_stake + units_creator`. */
  unitsTotal: bigint;
  unitsStake: bigint;
  unitsCreator: bigint;
  /** G9 insurance lent to the vault LP, owed back first. Part of the MINT (entry) reading only. */
  backstopReceivableAtoms: bigint;
  /** Entry reading at `snapSlot`: asset-0 budgets remaining + receivable. */
  snapInsuranceMintAtoms: bigint;
  /** Exit reading at `snapSlot`: asset-0 withdraw capacity. */
  snapInsuranceFreeAtoms: bigint;
  snapSlot: bigint;
  version: number;
  bump: number;
  /** Creator-class value paid to the stake pool's vault at terminal (never decreases). */
  creatorPaidToStakeAtoms: bigint;
  /** Slot of the open G9 proposal (tag 111 mode 2); 0 = none. */
  g9PendingSlot: bigint;
  g9Epoch: bigint;
  g9EpochDrawnAtoms: bigint;
}

/** Field offsets inside the 192-byte body (rustc `offset_of!`; add 16 for the account). */
export const INSURANCE_UNITS_FIELD_OFF_V22 = Object.freeze({
  marketGroup: 0, unitsTotal: 32, unitsStake: 48, unitsCreator: 64, backstopReceivableAtoms: 80,
  snapInsuranceMintAtoms: 96, snapInsuranceFreeAtoms: 112, snapSlot: 128, version: 136, bump: 137, padding: 138,
  creatorPaidToStakeAtoms: 144, g9PendingSlot: 160, g9Epoch: 168, g9EpochDrawnAtoms: 176,
} as const);

/**
 * Decode an insurance-units ledger.
 *
 * @param data   Raw account bytes (`16 + 192`).
 * @param table  Layout table (default {@link LAYOUT_V22}).
 * @returns The ledger.
 * @throws {@link UnknownLayoutError} on a wrong header, short data (a 160-byte round-1 ledger is refused),
 *   `units_stake + units_creator != units_total`, a zero market or non-zero padding.
 * @example
 * ```ts
 * const u = decodeInsuranceUnitsV20(info.data);
 * ```
 */
export function decodeInsuranceUnitsV20(data: Uint8Array, table: LayoutTable = LAYOUT_V22): InsuranceUnitsV20 {
  const parser = "decodeInsuranceUnitsV20";
  const b = guard(data, parser, ACCOUNT_KIND.InsuranceUnits, table.accounts.insuranceUnitsBody, table);
  const v = dv(data);
  const F = INSURANCE_UNITS_FIELD_OFF_V22;
  const x: InsuranceUnitsV20 = {
    marketGroup: new PublicKey(data.subarray(b, b + 32)),
    unitsTotal: u128(v, b + F.unitsTotal),
    unitsStake: u128(v, b + F.unitsStake),
    unitsCreator: u128(v, b + F.unitsCreator),
    backstopReceivableAtoms: u128(v, b + F.backstopReceivableAtoms),
    snapInsuranceMintAtoms: u128(v, b + F.snapInsuranceMintAtoms),
    snapInsuranceFreeAtoms: u128(v, b + F.snapInsuranceFreeAtoms),
    snapSlot: v.getBigUint64(b + F.snapSlot, true),
    version: data[b + F.version],
    bump: data[b + F.bump],
    creatorPaidToStakeAtoms: u128(v, b + F.creatorPaidToStakeAtoms),
    g9PendingSlot: v.getBigUint64(b + F.g9PendingSlot, true),
    g9Epoch: v.getBigUint64(b + F.g9Epoch, true),
    g9EpochDrawnAtoms: u128(v, b + F.g9EpochDrawnAtoms),
  };
  if (x.version !== 1 || isZero(data.subarray(b, b + 32)) || x.unitsStake + x.unitsCreator !== x.unitsTotal || !isZero(data.subarray(b + F.padding, b + F.padding + 6))) {
    throw bad(parser, "insurance units fail the program's validate_insurance_units", ACCOUNT_KIND.InsuranceUnits);
  }
  return x;
}

// ============================================================================
// G9FeedAllowlistV22 (kind 15, ["g9_feeds"], 16 + 520)
// ============================================================================

/** Decoded `G9FeedAllowlistV22` (`v16_program.rs:7149..7200`). */
export interface G9FeedAllowlistV22 {
  count: number;
  version: number;
  bump: number;
  /** The first `count` keys. */
  keys: PublicKey[];
}

/**
 * Decode the G9 Switchboard feed allowlist.
 *
 * @param data   Raw account bytes (`16 + 520`).
 * @param table  Layout table (default {@link LAYOUT_V22}).
 * @returns The allowlist.
 * @throws {@link UnknownLayoutError} on a wrong header, short data, `count > 16`, a zero or duplicate listed
 *   key, a non-zero unlisted slot or non-zero padding.
 * @example
 * ```ts
 * const list = decodeG9FeedAllowlistV22(info.data);
 * ```
 */
export function decodeG9FeedAllowlistV22(data: Uint8Array, table: LayoutTable = LAYOUT_V22): G9FeedAllowlistV22 {
  const parser = "decodeG9FeedAllowlistV22";
  const b = guard(data, parser, ACCOUNT_KIND.G9FeedAllowlist, table.accounts.g9FeedAllowlistBody, table);
  const count = data[b];
  const version = data[b + 1];
  const bump = data[b + 2];
  const cap = table.accounts.g9FeedAllowlistCap;
  if (version !== 1 || count > cap || !isZero(data.subarray(b + 3, b + 8))) throw bad(parser, "allowlist header invalid", ACCOUNT_KIND.G9FeedAllowlist);
  const slot = (i: number) => data.subarray(b + 8 + 32 * i, b + 8 + 32 * (i + 1));
  const seen = new Set<string>();
  const keys: PublicKey[] = [];
  for (let i = 0; i < cap; i++) {
    const k = slot(i);
    if (i < count) {
      const h = Buffer.from(k).toString("hex");
      if (isZero(k) || seen.has(h)) throw bad(parser, `listed key ${i} is zero or duplicated`, ACCOUNT_KIND.G9FeedAllowlist);
      seen.add(h);
      keys.push(new PublicKey(k));
    } else if (!isZero(k)) {
      throw bad(parser, `unlisted slot ${i} is not zero`, ACCOUNT_KIND.G9FeedAllowlist);
    }
  }
  return { count, version, bump, keys };
}

// ============================================================================
// Redemption request, legacy (112 B) and v2.2 (128 B)
// ============================================================================

/** Decoded redemption request, both account lengths. */
export interface LpRedemptionV22 {
  registry: PublicKey;
  redeemer: PublicKey;
  shares: bigint;
  requestSlot: bigint;
  version: number;
  bump: number;
  /** `true` when the account is the 128-byte v2.2 form (the request was made with the extended tag 76). */
  extended: boolean;
  /** The redeemer's stored payout floor (atoms); 0 for a legacy request. */
  minPayoutAtoms: bigint;
  /** `true` when anyone may execute (strictly loss-gated, at the stored floor); `false` for a legacy request. */
  keeperOk: boolean;
}

/**
 * Decode a redemption request of either length. A request shorter than 128 bytes reads the extension as
 * all-zero (no floor, redeemer-only), exactly like `state::read_lp_redemption_ext`; a 128-byte request
 * with `keeper_ok > 1` or non-zero reserved bytes is refused. Any `getProgramAccounts` filter on the
 * request must accept BOTH lengths (112 and 128) and `memcmp` the kind byte.
 *
 * @param data   Raw account bytes.
 * @param table  Layout table (default {@link LAYOUT_V22}).
 * @returns The request.
 * @throws {@link UnknownLayoutError} on a wrong header or short data / an invalid extension.
 * @example
 * ```ts
 * const r = decodeLpRedemptionV22(info.data);
 * if (r.extended) console.log("floor", r.minPayoutAtoms);
 * ```
 */
export function decodeLpRedemptionV22(data: Uint8Array, table: LayoutTable = LAYOUT_V22): LpRedemptionV22 {
  const parser = "decodeLpRedemptionV22";
  const b = guard(data, parser, ACCOUNT_KIND.LpRedemption, table.accounts.redemptionBody, table);
  const v = dv(data);
  const extOff = b + table.accounts.redemptionBody;
  const extended = data.length >= extOff + table.accounts.redemptionExtBody;
  let minPayoutAtoms = 0n;
  let keeperOk = false;
  if (extended) {
    const k = data[extOff + 8];
    if (k > 1 || !isZero(data.subarray(extOff + 9, extOff + 16))) throw bad(parser, "redemption extension invalid (keeper_ok > 1 or reserved bytes set)", ACCOUNT_KIND.LpRedemption);
    minPayoutAtoms = v.getBigUint64(extOff, true);
    keeperOk = k === 1;
  }
  return {
    registry: new PublicKey(data.subarray(b, b + 32)),
    redeemer: new PublicKey(data.subarray(b + 32, b + 64)),
    shares: u128(v, b + 64),
    requestSlot: v.getBigUint64(b + 80, true),
    version: data[b + 88],
    bump: data[b + 89],
    extended,
    minPayoutAtoms,
    keeperOk,
  };
}

/**
 * The two valid `dataSize` values of a redemption request, for `getProgramAccounts` filters.
 *
 * @param table  Layout table (default {@link LAYOUT_V22}).
 * @returns `[legacy, v22]` account lengths (112 and 128).
 * @example
 * ```ts
 * const sizes = redemptionDataSizesV22(); // [112, 128]
 * ```
 */
export function redemptionDataSizesV22(table: LayoutTable = LAYOUT_V22): [number, number] {
  const legacy = table.accounts.headerLen + table.accounts.redemptionBody;
  return [legacy, legacy + table.accounts.redemptionExtBody];
}
