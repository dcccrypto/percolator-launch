/*
 * LOCAL ADAPTER PORT, not original code: verbatim from percolator-sdk feat/v22-sdk @ d98488b (draft dcccrypto/percolator-sdk#406, sdk 9.0.0-candidate),
 * src/abi/v22-wire.ts. Only the imports are retargeted (the installed @percolatorct/sdk 8.0.0 root, the v2.1 txv1 port, and the sibling v22 ports).
 * Delete when @percolatorct/sdk >= 9.0.0 ships and point ./index.ts at the package. Do not edit here; fix upstream in percolator-sdk.
 */
/**
 * v2.2 wrapper wire: instruction encoders and account lists for every tag the v2.2 programs add or
 * extend (Waves A, B, C and D of the Phase 4 stack), plus the constants those instructions are
 * bounded by.
 *
 * Source of truth (the wrapper has no IDL): `percolator-prog` `release/v22-wrapper` `b4390fe0`, the
 * combined release candidate, whose `ix::Instruction::decode` / `encode` are the decoders every
 * vector in `test/fixtures/v22-parity.json` was run through; the wave PRs #527 (A), #533 (B),
 * #530 (C), #531 (D) and `~/percolator-ops/ledger/v22-allocations.md`. Every function cites the
 * Rust decoder line it mirrors (`v16_program.rs` of that head).
 *
 * Nothing here is deployed. v1 (`ETDLAdi`) and v2.1 encoders are untouched; the v2.2 forms are
 * additive and selected by calling these functions (and by the program id the caller targets).
 *
 * @module v22-wire
 */
import { PublicKey } from "@solana/web3.js";
import type { AccountMeta } from "@solana/web3.js";
import { concatBytes, encU16, encU32, encU64, encU8, encU128 } from "@percolatorct/sdk";
import type { AccountSpec } from "@percolatorct/sdk";
import { encodeInitMarket } from "@percolatorct/sdk";
import type { InitMarketArgs, InitMarketV17Args } from "@percolatorct/sdk";

// ============================================================================
// Tags
// ============================================================================

/**
 * Instruction tags the v2.2 stack adds. Tags 113 to 115 are reserved for item 4 (oracle graduation) and
 * are NOT allocated. Cited: `constants::TAG_*` in `v16_program.rs` (lines 531..609 of the pinned head).
 */
export const IX_TAG_V22 = Object.freeze({
  /** Wave B, permissionless holding-rent settle (`TAG_SETTLE_HOLDING_RENT`). */
  SettleHoldingRent: 106,
  /** Wave C. */
  InitBondTranche: 107,
  BondDeposit: 108,
  BondRequestWithdraw: 109,
  BondExecuteWithdraw: 110,
  /** Wave D, G9 insurance backstop (`mode` 0 DRAW / 1 RESTORE / 2 PROPOSE). */
  InsuranceBackstopDraw: 111,
  /** Wave D, item 5 rescue deposit. */
  RescueDeposit: 112,
  /** Wave D, permissionless units-ledger init / refresh. */
  InitInsuranceUnits: 116,
  /** Wave D, upgrade-authority G9 Switchboard feed allowlist. */
  SetG9FeedAllowlist: 117,
  /** Wave B, permissionless dust sweep (renumbered 111 -> 118). */
  SweepBandDustLeg: 118,
  /** Wave B, evict-and-trade (`TradeCpi` body behind tag 119). */
  EvictAndTradeCpi: 119,
  /** Wave D mainnet #539 (R-10): upgrade-authority, timelocked propose of the G9 feed allowlist ({feed, owner} pairs). */
  ProposeG9FeedAllowlist: 120,
  /** Wave D mainnet #539 (R-10): commit the open proposal after G9_ALLOWLIST_TIMELOCK_SLOTS (216,000). */
  CommitG9FeedAllowlist: 121,
  /** #545: LP share mint name / symbol / uri (Metaplex), generic or ticker form. */
  InitLpShareMetadata: 122,
} as const);

/** Existing tags whose WIRE or ACCOUNT LIST the v2.2 stack extends. */
export const IX_TAG_EXTENDED_V22 = Object.freeze({
  InitMarket: 0,
  RequestRedeemLpShares: 76,
  ExecuteRedemption: 77,
  LpVaultCrankFees: 78,
  WithdrawJuniorTranche: 97,
  VaultLpReleaseSurplus: 102,
  VaultLpAllocate: 103,
  TradeCpi: 10,
  TopUpInsurance: 9,
  TopUpInsuranceDomain: 56,
  WithdrawInsuranceAsset: 57,
  WithdrawInsurance: 41,
  VaultLpSettleResolved: 101,
} as const);

// ============================================================================
// Constants (every one pinned against the real crate by test/fixtures/v22-parity.json)
// ============================================================================

/** `REDEMPTION_REFRESH_MAX`: tag 77 `n_refresh` ceiling. */
export const REDEMPTION_REFRESH_MAX_V22 = 8;
/** `REDEMPTION_REFRESH_BASE_WEIGHT`: a refreshed portfolio weighs `3 + active legs`. */
export const REDEMPTION_REFRESH_BASE_WEIGHT_V22 = 3;
/** `REDEMPTION_REFRESH_WEIGHT_BUDGET`: the sum of weights of the refreshed portfolios must be <= 34. */
export const REDEMPTION_REFRESH_WEIGHT_BUDGET_V22 = 34;
/** `wave_a_v22::EXIT_DIP_BPS`: a signed exit on a not-loss-current book may pay this far below par. */
export const EXIT_DIP_BPS_V22 = 25;
/** SDK default: the payout floor is the simulated quote minus at most this many bps (wire doc, SDK note 3). */
export const DEFAULT_FLOOR_SLIPPAGE_BPS_V22 = 5;
/** Compute-unit limit the Wave A doc prescribes for any tag 77 that refreshes (worst measured 1,199,659). */
export const EXECUTE_REDEMPTION_COMPUTE_UNITS_V22 = 1_300_000;

/** `LOT_EXP_MAX`: `lot_exp` is `1..=15` on the wire (0 = the 4-byte form). */
export const LOT_EXP_MAX_V22 = 15;
/** `LOT_PRICE_FLOOR_E6`: a growth market opens (and every ConfigureAuthMark on it stays) at or above 10 per lot. */
export const LOT_PRICE_FLOOR_E6_V22 = 10_000_000n;

/** `RENT_MIN_E9_PER_SLOT`: a rent market (`rent_max != 0`) needs `rent_max >= 10`. */
export const RENT_MIN_E9_PER_SLOT_V22 = 10;
/** `RENT_MAX_KINK_BPS`. */
export const RENT_MAX_KINK_BPS_V22 = 8_000;
/** engine `band_rent::MAX_RENT_E9_PER_SLOT`. */
export const MAX_RENT_E9_PER_SLOT_V22 = 10_000;
/** engine `band_rent::MAX_BAND_BPS`. */
export const MAX_BAND_BPS_V22 = 2_000;
/** engine `band_rent::BAND_MIN_EPOCH_SLOTS` (E floor). */
export const BAND_MIN_EPOCH_SLOTS_V22 = 150;
/** engine `band_rent::BAND_MIN_PIN_EPOCHS` (`Pmax >= 8 * E`). */
export const BAND_MIN_PIN_EPOCHS_V22 = 8;
/** engine `band_rent::BAND_MAX_POSITIONS_PER_SIDE` (the wrapper writes it; no wire field). */
export const BAND_MAX_POSITIONS_PER_SIDE_V22 = 256;
/** engine `band_rent::MIN_BAND_WIDTH_TICKS`. */
export const MIN_BAND_WIDTH_TICKS_V22 = 32;
/** engine `band_rent::BAND_GENESIS_FLOOR_MULTIPLE`: genesis price >= 100 x `band_min_wide_anchor(d)`. */
export const BAND_GENESIS_FLOOR_MULTIPLE_V22 = 100;
/** `growth_v19::BAND_MIN_LEG_NOTIONAL_TOKENS`: the program floor of `band_min_leg_notional`, in whole tokens. */
export const BAND_MIN_LEG_NOTIONAL_TOKENS_V22 = 10;
/** `BAND_EVICT_MAX_VICTIM_MULTIPLE`: tag 119 may only evict a leg of at most this x the minimum leg notional. */
export const BAND_EVICT_MAX_VICTIM_MULTIPLE_V22 = 4;
/** `BAND_EVICT_NOTIONAL_MULTIPLE`: the taker's fill must be at least this x the victim's notional. */
export const BAND_EVICT_NOTIONAL_MULTIPLE_V22 = 2;

/** Band defaults the SDK sends (wrapper `docs/v22-band-defaults-and-product-copy.md`). */
export const BAND_DEFAULTS_V22 = Object.freeze({
  /** d: 130 bps per the design table. */
  bandBps: 130,
  /** E: 600 slots (~4 min). */
  bandMaxEpochSlots: 600,
  /** Pmax: 9,000 slots (~60 min). */
  bandMaxPinSlots: 9_000,
  /** Whole collateral tokens. */
  bandMinLegNotionalTokens: 100,
} as const);

/** `bond_v20` protocol bounds that tag 107 enforces (`bond_config_ok`). */
export const BOND_COUPON_MAX_BPS_V22 = 2_000;
/** Utilisation bonus ceiling: ZERO until a wash-resistant metric exists (review L-2). */
export const BOND_UTIL_BONUS_MAX_BPS_V22 = 0;
export const BOND_COOLDOWN_MIN_SLOTS_V22 = 9_000;
export const BOND_COOLDOWN_MAX_SLOTS_V22 = 1_512_000;
export const BOND_CAP_MAX_BPS_V22 = 5_000;
/** Coupon ceiling per crank, bps of the harvested LP fee leg (review M-2). */
export const BOND_COUPON_MAX_LEG_BPS_V22 = 5_000;
/**
 * `WRAPPER_MAX_PORTFOLIO_ASSETS` = 4 (percolator-prog#546, founder-confirmed FINAL 2026-10-08): a portfolio holds at most 4 legs and
 * InitMarket refuses `max_portfolio_assets` above it (error 14).
 */
export const WRAPPER_MAX_PORTFOLIO_ASSETS_V22 = 4;
/**
 * `MATCHER_BATCH_MAX_LEGS` = min(11, {@link WRAPPER_MAX_PORTFOLIO_ASSETS_V22}) = 4: legs per BatchTradeCpi (5+ fail InvalidInstruction), and the
 * most trade legs a client should pack into one transaction (4 legs measured 689,000 CU; 714,967 with the growth ext).
 */
export const BATCH_MAX_LEGS_V22 = 4;

/**
 * Client guard for the v2.2 leg cap: a batch (or one transaction's trade legs) of `n` legs must be 1..={@link BATCH_MAX_LEGS_V22}.
 * @throws a plain `Error` naming the cap (the wrapper would answer InvalidInstruction, Custom 9).
 */
export function assertBatchLegsV22(n: number): void {
  if (!Number.isInteger(n) || n < 1 || n > BATCH_MAX_LEGS_V22) throw new Error(`a v2.2 batch carries 1..=${BATCH_MAX_LEGS_V22} legs, got ${n}`);
}
/** `bond_v20::SLOTS_PER_YEAR` (400 ms slots). */
export const SLOTS_PER_YEAR_V22 = 78_840_000n;

/** `p4_rescue_ins` constants. */
export const RESCUE_NAV_FLOOR_BPS_V22 = 500;
export const RESCUE_MIN_ATOMS_V22 = 100_000_000n;
export const RESCUE_MAX_MULT_V22 = 10n;
export const INS_UNITS_GENESIS_MIN_ATOMS_V22 = 1_000_000n;
export const BACKSTOP_CAP_BPS_V22 = 5_000;
export const G9_DELAY_SLOTS_V22 = 9_000n;
export const G9_EXEC_WINDOW_SLOTS_V22 = 9_000n;
export const G9_EPOCH_SLOTS_V22 = 216_000n;
export const G9_EPOCH_CAP_BPS_V22 = 2_000;
export const RESTORE_IM_BUFFER_BPS_V22 = 1_000;
/** `constants::G9_FEED_ALLOWLIST_CAP`. */
export const G9_FEED_ALLOWLIST_CAP_V22 = 16;

/** `p4_flags` bits (oracle profile byte +20). */
export const P4_FLAG_INS_UNITS_REQUIRED_V22 = 1;
export const P4_FLAG_EXIT_REQUIRES_LOSS_CURRENT_V22 = 1 << 2;
/** Insurance unit classes (`INS_UNIT_CLASS_*`). */
export const INS_UNIT_CLASS_STAKE_V22 = 0;
export const INS_UNIT_CLASS_CREATOR_V22 = 1;

/** Tag 111 `mode` values (`handle_insurance_backstop_draw`). */
export const BackstopMode = Object.freeze({ Draw: 0, Restore: 1, Propose: 2 } as const);

/** PDA seeds (`constants::*_SEED`). */
export const SEEDS_V22 = Object.freeze({
  bondTranche: "bond_tranche",
  bondPosition: "bond",
  insuranceUnits: "ins_units",
  g9Feeds: "g9_feeds",
} as const);

const U8 = 0xff;
const U16 = 0xffff;
const U32 = 0xffff_ffff;
const U64 = (1n << 64n) - 1n;
const U128 = (1n << 128n) - 1n;

function intIn(name: string, v: number, min: number, max: number): void {
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${name} must be an integer in ${min}..=${max}, got ${v}`);
}
function bigIn(name: string, v: bigint, max: bigint, min = 0n): void {
  if (typeof v !== "bigint" || v < min || v > max) throw new Error(`${name} must be a bigint in ${min}..=${max}, got ${String(v)}`);
}

// ============================================================================
// Tag 0: InitMarket merged trailer grammar  growth(4) [lot(1)] [rent(6) [band(18)]]
// ============================================================================

/** Rent block: `[rent_max_e9_per_slot u32][rent_kink_bps u16]` (6 bytes). */
export interface RentBlockV22 {
  /** `0` = no rent; otherwise `>= 10` and `<= 10_000`. */
  rentMaxE9PerSlot: number;
  /** `<= 8_000` when rent is on. */
  rentKinkBps: number;
}

/** Band block: `[band_bps u16][E u32][Pmax u32][band_min_leg_notional u64]` (18 bytes). */
export interface BandBlockV22 {
  /** `d`, `1..=2000`. */
  bandBps: number;
  /** `E`, `>= 150`. */
  bandMaxEpochSlots: number;
  /** `Pmax`, `>= 8 E`. */
  bandMaxPinSlots: number;
  /** Atoms; `>= 10` whole collateral tokens (the SDK default is 100). */
  bandMinLegNotional: bigint;
}

/** The v2.2 InitMarket trailer. Present fields select the length: 4, 5, 10, 11, 28 or 29 bytes. */
export interface InitMarketTrailerV22 {
  /** `r_gap_bps`; may be 0 ONLY on a band market (derived on chain), otherwise must be non-zero. */
  rGapBps: number;
  /** Creator's launch leverage cap x100, non-zero. */
  lLaunchX100: number;
  /** `lot_exp` `1..=15`; omit for no lot (an odd-length trailer carries the lot byte; 0 is refused). */
  lotExp?: number;
  /** Rent block (required for a band). */
  rent?: RentBlockV22;
  /** Band block (requires `rent`, the grammar is `[rent [band]]`). */
  band?: BandBlockV22;
}

/**
 * Validate a rent block with the wrapper's own bounds (`rent_params_ok`, engine `MAX_RENT_E9_PER_SLOT`).
 *
 * @param r  Rent block.
 * @throws If the program would refuse it (HoldingRentConfigInvalid, 106).
 * @example
 * ```ts
 * assertRentBlockV22({ rentMaxE9PerSlot: 100, rentKinkBps: 5000 });
 * ```
 */
export function assertRentBlockV22(r: RentBlockV22): void {
  intIn("rentMaxE9PerSlot", r.rentMaxE9PerSlot, 0, MAX_RENT_E9_PER_SLOT_V22);
  intIn("rentKinkBps", r.rentKinkBps, 0, U16);
  if (r.rentMaxE9PerSlot !== 0 && (r.rentMaxE9PerSlot < RENT_MIN_E9_PER_SLOT_V22 || r.rentKinkBps > RENT_MAX_KINK_BPS_V22)) {
    throw new Error(`rent block refused (106 HoldingRentConfigInvalid): rentMaxE9PerSlot must be 0 or >= ${RENT_MIN_E9_PER_SLOT_V22} and rentKinkBps <= ${RENT_MAX_KINK_BPS_V22}`);
  }
}

/**
 * Validate a band block with the floors the engine enforces (`V16Config::validate`: d, E, Pmax, the
 * minimum leg notional). `collateralDecimals` is optional; when given, the 10-whole-token floor is checked.
 *
 * @param b  Band block.
 * @param collateralDecimals  Collateral mint decimals (enables the notional floor check).
 * @throws If the program would refuse it (PriceBandConfigInvalid, 105).
 * @example
 * ```ts
 * assertBandBlockV22(bandDefaultsV22(6));
 * ```
 */
export function assertBandBlockV22(b: BandBlockV22, collateralDecimals?: number): void {
  intIn("bandBps", b.bandBps, 1, MAX_BAND_BPS_V22);
  intIn("bandMaxEpochSlots", b.bandMaxEpochSlots, BAND_MIN_EPOCH_SLOTS_V22, U32);
  intIn("bandMaxPinSlots", b.bandMaxPinSlots, 0, U32);
  if (b.bandMaxPinSlots < b.bandMaxEpochSlots * BAND_MIN_PIN_EPOCHS_V22) {
    throw new Error(`bandMaxPinSlots ${b.bandMaxPinSlots} must be >= ${BAND_MIN_PIN_EPOCHS_V22} x bandMaxEpochSlots (${b.bandMaxEpochSlots * BAND_MIN_PIN_EPOCHS_V22}); the program refuses with 105 PriceBandConfigInvalid`);
  }
  bigIn("bandMinLegNotional", b.bandMinLegNotional, U64, 1n);
  if (collateralDecimals !== undefined) {
    intIn("collateralDecimals", collateralDecimals, 0, 30);
    const floor = BigInt(BAND_MIN_LEG_NOTIONAL_TOKENS_V22) * 10n ** BigInt(collateralDecimals);
    if (b.bandMinLegNotional < floor) throw new Error(`bandMinLegNotional ${b.bandMinLegNotional} is below the program floor of ${BAND_MIN_LEG_NOTIONAL_TOKENS_V22} whole tokens (${floor} atoms); refused with 105`);
  }
}

/**
 * The SDK band defaults for a collateral with `collateralDecimals`: d 130, E 600, Pmax 9,000, minimum
 * leg 100 whole tokens.
 *
 * @param collateralDecimals  Collateral mint decimals.
 * @returns A band block.
 * @example
 * ```ts
 * bandDefaultsV22(6).bandMinLegNotional; // 100_000_000n
 * ```
 */
export function bandDefaultsV22(collateralDecimals: number): BandBlockV22 {
  intIn("collateralDecimals", collateralDecimals, 0, 30);
  return {
    bandBps: BAND_DEFAULTS_V22.bandBps,
    bandMaxEpochSlots: BAND_DEFAULTS_V22.bandMaxEpochSlots,
    bandMaxPinSlots: BAND_DEFAULTS_V22.bandMaxPinSlots,
    bandMinLegNotional: BigInt(BAND_DEFAULTS_V22.bandMinLegNotionalTokens) * 10n ** BigInt(collateralDecimals),
  };
}

/**
 * Minutes of keeper absence before a pinned band market is force-recovered: `(E + Pmax) * 0.4 s / 60`.
 * The launch wizard shows this ("Forced recovery after N minutes of keeper absence").
 *
 * @param b  Band block (or any object with the two slot counts).
 * @returns Minutes (fractional).
 * @example
 * ```ts
 * forcedRecoveryMinutesV22({ bandMaxEpochSlots: 600, bandMaxPinSlots: 9000 }); // 64
 * ```
 */
export function forcedRecoveryMinutesV22(b: Pick<BandBlockV22, "bandMaxEpochSlots" | "bandMaxPinSlots">): number {
  return ((b.bandMaxEpochSlots + b.bandMaxPinSlots) * 0.4) / 60;
}

/**
 * Encode ONLY the v2.2 InitMarket trailer (the bytes after the legacy 218-byte body):
 * `growth(4) [lot(1)] [rent(6) [band(18)]]`. Lengths 4, 5, 10, 11, 28, 29; the lot byte is present
 * iff the length is ODD, which keeps the grammar unambiguous with no flag byte.
 * Mirrors `Instruction::decode` tag 0 (`v16_program.rs:8816..8915` of the pinned head).
 *
 * @param t  Trailer fields.
 * @returns The trailer bytes.
 * @throws On any combination the decoder or the program refuses.
 * @example
 * ```ts
 * encodeInitMarketTrailerV22({ rGapBps: 500, lLaunchX100: 550 }); // 4 bytes, the v2.1 growth form
 * ```
 */
export function encodeInitMarketTrailerV22(t: InitMarketTrailerV22): Uint8Array {
  intIn("rGapBps", t.rGapBps, 0, U16);
  intIn("lLaunchX100", t.lLaunchX100, 1, U16);
  if (t.band && !t.rent) throw new Error("a band block requires the rent block (grammar growth [lot] [rent [band]])");
  if (t.rGapBps === 0 && !t.band) throw new Error("rGapBps 0 is only valid on a band market (derived on chain); otherwise it must be non-zero");
  const parts: Uint8Array[] = [encU16(t.rGapBps), encU16(t.lLaunchX100)];
  if (t.lotExp !== undefined) {
    if (t.lotExp === 0) throw new Error("lotExp 0 is the no-lot form: omit it (a lot byte of 0 is refused)");
    intIn("lotExp", t.lotExp, 1, LOT_EXP_MAX_V22);
    parts.push(encU8(t.lotExp));
  }
  if (t.rent) {
    assertRentBlockV22(t.rent);
    parts.push(encU32(t.rent.rentMaxE9PerSlot), encU16(t.rent.rentKinkBps));
    if (t.band) {
      assertBandBlockV22(t.band);
      parts.push(encU16(t.band.bandBps), encU32(t.band.bandMaxEpochSlots), encU32(t.band.bandMaxPinSlots), encU64(t.band.bandMinLegNotional));
    }
  }
  return concatBytes(...parts);
}

/**
 * Tag 0 InitMarket with the v2.2 merged trailer: the existing {@link encodeInitMarket} bytes plus
 * {@link encodeInitMarketTrailerV22}. A band market must be single-asset (`maxPortfolioAssets: 1`);
 * the program refuses otherwise with 105.
 *
 * @param args     Same arguments as {@link encodeInitMarket}.
 * @param trailer  v2.2 trailer fields.
 * @returns Instruction data.
 * @throws On any refused combination.
 * @example
 * ```ts
 * const data = encodeInitMarketV22(args, { rGapBps: 0, lLaunchX100: 550, lotExp: 3, rent: { rentMaxE9PerSlot: 100, rentKinkBps: 5000 }, band: bandDefaultsV22(6) });
 * ```
 */
export function encodeInitMarketV22(args: InitMarketV17Args | InitMarketArgs, trailer: InitMarketTrailerV22): Uint8Array {
  const base = encodeInitMarket(args);
  if (trailer.band) {
    const maxPortfolioAssets = new DataView(base.buffer, base.byteOffset, base.byteLength).getUint16(1, true);
    if (maxPortfolioAssets !== 1) throw new Error(`a band market must be single-asset (maxPortfolioAssets 1), got ${maxPortfolioAssets}; refused with 105`);
  }
  return concatBytes(base, encodeInitMarketTrailerV22(trailer));
}

// ============================================================================
// Wave A: tags 76 / 77
// ============================================================================

/** Tag 76 v2.2 fields. */
export interface RequestRedeemV22Args {
  /** LP shares (u128, > 0). */
  shares: bigint;
  /** The redeemer's payout floor in collateral atoms. MUST be non-zero (review A4). */
  minPayoutAtoms: bigint;
  /** `true` lets anyone execute the request, strictly loss-gated and at the stored floor. */
  keeperOk: boolean;
}

/**
 * RequestRedeemLpShares v2.2: `[76, shares u128, min_payout_atoms u64, keeper_ok u8]` (26 bytes). The
 * request PDA is then created 16 bytes longer (128 bytes, {@link LP_REDEMPTION_V22_ACCOUNT_LEN}).
 * The legacy 17-byte `[76, shares]` is {@link encodeRequestRedeemLpShares} and is unchanged.
 * Mirrors `v16_program.rs:9275..9295` (`min_payout_atoms == 0` or `keeper_ok > 1` is refused).
 *
 * @param a  See {@link RequestRedeemV22Args}.
 * @returns 26 bytes.
 * @example
 * ```ts
 * encodeRequestRedeemLpSharesV22({ shares: 1_000_000n, minPayoutAtoms: 990_000n, keeperOk: false });
 * ```
 */
export function encodeRequestRedeemLpSharesV22(a: RequestRedeemV22Args): Uint8Array {
  bigIn("shares", a.shares, U128, 1n);
  bigIn("minPayoutAtoms", a.minPayoutAtoms, U64, 1n);
  return concatBytes(encU8(IX_TAG_EXTENDED_V22.RequestRedeemLpShares), encU128(a.shares), encU64(a.minPayoutAtoms), encU8(a.keeperOk ? 1 : 0));
}

/** Tag 77 v2.2 fields. */
export interface ExecuteRedemptionV22Args {
  /** Pot the payout is drawn from (u16). */
  domain: number;
  /** Wire payout floor; the program uses `max(wire, stored)`. Non-zero unless `nRefresh > 0`. */
  minPayoutAtoms: bigint;
  /** Number of inline-refresh portfolios at `[13..13+n]`, `0..=8`, and `sum(3 + legs) <= 34`. */
  nRefresh: number;
}

/**
 * ExecuteRedemption v2.2: `[77, domain u16, min_payout_atoms u64, n_refresh u8]` (12 bytes). The legacy
 * 3-byte `[77, domain]` is {@link encodeExecuteRedemption}. The all-zero trailer is refused.
 * Mirrors `v16_program.rs:9296..9314`.
 *
 * @param a  See {@link ExecuteRedemptionV22Args}.
 * @returns 12 bytes.
 * @example
 * ```ts
 * encodeExecuteRedemptionV22({ domain: 0, minPayoutAtoms: 989_505n, nRefresh: 2 });
 * ```
 */
export function encodeExecuteRedemptionV22(a: ExecuteRedemptionV22Args): Uint8Array {
  intIn("domain", a.domain, 0, U16);
  bigIn("minPayoutAtoms", a.minPayoutAtoms, U64);
  intIn("nRefresh", a.nRefresh, 0, REDEMPTION_REFRESH_MAX_V22);
  if (a.minPayoutAtoms === 0n && a.nRefresh === 0) throw new Error("the all-zero tag-77 trailer is refused: send the legacy 3-byte form instead");
  return concatBytes(encU8(IX_TAG_EXTENDED_V22.ExecuteRedemption), encU16(a.domain), encU64(a.minPayoutAtoms), encU8(a.nRefresh));
}

// ============================================================================
// Wave B: tags 106 / 118 / 119
// ============================================================================

/**
 * SettleHoldingRent (tag 106): `[106, asset_index u16, now_slot u64]` (11 bytes). Permissionless.
 * Mirrors `v16_program.rs:9563..9566` (`TAG_SETTLE_HOLDING_RENT`).
 *
 * @param assetIndex  Asset slot.
 * @param nowSlot     The caller's slot (the program uses the authenticated slot when Clock is available).
 * @returns 11 bytes.
 * @example
 * ```ts
 * encodeSettleHoldingRentV22(0, 123_456_789n);
 * ```
 */
export function encodeSettleHoldingRentV22(assetIndex: number, nowSlot: bigint): Uint8Array {
  intIn("assetIndex", assetIndex, 0, U16);
  bigIn("nowSlot", nowSlot, U64);
  return concatBytes(encU8(IX_TAG_V22.SettleHoldingRent), encU16(assetIndex), encU64(nowSlot));
}

/**
 * SweepBandDustLeg (tag 118): `[118, asset_index u16]` (3 bytes). Permissionless. KEEPER NOTE: leave it
 * OFF on any live market whose deployed wrapper predates the bilateral fix (round-2 N-6).
 * Mirrors `v16_program.rs:9567..9569`.
 *
 * @param assetIndex  Asset slot.
 * @returns 3 bytes.
 * @example
 * ```ts
 * encodeSweepBandDustLegV22(0); // [118, 0, 0]
 * ```
 */
export function encodeSweepBandDustLegV22(assetIndex: number): Uint8Array {
  intIn("assetIndex", assetIndex, 0, U16);
  return concatBytes(encU8(IX_TAG_V22.SweepBandDustLeg), encU16(assetIndex));
}

/**
 * EvictAndTradeCpi (tag 119): `[119]` + the body of a TradeCpi (the bytes AFTER its tag 10). Pass the
 * complete TradeCpi instruction data and the tag is swapped.
 * Mirrors `v16_program.rs:9570..9584` (the decoder re-decodes the body as tag 10 and refuses anything else).
 *
 * @param tradeCpiData  Full TradeCpi data (first byte must be 10).
 * @returns Tag-119 data.
 * @throws If the data is not a TradeCpi.
 * @example
 * ```ts
 * const data = encodeEvictAndTradeCpiV22(encodeTradeCpi(args));
 * ```
 */
export function encodeEvictAndTradeCpiV22(tradeCpiData: Uint8Array): Uint8Array {
  if (tradeCpiData.length < 2 || tradeCpiData[0] !== IX_TAG_EXTENDED_V22.TradeCpi) throw new Error("encodeEvictAndTradeCpiV22: data must be a TradeCpi instruction (tag 10)");
  return concatBytes(encU8(IX_TAG_V22.EvictAndTradeCpi), tradeCpiData.subarray(1));
}

// ============================================================================
// Wave C: tags 107..110
// ============================================================================

/** Tag 107 dials; protocol-bounded and IMMUTABLE after creation. */
export interface InitBondTrancheArgs {
  /** Base coupon, bps per year, `0..=2000`. */
  couponBps: number;
  /** Utilisation bonus, bps. MUST be 0 (review L-2). */
  utilBonusBps: number;
  /** Withdrawal cooldown, slots, `9_000..=1_512_000`. */
  cooldownSlots: number;
  /** Concentration cap, bps of `C_eff + junior`, `1..=5000`. */
  capBps: number;
}

/**
 * Validate the tag 107 dials with `bond_v20::bond_config_ok`.
 *
 * @param a  Dials.
 * @throws If the program would refuse them (BondConfigInvalid, 110).
 * @example
 * ```ts
 * assertBondConfigV22({ couponBps: 800, utilBonusBps: 0, cooldownSlots: 9000, capBps: 5000 });
 * ```
 */
export function assertBondConfigV22(a: InitBondTrancheArgs): void {
  intIn("couponBps", a.couponBps, 0, BOND_COUPON_MAX_BPS_V22);
  intIn("utilBonusBps", a.utilBonusBps, 0, BOND_UTIL_BONUS_MAX_BPS_V22);
  intIn("cooldownSlots", a.cooldownSlots, BOND_COOLDOWN_MIN_SLOTS_V22, BOND_COOLDOWN_MAX_SLOTS_V22);
  intIn("capBps", a.capBps, 1, BOND_CAP_MAX_BPS_V22);
}

/**
 * InitBondTranche (tag 107): `[107, coupon_bps u16, util_bonus_bps u16, cooldown_slots u32, cap_bps u16]`
 * (11 bytes). Mirrors `v16_program.rs:9525..9530`.
 *
 * @param a  See {@link InitBondTrancheArgs}.
 * @returns 11 bytes.
 * @example
 * ```ts
 * encodeInitBondTrancheV22({ couponBps: 800, utilBonusBps: 0, cooldownSlots: 9_000, capBps: 5_000 });
 * ```
 */
export function encodeInitBondTrancheV22(a: InitBondTrancheArgs): Uint8Array {
  assertBondConfigV22(a);
  return concatBytes(encU8(IX_TAG_V22.InitBondTranche), encU16(a.couponBps), encU16(a.utilBonusBps), encU32(a.cooldownSlots), encU16(a.capBps));
}

/**
 * BondDeposit (tag 108): `[108, amount u64, min_shares u128]` (25 bytes). Mirrors `v16_program.rs:9531..9534`.
 *
 * @param amount     Collateral atoms (> 0).
 * @param minShares  Slippage floor in bond shares (the program refuses with 124 below it).
 * @returns 25 bytes.
 * @example
 * ```ts
 * encodeBondDepositV22(1_000_000n, 990_000n);
 * ```
 */
export function encodeBondDepositV22(amount: bigint, minShares: bigint): Uint8Array {
  bigIn("amount", amount, U64, 1n);
  bigIn("minShares", minShares, U128);
  return concatBytes(encU8(IX_TAG_V22.BondDeposit), encU64(amount), encU128(minShares));
}

/**
 * BondRequestWithdraw (tag 109): `[109, shares u128]` (17 bytes); 0 cancels. Mirrors `v16_program.rs:9535..9537`.
 *
 * @param shares  Shares to request (`<=` the position's shares; 0 cancels).
 * @returns 17 bytes.
 * @example
 * ```ts
 * encodeBondRequestWithdrawV22(500n);
 * ```
 */
export function encodeBondRequestWithdrawV22(shares: bigint): Uint8Array {
  bigIn("shares", shares, U128);
  return concatBytes(encU8(IX_TAG_V22.BondRequestWithdraw), encU128(shares));
}

/**
 * BondExecuteWithdraw (tag 110): `[110, min_out u64, source_domain u16]` (11 bytes). `source_domain` only
 * matters on a Resolved market. Mirrors `v16_program.rs:9538..9541`.
 *
 * @param minOut        Slippage floor in atoms (124 below it).
 * @param sourceDomain  Pot for a Resolved exit.
 * @returns 11 bytes.
 * @example
 * ```ts
 * encodeBondExecuteWithdrawV22(990_000n, 0);
 * ```
 */
export function encodeBondExecuteWithdrawV22(minOut: bigint, sourceDomain: number): Uint8Array {
  bigIn("minOut", minOut, U64);
  intIn("sourceDomain", sourceDomain, 0, U16);
  return concatBytes(encU8(IX_TAG_V22.BondExecuteWithdraw), encU64(minOut), encU16(sourceDomain));
}

// ============================================================================
// Wave D: tags 111 / 112 / 116 / 117
// ============================================================================

/**
 * InsuranceBackstopDraw (tag 111, G9): `[111, mode u8, max_amount u128]` (18 bytes). `mode` 2 PROPOSE, 0 DRAW
 * (only in `[proposal + 9,000, + 18,000)` slots), 1 RESTORE. Mirrors `v16_program.rs:9542..9545`.
 *
 * @param mode       0 DRAW, 1 RESTORE, 2 PROPOSE (anything else is refused on chain).
 * @param maxAmount  Cap in atoms (`u128::MAX` for "as much as allowed").
 * @returns 18 bytes.
 * @example
 * ```ts
 * encodeInsuranceBackstopDrawV22(BackstopMode.Propose, 0n);
 * ```
 */
export function encodeInsuranceBackstopDrawV22(mode: 0 | 1 | 2, maxAmount: bigint): Uint8Array {
  intIn("mode", mode, 0, 2);
  bigIn("maxAmount", maxAmount, U128);
  return concatBytes(encU8(IX_TAG_V22.InsuranceBackstopDraw), encU8(mode), encU128(maxAmount));
}

/**
 * RescueDeposit (tag 112): `[112, tranche u8, amount u64, min_shares u128]` (26 bytes). Only tranche 0 (the
 * senior Earn vault) is accepted today: the program refuses tranche 1 with 114 although tags 107..110 exist
 * (see the ambiguity list in the PR). Mirrors `v16_program.rs:9546..9550`.
 *
 * @param tranche    0 = senior. Other values are encodable but refused on chain.
 * @param amount     Atoms, `>= 100 tokens` at 6 decimals (`RESCUE_MIN_ATOMS`).
 * @param minShares  Slippage floor in senior shares.
 * @returns 26 bytes.
 * @example
 * ```ts
 * encodeRescueDepositV22(0, 100_000_000n, 90_000_000n);
 * ```
 */
export function encodeRescueDepositV22(tranche: number, amount: bigint, minShares: bigint): Uint8Array {
  intIn("tranche", tranche, 0, U8);
  bigIn("amount", amount, U64, 1n);
  bigIn("minShares", minShares, U128);
  return concatBytes(encU8(IX_TAG_V22.RescueDeposit), encU8(tranche), encU64(amount), encU128(minShares));
}

/**
 * InitInsuranceUnits (tag 116): `[116]` (1 byte). Permissionless; creates the units ledger on first use
 * (Live, single-asset, devnet-pinned stake) and refreshes its snapshot afterwards. Mirrors `v16_program.rs:9551`.
 *
 * @returns 1 byte.
 * @example
 * ```ts
 * encodeInitInsuranceUnitsV22(); // [116]
 * ```
 */
export function encodeInitInsuranceUnitsV22(): Uint8Array {
  return encU8(IX_TAG_V22.InitInsuranceUnits);
}

/**
 * SetG9FeedAllowlist (tag 117): `[117, n u8, keys 32*n]`, `n <= 16` (upgrade authority only). Mirrors
 * `v16_program.rs:9552..9562`.
 *
 * @param keys  Switchboard feed keys (no zero key, no duplicates; the program validates the record).
 * @returns `2 + 32 n` bytes.
 * @example
 * ```ts
 * encodeSetG9FeedAllowlistV22([feedA, feedB]);
 * ```
 */
export function encodeSetG9FeedAllowlistV22(keys: readonly (PublicKey | Uint8Array)[]): Uint8Array {
  if (keys.length > G9_FEED_ALLOWLIST_CAP_V22) throw new Error(`at most ${G9_FEED_ALLOWLIST_CAP_V22} feeds, got ${keys.length}`);
  const raw = keys.map((k) => (k instanceof PublicKey ? k.toBytes() : k));
  const seen = new Set<string>();
  for (const k of raw) {
    if (k.length !== 32) throw new Error("each feed key must be 32 bytes");
    if (k.every((b) => b === 0)) throw new Error("the zero key is not a valid feed");
    const h = Buffer.from(k).toString("hex");
    if (seen.has(h)) throw new Error("duplicate feed key");
    seen.add(h);
  }
  return concatBytes(encU8(IX_TAG_V22.SetG9FeedAllowlist), encU8(raw.length), ...raw);
}

// ============================================================================
// Account lists (names, signer, writable; order = the Rust handler's `account(accounts, i)`)
// ============================================================================

/**
 * Tag 74 CreateLpVault on the v2.2 wrapper (7): the six v2.1 accounts plus `[6]` the market's primary collateral mint (read-only; must
 * equal `config.collateral_mint`, a classic SPL mint). The six-account form is REFUSED (`NotEnoughAccountKeys`); the share mint is
 * created with the collateral mint's decimals. Instruction data is unchanged ({@link encodeCreateLpVaultV17}). Equal to
 * `ACCOUNTS_CREATE_LP_VAULT` of this SDK; kept here so an app that vendors only the v2.2 files has the 7-account list.
 */
export const ACCOUNTS_CREATE_LP_VAULT_V22: readonly AccountSpec[] = [
  { name: "admin", signer: true, writable: true },
  { name: "market", signer: false, writable: true },
  { name: "registry", signer: false, writable: true },
  { name: "lpMint", signer: false, writable: true },
  { name: "systemProgram", signer: false, writable: false },
  { name: "tokenProgram", signer: false, writable: false },
  { name: "collateralMint", signer: false, writable: false },
] as const;

/**
 * Tag 76 RequestRedeemLpShares (8): `v16_program.rs:28751..28770`. The request PDA `[5]` is
 * `["lp_redemption", registry, redeemer]`; with the v2.2 wire it is created 128 bytes long.
 */
export const ACCOUNTS_REQUEST_REDEEM_LP_SHARES_V22: readonly AccountSpec[] = [
  { name: "redeemer", signer: true, writable: true },
  { name: "registry", signer: false, writable: false },
  { name: "lpMint", signer: false, writable: false },
  { name: "redeemerLpAta", signer: false, writable: true },
  { name: "escrow", signer: false, writable: true },
  { name: "redemption", signer: false, writable: true },
  { name: "tokenProgram", signer: false, writable: false },
  { name: "systemProgram", signer: false, writable: false },
] as const;

/**
 * Tag 77 ExecuteRedemption base (13): `v16_program.rs:29708..29740`. `[12]` is the redeemer: a SIGNER on a
 * Live non-bound exit unless the request stored `keeper_ok`. Inline-refresh portfolios (writable) follow at
 * `[13..13+n_refresh]` on a NON-bound Live vault, then the vault asset's oracle accounts. A bound vault keeps
 * `[13]`/`[14]` for `vault_lp_state` / the vault LP portfolio and refuses `n_refresh != 0`.
 */
export const ACCOUNTS_EXECUTE_REDEMPTION_V22: readonly AccountSpec[] = [
  { name: "cranker", signer: true, writable: true },
  { name: "market", signer: false, writable: true },
  { name: "registry", signer: false, writable: true },
  { name: "redemption", signer: false, writable: true },
  { name: "lpMint", signer: false, writable: true },
  { name: "escrow", signer: false, writable: true },
  { name: "vaultToken", signer: false, writable: true },
  { name: "vaultAuthority", signer: false, writable: false },
  { name: "ledger", signer: false, writable: true },
  { name: "redeemerDest", signer: false, writable: true },
  { name: "tokenProgram", signer: false, writable: false },
  { name: "siblingLedger", signer: false, writable: true },
  { name: "redeemer", signer: false, writable: true },
] as const;

/** Tag 106 SettleHoldingRent (4 + oracle accounts): `v16_program.rs:41983..42000`. */
export const ACCOUNTS_SETTLE_HOLDING_RENT_V22: readonly AccountSpec[] = [
  { name: "caller", signer: true, writable: false },
  { name: "market", signer: false, writable: true },
  { name: "portfolio", signer: false, writable: true },
  { name: "vaultLpPortfolio", signer: false, writable: true },
] as const;

/**
 * Tag 118 SweepBandDustLeg (4): `v16_program.rs:24052..24068`. The handler never reads `[0]`; the doc names it
 * the caller, so it is listed as the signer (the fee payer signs regardless).
 */
export const ACCOUNTS_SWEEP_BAND_DUST_LEG_V22: readonly AccountSpec[] = [
  { name: "caller", signer: true, writable: false },
  { name: "market", signer: false, writable: true },
  { name: "portfolio", signer: false, writable: true },
  { name: "vaultLpPortfolio", signer: false, writable: true },
] as const;

/** Tag 119 EvictAndTradeCpi: ONE account prepended to the TradeCpi list (`v16_program.rs:24115..24130`). */
export const ACCOUNTS_EVICT_PREFIX_V22: readonly AccountSpec[] = [{ name: "victimPortfolio", signer: false, writable: true }] as const;

/** Tag 107 InitBondTranche (8, +1 program data when `[0]` is not the marketauth): `v16_program.rs:38045..38075`. */
export const ACCOUNTS_INIT_BOND_TRANCHE_V22: readonly AccountSpec[] = [
  { name: "authority", signer: true, writable: false },
  { name: "market", signer: false, writable: false },
  { name: "registry", signer: false, writable: true },
  { name: "vaultLpState", signer: false, writable: false },
  { name: "vaultLpExt", signer: false, writable: true },
  { name: "bondTranche", signer: false, writable: true },
  { name: "payer", signer: true, writable: true },
  { name: "systemProgram", signer: false, writable: false },
] as const;

/** Tag 108 BondDeposit (13): `v16_program.rs:38227..38250`. */
export const ACCOUNTS_BOND_DEPOSIT_V22: readonly AccountSpec[] = [
  { name: "depositor", signer: true, writable: true },
  { name: "market", signer: false, writable: true },
  { name: "registry", signer: false, writable: false },
  { name: "vaultLpState", signer: false, writable: true },
  { name: "lpPortfolio", signer: false, writable: true },
  { name: "ledger", signer: false, writable: true },
  { name: "siblingLedger", signer: false, writable: true },
  { name: "bondTranche", signer: false, writable: true },
  { name: "bondPosition", signer: false, writable: true },
  { name: "sourceToken", signer: false, writable: true },
  { name: "vaultToken", signer: false, writable: true },
  { name: "tokenProgram", signer: false, writable: false },
  { name: "systemProgram", signer: false, writable: false },
] as const;

/** Tag 109 BondRequestWithdraw (4): `v16_program.rs:38453..38470`. */
export const ACCOUNTS_BOND_REQUEST_WITHDRAW_V22: readonly AccountSpec[] = [
  { name: "holder", signer: true, writable: false },
  { name: "market", signer: false, writable: false },
  { name: "bondTranche", signer: false, writable: false },
  { name: "bondPosition", signer: false, writable: true },
] as const;

/** Tag 110 BondExecuteWithdraw (13): `v16_program.rs:38499..38520`. */
export const ACCOUNTS_BOND_EXECUTE_WITHDRAW_V22: readonly AccountSpec[] = [
  { name: "holder", signer: true, writable: false },
  { name: "market", signer: false, writable: true },
  { name: "registry", signer: false, writable: false },
  { name: "vaultLpState", signer: false, writable: true },
  { name: "lpPortfolio", signer: false, writable: true },
  { name: "ledger", signer: false, writable: true },
  { name: "siblingLedger", signer: false, writable: true },
  { name: "bondTranche", signer: false, writable: true },
  { name: "bondPosition", signer: false, writable: true },
  { name: "destToken", signer: false, writable: true },
  { name: "vaultToken", signer: false, writable: true },
  { name: "vaultAuthority", signer: false, writable: false },
  { name: "tokenProgram", signer: false, writable: false },
] as const;

/**
 * Tag 111 InsuranceBackstopDraw (7 + tail): `v16_program.rs:35894..35935`. The tail (`[7..]`, any order) carries
 * the `InsuranceUnitsV20` account (writable; REQUIRED on a units market) and, for modes 0 and 2 on a mainnet
 * build, the Hybrid legs' feed accounts and the `["g9_feeds"]` allowlist.
 */
export const ACCOUNTS_INSURANCE_BACKSTOP_DRAW_V22: readonly AccountSpec[] = [
  { name: "cranker", signer: true, writable: true },
  { name: "market", signer: false, writable: true },
  { name: "registry", signer: false, writable: false },
  { name: "vaultLpState", signer: false, writable: true },
  { name: "lpPortfolio", signer: false, writable: true },
  { name: "ledger", signer: false, writable: true },
  { name: "siblingLedger", signer: false, writable: true },
] as const;

/** Tag 112 RescueDeposit (11, + bound tail `[11] vault_lp_state (w)`, `[12]` vault LP (w)): `v16_program.rs:36496..36520`. */
export const ACCOUNTS_RESCUE_DEPOSIT_V22: readonly AccountSpec[] = [
  { name: "rescuer", signer: true, writable: true },
  { name: "market", signer: false, writable: true },
  { name: "registry", signer: false, writable: true },
  { name: "lpMint", signer: false, writable: true },
  { name: "rescuerLpAta", signer: false, writable: true },
  { name: "sourceToken", signer: false, writable: true },
  { name: "vaultToken", signer: false, writable: true },
  { name: "ledger", signer: false, writable: true },
  { name: "tokenProgram", signer: false, writable: false },
  { name: "systemProgram", signer: false, writable: false },
  { name: "siblingLedger", signer: false, writable: true },
] as const;

/** Tag 116 InitInsuranceUnits (4): `v16_program.rs:35635..35660`. */
export const ACCOUNTS_INIT_INSURANCE_UNITS_V22: readonly AccountSpec[] = [
  { name: "payer", signer: true, writable: true },
  { name: "market", signer: false, writable: true },
  { name: "insuranceUnits", signer: false, writable: true },
  { name: "systemProgram", signer: false, writable: false },
] as const;

/** Tag 117 SetG9FeedAllowlist (4): `v16_program.rs:35813..35830`. */
export const ACCOUNTS_SET_G9_FEED_ALLOWLIST_V22: readonly AccountSpec[] = [
  { name: "upgradeAuthority", signer: true, writable: true },
  { name: "programData", signer: false, writable: false },
  { name: "g9FeedAllowlist", signer: false, writable: true },
  { name: "systemProgram", signer: false, writable: false },
] as const;

// ============================================================================
// Account tails on EXISTING tags
// ============================================================================

/**
 * Where the bond tranche goes on each existing tag, ONCE the registry's bond flag is set (then it is REQUIRED,
 * fail closed). Equal to the number of accounts the tag has before it.
 *
 * - 78 LpVaultCrankFees: `[6] vault_lp_state`, `[7] ext (w)`, `[8] vault LP portfolio (WRITABLE, N-1)`, `[9] tranche (w)`.
 * - 97 WithdrawJuniorTranche: base 11, `[11] ext`, `[12] tranche`.
 * - 102 VaultLpReleaseSurplus, RESOLVED only: base 7 + the 4 resolved accounts, `[11] tranche`.
 * - 103 VaultLpAllocate: base 9 (`[7] ext`, `[8] system program`), `[9] tranche`.
 *
 * Cited: `load_bond_tranche_if_flagged` call sites `v16_program.rs:31303 (78), 34609 (97), 37461 (102), 36815 (103)`.
 */
export const BOND_TAIL_INDEX_V22 = Object.freeze({ 78: 9, 97: 12, 102: 11, 103: 9 } as const);

/**
 * Where the `InsuranceUnitsV20` account may ride on the asset-0 insurance paths: the program searches
 * `accounts[from..]` for the PDA, so append it LAST. Minimum key counts (tag -> `from`): 9 -> 5, 56 -> 5,
 * 57 -> 6, 41 -> 6, 101 -> 12. Cited: `ins_units_split_tail` sites `v16_program.rs:19374, 19527, 21246, 21449`
 * and `ins_units_find(.., 12)` at `:37149` (tag 101).
 */
export const INSURANCE_UNITS_TAIL_FROM_V22 = Object.freeze({ 9: 5, 56: 5, 57: 6, 41: 6, 101: 12 } as const);

/** The keys of a built instruction (helper for tail builders). */
export interface InstructionLike {
  programId: PublicKey;
  keys: AccountMeta[];
  data: Buffer | Uint8Array;
}

/** `LpRedemptionV16` account length with the legacy wire (header 16 + body 96). */
export const LP_REDEMPTION_LEGACY_ACCOUNT_LEN = 112;
/** `LpRedemptionV16` account length with the v2.2 wire (header 16 + body 96 + `LpRedemptionExtV22` 16). */
export const LP_REDEMPTION_V22_ACCOUNT_LEN = 128;

/**
 * Derive the capacity-bond tranche PDA: `["bond_tranche", market]`.
 *
 * @param programId  Wrapper program id.
 * @param market     Market account.
 * @returns `[pda, bump]`.
 * @example
 * ```ts
 * const [tranche] = deriveBondTrancheV22(programId, market);
 * ```
 */
export function deriveBondTrancheV22(programId: PublicKey, market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from(SEEDS_V22.bondTranche), market.toBuffer()], programId);
}

/**
 * Derive a holder's bond position PDA: `["bond", market, owner]`.
 *
 * @param programId  Wrapper program id.
 * @param market     Market account.
 * @param owner      Bond holder.
 * @returns `[pda, bump]`.
 * @example
 * ```ts
 * const [position] = deriveBondPositionV22(programId, market, wallet);
 * ```
 */
export function deriveBondPositionV22(programId: PublicKey, market: PublicKey, owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from(SEEDS_V22.bondPosition), market.toBuffer(), owner.toBuffer()], programId);
}

/**
 * Derive the insurance-units ledger PDA: `["ins_units", market]`.
 *
 * @param programId  Wrapper program id.
 * @param market     Market account.
 * @returns `[pda, bump]`.
 * @example
 * ```ts
 * const [units] = deriveInsuranceUnitsV22(programId, market);
 * ```
 */
export function deriveInsuranceUnitsV22(programId: PublicKey, market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from(SEEDS_V22.insuranceUnits), market.toBuffer()], programId);
}

/**
 * Derive the global G9 feed allowlist PDA: `["g9_feeds"]`.
 *
 * @param programId  Wrapper program id.
 * @returns `[pda, bump]`.
 * @example
 * ```ts
 * const [list] = deriveG9FeedAllowlistV22(programId);
 * ```
 */
export function deriveG9FeedAllowlistV22(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from(SEEDS_V22.g9Feeds)], programId);
}

/**
 * ProposeG9FeedAllowlist (tag 120): `[120][n u8 <= 16]` then n x `{feed[32], owner[32]}`.
 * @param entries  Up to 16 `{ feed, owner }` pairs.
 * @returns `2 + 64 n` bytes.
 */
export function encodeProposeG9FeedAllowlistV22(entries: { feed: PublicKey; owner: PublicKey }[]): Uint8Array {
  if (entries.length > G9_FEED_ALLOWLIST_CAP_V22) throw new Error(`at most ${G9_FEED_ALLOWLIST_CAP_V22} entries`);
  return concatBytes(encU8(IX_TAG_V22.ProposeG9FeedAllowlist), encU8(entries.length), ...entries.flatMap((e) => [e.feed.toBytes(), e.owner.toBytes()]));
}

/** CommitG9FeedAllowlist (tag 121): `[121]`, no payload. */
export function encodeCommitG9FeedAllowlistV22(): Uint8Array {
  return encU8(IX_TAG_V22.CommitG9FeedAllowlist);
}

/**
 * InitLpShareMetadata (tag 122): `[122][n u8 0..=8][n ticker bytes]`. `n == 0` is the generic form (anyone pays); `n > 0`
 * is the ticker form (marketauth signs; the name is frozen). The ticker must be ASCII, the program's own check decides
 * which characters it accepts (`lp_share_meta_v22.rs`).
 * @param ticker  Empty or 1..=8 ASCII bytes.
 */
export function encodeInitLpShareMetadataV22(ticker = ""): Uint8Array {
  const t = new TextEncoder().encode(ticker);
  if (t.length > 8) throw new Error("ticker is at most 8 bytes");
  return concatBytes(encU8(IX_TAG_V22.InitLpShareMetadata), encU8(t.length), t);
}
