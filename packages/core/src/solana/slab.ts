import { Connection, PublicKey } from "@solana/web3.js";

// =============================================================================
// Browser-compatible read helpers using DataView
// (the npm 'buffer' polyfill lacks readBigUInt64LE / readBigInt64LE)
// =============================================================================

/** Wrap a Uint8Array in a DataView sharing the same underlying buffer. */
function dv(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}
/** Read a single unsigned byte at `off`. */
function readU8(data: Uint8Array, off: number): number {
  return data[off];
}
/** Read a little-endian u16 at `off`. */
function readU16LE(data: Uint8Array, off: number): number {
  return dv(data).getUint16(off, true);
}
/** Read a little-endian u32 at `off`. */
function readU32LE(data: Uint8Array, off: number): number {
  return dv(data).getUint32(off, true);
}
/** Read a little-endian u64 at `off` as a BigInt. */
function readU64LE(data: Uint8Array, off: number): bigint {
  return dv(data).getBigUint64(off, true);
}
/** Read a little-endian signed i64 at `off` as a BigInt. */
function readI64LE(data: Uint8Array, off: number): bigint {
  return dv(data).getBigInt64(off, true);
}

// =============================================================================
// Helper: read signed/unsigned i128 from buffer
// =============================================================================

/**
 * Read a little-endian signed i128 at `offset`.
 * Composed from two u64 halves; sign-extends if the high bit is set.
 */
function readI128LE(buf: Uint8Array, offset: number): bigint {
  const lo = readU64LE(buf, offset);
  const hi = readU64LE(buf, offset + 8);
  const unsigned = (hi << 64n) | lo;
  const SIGN_BIT = 1n << 127n;
  if (unsigned >= SIGN_BIT) {
    return unsigned - (1n << 128n);
  }
  return unsigned;
}

/** Read a little-endian unsigned u128 at `offset` as a BigInt. */
function readU128LE(buf: Uint8Array, offset: number): bigint {
  const lo = readU64LE(buf, offset);
  const hi = readU64LE(buf, offset + 8);
  return (hi << 64n) | lo;
}

// =============================================================================
// Slab Layout Version Detection
// =============================================================================
// The deployed devnet program uses a different struct layout (V0) than the SDK
// was updated for (V1). V1 includes PERC-120/121/122/298/299/300/301/306/328
// struct changes that have NOT been deployed to devnet yet.
//
// V0 (deployed devnet): HEADER=72, CONFIG=408, ENGINE_OFF=480, ACCOUNT_SIZE=240
//   - InsuranceFund: {balance: U128, fee_revenue: U128} (32 bytes)
//   - RiskParams: 56 bytes (basic fields only)
//   - No mark_price, no long_oi/short_oi, no emergency OI cap fields
//   - No partial liquidation field in Account (240 bytes)
//
// V1 (future upgrade): HEADER=104, CONFIG=536, ENGINE_OFF=640, ACCOUNT_SIZE=248
//   - InsuranceFund: expanded with isolation fields (72 bytes)
//   - RiskParams: 288 bytes (premium funding, partial liq, dynamic fees)
//   - Has mark_price, long_oi/short_oi, emergency fields
//   - Account has last_partial_liquidation_slot (248 bytes)
// =============================================================================

const MAGIC: bigint = 0x504552434f4c4154n; // "PERCOLAT"

// Flag bits in header._padding[0] at offset 13
const FLAG_RESOLVED = 1 << 0;

/**
 * Full slab layout descriptor. Returned by detectSlabLayout().
 * All engine field offsets are relative to engineOff.
 */
export interface SlabLayout {
  version: 0 | 1 | 2;
  headerLen: number;
  configOffset: number;
  configLen: number;
  reservedOff: number;          // offset of _reserved in header
  engineOff: number;
  accountSize: number;
  maxAccounts: number;
  bitmapWords: number;
  accountsOff: number;          // absolute offset of accounts array in slab

  // Engine field offsets (relative to engineOff)
  engineInsuranceOff: number;
  engineParamsOff: number;
  paramsSize: number;
  engineCurrentSlotOff: number;
  engineFundingIndexOff: number;
  engineLastFundingSlotOff: number;
  engineFundingRateBpsOff: number;
  engineMarkPriceOff: number;           // -1 if not present (V0)
  engineLastCrankSlotOff: number;
  engineMaxCrankStalenessOff: number;
  engineTotalOiOff: number;
  engineLongOiOff: number;              // -1 if not present (V0)
  engineShortOiOff: number;             // -1 if not present (V0)
  engineCTotOff: number;
  enginePnlPosTotOff: number;
  engineLiqCursorOff: number;
  engineGcCursorOff: number;
  engineLastSweepStartOff: number;
  engineLastSweepCompleteOff: number;
  engineCrankCursorOff: number;
  engineSweepStartIdxOff: number;
  engineLifetimeLiquidationsOff: number;
  engineLifetimeForceClosesOff: number;
  engineNetLpPosOff: number;
  engineLpSumAbsOff: number;
  engineLpMaxAbsOff: number;
  engineLpMaxAbsSweepOff: number;
  engineEmergencyOiModeOff: number;     // -1 if not present (V0)
  engineEmergencyStartSlotOff: number;  // -1 if not present (V0)
  engineLastBreakerSlotOff: number;     // -1 if not present (V0)
  engineBitmapOff: number;              // relative to engineOff
  postBitmap: number;                   // 2 = free_head only (V1D), 18 = num_used + pad + next_account_id + free_head
  acctOwnerOff: number;                 // byte offset of owner pubkey within an account slot

  // Insurance fund layout
  hasInsuranceIsolation: boolean;
  engineInsuranceIsolatedOff: number;   // -1 if not present (V0)
  engineInsuranceIsolationBpsOff: number; // -1 if not present (V0)
}

// ---- V0 layout constants (deployed devnet program) ----
const V0_HEADER_LEN = 72;
const V0_CONFIG_LEN = 408;
const V0_ENGINE_OFF = 480;   // align_up(72 + 408, 8) = 480
const V0_ACCOUNT_SIZE = 240;
const V0_RESERVED_OFF = 48;  // magic(8)+version(4)+bump(1)+pad(3)+admin(32) = 48

// V0 engine: vault(16) + insurance{balance(16),fee_revenue(16)}=32 → params at 48
// V0 RiskParams: 56 bytes → runtime state at 104
const V0_ENGINE_PARAMS_OFF = 48;
const V0_PARAMS_SIZE = 56;
const V0_ENGINE_CURRENT_SLOT_OFF = 104;
const V0_ENGINE_FUNDING_INDEX_OFF = 112;
const V0_ENGINE_LAST_FUNDING_SLOT_OFF = 128;
const V0_ENGINE_FUNDING_RATE_BPS_OFF = 136;
const V0_ENGINE_LAST_CRANK_SLOT_OFF = 144;
const V0_ENGINE_MAX_CRANK_STALENESS_OFF = 152;
const V0_ENGINE_TOTAL_OI_OFF = 160;
const V0_ENGINE_C_TOT_OFF = 176;
const V0_ENGINE_PNL_POS_TOT_OFF = 192;
const V0_ENGINE_LIQ_CURSOR_OFF = 208;
const V0_ENGINE_GC_CURSOR_OFF = 210;
const V0_ENGINE_LAST_SWEEP_START_OFF = 216;
const V0_ENGINE_LAST_SWEEP_COMPLETE_OFF = 224;
const V0_ENGINE_CRANK_CURSOR_OFF = 232;
const V0_ENGINE_SWEEP_START_IDX_OFF = 234;
const V0_ENGINE_LIFETIME_LIQUIDATIONS_OFF = 240;
const V0_ENGINE_LIFETIME_FORCE_CLOSES_OFF = 248;
const V0_ENGINE_NET_LP_POS_OFF = 256;
const V0_ENGINE_LP_SUM_ABS_OFF = 272;
const V0_ENGINE_LP_MAX_ABS_OFF = 288;
const V0_ENGINE_LP_MAX_ABS_SWEEP_OFF = 304;
const V0_ENGINE_BITMAP_OFF = 320;

// ---- V1 layout constants (deployed devnet program, PERC-1094 corrected) ----
// BPF (SBF) target: u128 alignment = 8, so CONFIG_LEN = 496 on-chain.
// ENGINE_OFF = align_up(HEADER=104 + CONFIG=496, 8) = 600.
// Previous value (640) was wrong — it assumed CONFIG_LEN=536 from the native build assertion.
const V1_HEADER_LEN = 104;
const V1_CONFIG_LEN = 496;   // BPF (SBF) on-chain value; native test build would be 512
const V1_ENGINE_OFF = 600;   // align_up(104 + 496, 8) = 600  (was 640 — corrected in PERC-1094)
// Legacy: CONFIG_LEN=536 was used in pre-PERC-1094 SDK. Some orphaned slabs on devnet may use
// ENGINE_OFF=640 (65352 bytes for small). We add them to V1_SIZES_LEGACY for read-only parsing.
const V1_ENGINE_OFF_LEGACY = 640;
const V1_ACCOUNT_SIZE = 248;
const V1_RESERVED_OFF = 80;

// V1 engine: vault(16) + insurance expanded(56) → params at 72
// V1 RiskParams: 288 bytes → runtime state at 360
const V1_ENGINE_PARAMS_OFF = 72;
const V1_PARAMS_SIZE = 288;
const V1_ENGINE_CURRENT_SLOT_OFF = 360;
const V1_ENGINE_FUNDING_INDEX_OFF = 368;
const V1_ENGINE_LAST_FUNDING_SLOT_OFF = 384;
const V1_ENGINE_FUNDING_RATE_BPS_OFF = 392;
const V1_ENGINE_MARK_PRICE_OFF = 400;
const V1_ENGINE_LAST_CRANK_SLOT_OFF = 424;
const V1_ENGINE_MAX_CRANK_STALENESS_OFF = 432;
const V1_ENGINE_TOTAL_OI_OFF = 440;
const V1_ENGINE_LONG_OI_OFF = 456;
const V1_ENGINE_SHORT_OI_OFF = 472;
const V1_ENGINE_C_TOT_OFF = 488;
const V1_ENGINE_PNL_POS_TOT_OFF = 504;
const V1_ENGINE_LIQ_CURSOR_OFF = 520;
const V1_ENGINE_GC_CURSOR_OFF = 522;
const V1_ENGINE_LAST_SWEEP_START_OFF = 528;
const V1_ENGINE_LAST_SWEEP_COMPLETE_OFF = 536;
const V1_ENGINE_CRANK_CURSOR_OFF = 544;
const V1_ENGINE_SWEEP_START_IDX_OFF = 546;
const V1_ENGINE_LIFETIME_LIQUIDATIONS_OFF = 552;
const V1_ENGINE_LIFETIME_FORCE_CLOSES_OFF = 560;
const V1_ENGINE_NET_LP_POS_OFF = 568;
const V1_ENGINE_LP_SUM_ABS_OFF = 584;
const V1_ENGINE_LP_MAX_ABS_OFF = 600;
const V1_ENGINE_LP_MAX_ABS_SWEEP_OFF = 616;
const V1_ENGINE_EMERGENCY_OI_MODE_OFF = 632;
const V1_ENGINE_EMERGENCY_START_SLOT_OFF = 640;
const V1_ENGINE_LAST_BREAKER_SLOT_OFF = 648;
const V1_ENGINE_BITMAP_OFF = 656;
// On-chain V1_LEGACY slabs (65352 bytes) place the bitmap 16 bytes later than
// computeSlabSize predicts (formula bitmapOff=656 gives size=65352 correctly, but
// the deployed program stores the bitmap at rel=672 and the owner field at +200).
// These corrected values must be used for actual byte-level parsing.
const V1_LEGACY_ENGINE_BITMAP_OFF_ACTUAL = 672;  // relative to engineOff (abs = 640+672 = 1312)
const V1_LEGACY_ACCT_OWNER_OFF = 200;            // vs the usual ACCT_OWNER_OFF=184

// ---- V1D layout constants (actually deployed devnet V1 program, rev ac18a0e) ----
// The deployed V1 program has a DIFFERENT struct layout than the V1 constants above.
// Key differences:
//   - MarketConfig is smaller (BPF CONFIG_LEN=320 vs V1's 496) — older revision
//   - InsuranceFund is 80 bytes (V1 assumed 56), so params starts at engine+96 (not 72)
//   - Engine lacks lp_max_abs, lp_max_abs_sweep, emergency_oi, trade_twap fields
//   - Bitmap at engine+624 (not 656)
// Confirmed by on-chain probing of slab 6ZytbpV4 (the only active V1 market).
const V1D_CONFIG_LEN = 320;
const V1D_ENGINE_OFF = 424;   // align_up(104 + 320, 8) = 424
const V1D_ACCOUNT_SIZE = 248;

// V1D engine field offsets (relative to engineOff):
// vault(16) + InsuranceFund(80) → params at 96; RiskParams(288) → runtime at 384
const V1D_ENGINE_INSURANCE_OFF = 16;
const V1D_ENGINE_PARAMS_OFF = 96;
const V1D_PARAMS_SIZE = 288;
const V1D_ENGINE_CURRENT_SLOT_OFF = 384;
const V1D_ENGINE_FUNDING_INDEX_OFF = 392;
const V1D_ENGINE_LAST_FUNDING_SLOT_OFF = 408;
const V1D_ENGINE_FUNDING_RATE_BPS_OFF = 416;
const V1D_ENGINE_MARK_PRICE_OFF = 424;
// funding_frozen(1+7pad) at 432, funding_frozen_rate(8) at 440
const V1D_ENGINE_LAST_CRANK_SLOT_OFF = 448;
const V1D_ENGINE_MAX_CRANK_STALENESS_OFF = 456;
const V1D_ENGINE_TOTAL_OI_OFF = 464;
const V1D_ENGINE_LONG_OI_OFF = 480;
const V1D_ENGINE_SHORT_OI_OFF = 496;
const V1D_ENGINE_C_TOT_OFF = 512;
const V1D_ENGINE_PNL_POS_TOT_OFF = 528;
const V1D_ENGINE_LIQ_CURSOR_OFF = 544;
const V1D_ENGINE_GC_CURSOR_OFF = 546;
const V1D_ENGINE_LAST_SWEEP_START_OFF = 552;
const V1D_ENGINE_LAST_SWEEP_COMPLETE_OFF = 560;
const V1D_ENGINE_CRANK_CURSOR_OFF = 568;
const V1D_ENGINE_SWEEP_START_IDX_OFF = 570;
const V1D_ENGINE_LIFETIME_LIQUIDATIONS_OFF = 576;
const V1D_ENGINE_LIFETIME_FORCE_CLOSES_OFF = 584;
const V1D_ENGINE_NET_LP_POS_OFF = 592;
const V1D_ENGINE_LP_SUM_ABS_OFF = 608;
// lp_max_abs, lp_max_abs_sweep, emergency_*, trade_twap_* do NOT exist in this version
const V1D_ENGINE_BITMAP_OFF = 624;

// ---- V2 layout constants (BPF intermediate layout, ENGINE_OFF=600, BITMAP_OFF=432) ----
// V2 shares ENGINE_OFF=600 with V1, but has a completely different engine struct layout:
//   - CONFIG_LEN=496 (same as V1 on-chain), HEADER_LEN=104, ACCOUNT_SIZE=248
//   - Engine lacks mark_price, long_oi, short_oi, emergency OI fields
//   - Different field offsets than V1D (which has ENGINE_OFF=424)
// V2 is identified by reading the version field at slab header offset 8 (u32 LE) == 2.
// Without data, V2 cannot be distinguished from V1D by size alone (postBitmap=18 produces
// identical sizes to V1D postBitmap=2 — both 65088 for 256 accounts).
const V2_HEADER_LEN = 104;
const V2_CONFIG_LEN = 496;
const V2_ENGINE_OFF = 600;    // align_up(104 + 496, 8) = 600
const V2_ACCOUNT_SIZE = 248;
const V2_ENGINE_BITMAP_OFF = 432;

// V2 engine field offsets (relative to engineOff)
const V2_ENGINE_CURRENT_SLOT_OFF = 352;
const V2_ENGINE_FUNDING_INDEX_OFF = 360;
const V2_ENGINE_LAST_FUNDING_SLOT_OFF = 376;
const V2_ENGINE_FUNDING_RATE_BPS_OFF = 384;
const V2_ENGINE_LAST_CRANK_SLOT_OFF = 392;
const V2_ENGINE_MAX_CRANK_STALENESS_OFF = 400;
const V2_ENGINE_TOTAL_OI_OFF = 408;
const V2_ENGINE_C_TOT_OFF = 424;
const V2_ENGINE_PNL_POS_TOT_OFF = 440;
const V2_ENGINE_LIQ_CURSOR_OFF = 456;
const V2_ENGINE_GC_CURSOR_OFF = 458;
const V2_ENGINE_LAST_SWEEP_START_OFF = 464;
const V2_ENGINE_LAST_SWEEP_COMPLETE_OFF = 472;
const V2_ENGINE_CRANK_CURSOR_OFF = 480;
const V2_ENGINE_SWEEP_START_IDX_OFF = 482;
const V2_ENGINE_LIFETIME_LIQUIDATIONS_OFF = 488;
const V2_ENGINE_LIFETIME_FORCE_CLOSES_OFF = 496;
const V2_ENGINE_NET_LP_POS_OFF = 504;
const V2_ENGINE_LP_SUM_ABS_OFF = 520;
const V2_ENGINE_LP_MAX_ABS_OFF = 536;
const V2_ENGINE_LP_MAX_ABS_SWEEP_OFF = 552;

// ---- V_ADL layout constants (ADL-upgraded program, PERC-8270/8271) ----
// This layout corresponds to the percolator lib at commit ed01137 (PERC-8270) which adds:
//   - Account: position_basis_q(i128,16)+adl_a_basis(u128,16)+adl_k_snap(i128,16)+adl_epoch_snap(u64,8) = +56 bytes
//     Plus 8-byte padding before position_basis_q (i128 requires 16-byte align on BPF) → +64 bytes/account
//   - RiskEngine: last_market_slot(u64)+funding_price_sample_last(u64)+materialized_account_count(u64)+last_oracle_price(u64) = +32 bytes
//   - Also adds: InsuranceFund expanded to 80 bytes (balance_incentive_reserve + _rebate_pad + _isolation_padding),
//     RiskParams expanded to 336 bytes (min_nonzero_mm_req, min_nonzero_im_req, insurance_floor, etc.),
//     pnl_matured_pos_tot(u128,16) field in RiskEngine (PERC-8267),
//     ADL side state fields (PERC-8268, +224 bytes engine before bitmap)
//
// BPF SLAB_LEN: 1288304 (large/4096-account tier) — verified by cargo build-sbf (PERC-8271)
// ENGINE_OFF = 624 (HEADER=104 + CONFIG=520 native, aligned to 8 = 624)
// ACCOUNT_SIZE = 312 (248 old + 8 pad for i128 alignment + 16+16+16+8 new ADL fields)
// ENGINE_BITMAP_OFF = 1008 (empirically verified: mainnet CCTegYZ... slab, 323312 bytes, 1024 accts)
// Prior value of 1006 was an arithmetic transcription error.
// Derivation: trade_twap_e6(8)@992 + twap_last_slot(8)@1000 = bitmap@1008.
const V_ADL_ENGINE_OFF = 624;      // align_up(HEADER=104 + CONFIG=520, 8) = 624
const V_ADL_CONFIG_LEN = 520;      // BPF/native MarketConfig with current fields (pre-SetDexPool)

// V_SETDEXPOOL: PERC-SetDexPool security fix — adds dex_pool: [u8; 32] to MarketConfig.
// BPF CONFIG_LEN: 496→528 (+32). ENGINE_OFF: align_up(104+528,8) = 632 (+8 from V_ADL=624).
// Engine struct and account layout are identical to V_ADL — only CONFIG_LEN/ENGINE_OFF changed.
const V_SETDEXPOOL_CONFIG_LEN = 544;   // SBF on-chain CONFIG_LEN after PERC-SetDexPool (target_arch=sbf uses native alignment)
const V_SETDEXPOOL_ENGINE_OFF = 648;   // align_up(HEADER=104 + CONFIG=544, 8) = 648
// All engine field offsets are identical to V_ADL (same engine struct, only engineOff differs).
const V_ADL_ACCOUNT_SIZE = 312;    // 248 + 8(pad) + 56(new ADL fields) = 312 bytes
const V_ADL_ENGINE_PARAMS_OFF = 96; // vault(16) + InsuranceFund(80) = 96

// V_ADL RiskParams: 336 bytes (same as V1M, includes all dynamic fee params)
const V_ADL_PARAMS_SIZE = 336;

// V_ADL engine field offsets (relative to engineOff=624):
// vault(16) + InsuranceFund(80) + RiskParams(336) = 432 bytes before current_slot
const V_ADL_ENGINE_CURRENT_SLOT_OFF = 432;     // 96 + 336 = 432
const V_ADL_ENGINE_FUNDING_INDEX_OFF = 440;    // 432 + 8
const V_ADL_ENGINE_LAST_FUNDING_SLOT_OFF = 456; // 440 + 16
const V_ADL_ENGINE_FUNDING_RATE_BPS_OFF = 464; // 456 + 8
// PERC-8270 new fields at 472-504:
// last_market_slot(8)@472, funding_price_sample_last(8)@480, materialized_account_count(8)@488, last_oracle_price(8)@496
const V_ADL_ENGINE_MARK_PRICE_OFF = 504;       // 464+8+32 = 504 (shifted +104 from V1's 400)
// funding_frozen(1+7pad=8)@512, funding_frozen_rate_snapshot(i64,8)@520
const V_ADL_ENGINE_LAST_CRANK_SLOT_OFF = 528;  // was 424 in V1, +104
const V_ADL_ENGINE_MAX_CRANK_STALENESS_OFF = 536;
const V_ADL_ENGINE_TOTAL_OI_OFF = 544;         // was 440 in V1, +104
const V_ADL_ENGINE_LONG_OI_OFF = 560;          // was 456 in V1, +104
const V_ADL_ENGINE_SHORT_OI_OFF = 576;         // was 472 in V1, +104
const V_ADL_ENGINE_C_TOT_OFF = 592;            // was 488 in V1, +104
const V_ADL_ENGINE_PNL_POS_TOT_OFF = 608;      // was 504 in V1, +104
// pnl_matured_pos_tot(u128,16)@624 — NEW in PERC-8267
const V_ADL_ENGINE_LIQ_CURSOR_OFF = 640;       // was 520 in V1, +120 (extra 16 for pnl_matured)
const V_ADL_ENGINE_GC_CURSOR_OFF = 642;
// last_sweep_start(u64)@648, last_sweep_complete(u64)@656, crank_cursor(u16)@664, sweep_idx(u16)@666
const V_ADL_ENGINE_LAST_SWEEP_START_OFF = 648;
const V_ADL_ENGINE_LAST_SWEEP_COMPLETE_OFF = 656;
const V_ADL_ENGINE_CRANK_CURSOR_OFF = 664;
const V_ADL_ENGINE_SWEEP_START_IDX_OFF = 666;
// lifetime_liquidations(u64)@672, lifetime_force_closes(u64)@680
const V_ADL_ENGINE_LIFETIME_LIQUIDATIONS_OFF = 672;
const V_ADL_ENGINE_LIFETIME_FORCE_CLOSES_OFF = 680;
// ADL side state (PERC-8268, 224 bytes):
// adl_mult_long/short(16ea), adl_coeff_long/short(16ea), adl_epoch_long/short(8ea),
// adl_epoch_start_k_long/short(16ea), oi_eff_long/short_q(16ea),
// side_mode_long(u8)+side_mode_short(u8)+pad(6), stored_pos_count×2, stale_count×2(all u64,8),
// phantom_dust_bound_long/short_q(16ea) = 224 bytes at offsets 688–911
// Then LP aggregates:
const V_ADL_ENGINE_NET_LP_POS_OFF = 904;       // after ADL side state
const V_ADL_ENGINE_LP_SUM_ABS_OFF = 920;
const V_ADL_ENGINE_LP_MAX_ABS_OFF = 936;
const V_ADL_ENGINE_LP_MAX_ABS_SWEEP_OFF = 952;
// emergency fields:
const V_ADL_ENGINE_EMERGENCY_OI_MODE_OFF = 968;
const V_ADL_ENGINE_EMERGENCY_START_SLOT_OFF = 976;
const V_ADL_ENGINE_LAST_BREAKER_SLOT_OFF = 984;
// trade_twap_e6(8)@992, twap_last_slot(8)@1000, bitmap([u64;N])@1008
// Corrected from 1006 → 1008: 992+8(trade_twap_e6)+8(twap_last_slot)=1008. Arithmetic
// transcription error in prior constant — 1008+512+18+8192=9730 rounds to 9736 (8-byte align),
// but empirically mainnet CCTegYZ... slab (323312 bytes, 1024 accts) confirms bitmapOff=1008.
const V_ADL_ENGINE_BITMAP_OFF = 1008;           // Empirically verified: mainnet slab CCTegYZ...

// V_ADL account field offsets (relative to account slot start):
// account_id(8)+capital(U128,16)+kind(u8+pad7=8)+pnl(I128,16)+reserved_pnl(u128,16)=64
const V_ADL_ACCT_WARMUP_STARTED_OFF = 64;      // was 56
const V_ADL_ACCT_WARMUP_SLOPE_OFF = 72;        // was 64
const V_ADL_ACCT_POSITION_SIZE_OFF = 88;       // was 80
const V_ADL_ACCT_ENTRY_PRICE_OFF = 104;        // was 96
const V_ADL_ACCT_FUNDING_INDEX_OFF = 112;      // was 104
const V_ADL_ACCT_MATCHER_PROGRAM_OFF = 128;    // was 120
const V_ADL_ACCT_MATCHER_CONTEXT_OFF = 160;    // was 152
const V_ADL_ACCT_OWNER_OFF = 192;              // was 184 (shifted +8 from reserved_pnl u64→u128)
const V_ADL_ACCT_FEE_CREDITS_OFF = 224;        // was 216
const V_ADL_ACCT_LAST_FEE_SLOT_OFF = 240;      // was 232

// ---- V12_1 layout constants (percolator-core v12.1 merge) ----
// Account struct grew: 312→320 bytes on SBF (new fields: position_basis_q, adl_a_basis,
// adl_k_snap, adl_epoch_snap, fees_earned_total; fee_credits/last_fee_slot reordered).
// RiskParams grew: 336→352 bytes on SBF (new fields: min_initial_deposit, insurance_floor,
// risk_reduction_threshold, liquidation_buffer_bps, funding premium params, partial liq,
// dynamic fee tiers, fee splits).
// Engine field ordering completely reorganized from V_ADL.
// All values verified by cargo build-sbf compile-time assertions.
const V12_1_ENGINE_OFF = 648;      // align_up(104 + 544, 8) = 648 (same as V_SETDEXPOOL)
const V12_1_ACCOUNT_SIZE = 320;    // aarch64 size (320). SBF uses 280 due to u128 align diff.
const V12_1_ACCOUNT_SIZE_SBF = 280; // Empirically verified from mainnet SLAB_LEN
const V12_1_ENGINE_BITMAP_OFF = 1016; // RiskParams grew 16 bytes + lifetime_force_realize_closes added
const V12_1_ENGINE_PARAMS_OFF = 96;   // vault(16) + InsuranceFund(80) = 96
const V12_1_PARAMS_SIZE = 352;        // 336 + 16 (new fields)
// Engine field offsets (relative to engineOff):
const V12_1_ENGINE_CURRENT_SLOT_OFF = 448;
const V12_1_ENGINE_FUNDING_RATE_BPS_OFF = 456; // funding_rate_bps_per_slot_last
const V12_1_ENGINE_LAST_CRANK_SLOT_OFF = 464;
const V12_1_ENGINE_MAX_CRANK_STALENESS_OFF = 472;
const V12_1_ENGINE_C_TOT_OFF = 480;
const V12_1_ENGINE_PNL_POS_TOT_OFF = 496;
// pnl_matured_pos_tot(u128)@512
const V12_1_ENGINE_LIQ_CURSOR_OFF = 528;
const V12_1_ENGINE_GC_CURSOR_OFF = 530;
const V12_1_ENGINE_LAST_SWEEP_START_OFF = 536;
const V12_1_ENGINE_LAST_SWEEP_COMPLETE_OFF = 544;
const V12_1_ENGINE_CRANK_CURSOR_OFF = 552;
const V12_1_ENGINE_SWEEP_START_IDX_OFF = 554;
const V12_1_ENGINE_LIFETIME_LIQUIDATIONS_OFF = 560;
// ADL side state at 568–815 (not directly read by SDK)
const V12_1_ENGINE_TOTAL_OI_OFF = 816;
const V12_1_ENGINE_LONG_OI_OFF = 832;
const V12_1_ENGINE_SHORT_OI_OFF = 848;
const V12_1_ENGINE_NET_LP_POS_OFF = 864;
const V12_1_ENGINE_LP_SUM_ABS_OFF = 880;
const V12_1_ENGINE_LP_MAX_ABS_OFF = 896;
const V12_1_ENGINE_LP_MAX_ABS_SWEEP_OFF = 912;
const V12_1_ENGINE_MARK_PRICE_OFF = 928;
const V12_1_ENGINE_FUNDING_INDEX_OFF = 936;
const V12_1_ENGINE_LAST_FUNDING_SLOT_OFF = 944;
// funding_frozen(bool)@952, pad@953-959, funding_frozen_rate_snapshot(i64)@960
const V12_1_ENGINE_EMERGENCY_OI_MODE_OFF = 968;
const V12_1_ENGINE_EMERGENCY_START_SLOT_OFF = 976;
const V12_1_ENGINE_LAST_BREAKER_SLOT_OFF = 984;
// trade_twap_e6(8)@992, twap_last_slot(8)@1000, lifetime_force_realize_closes(8)@1008
const V12_1_ENGINE_LIFETIME_FORCE_CLOSES_OFF = 1008;
// bitmap at 1016
// V12_1 account field offsets (relative to account slot start):
// New fields position_basis_q(i128@88), adl_a_basis(u128@104), adl_k_snap(i128@120),
// adl_epoch_snap(u64@136) inserted before matcher_*, shifting everything from offset 128+ by +16.
const V12_1_ACCT_MATCHER_PROGRAM_OFF = 144; // was 128 in V_ADL (+16 from new ADL fields)
const V12_1_ACCT_MATCHER_CONTEXT_OFF = 176; // was 160 in V_ADL (+16 from new ADL fields)
const V12_1_ACCT_OWNER_OFF = 208;           // was 192 in V_ADL (+16 from new ADL fields)
const V12_1_ACCT_FEE_CREDITS_OFF = 240;     // was 224 in V_ADL
const V12_1_ACCT_LAST_FEE_SLOT_OFF = 256;   // was 240 in V_ADL
// SBF offsets (empirically verified via repr(C) with u128 align=8):
// position_basis_q is at offset 88 on SBF (between warmup_slope_per_step and adl_a_basis)
// entry_price was REMOVED from Account in V12_1 upstream rebase
const V12_1_ACCT_POSITION_SIZE_OFF = 88;     // position_basis_q: i128 at offset 88 (SBF)
const V12_1_ACCT_ENTRY_PRICE_OFF = -1;       // REMOVED in V12_1 — does not exist
const V12_1_ACCT_FUNDING_INDEX_OFF = 288;    // moved to end (legacy, i64 not i128)

// ---- V1M layout constants (mainnet-deployed V1 program, ESa89R5) ----
// The mainnet program has a LARGER RiskParams (336 bytes vs V1's 288) and 22 extra
// bytes in the runtime state (trade_twap_e6 + twap_last_slot + alignment padding).
// ENGINE_OFF=640 (same as V1_LEGACY), CONFIG_LEN=536, ACCOUNT_SIZE=248.
// Confirmed by byte-level probing of mainnet slab 8NY7rvQ (SOL/USDC Perpetual).
const V1M_ENGINE_OFF = 640;      // align_up(104 + 536, 8) = 640  (same as V1_LEGACY)
const V1M_CONFIG_LEN = 536;      // MarketConfig size in native/mainnet build
const V1M_ACCOUNT_SIZE = 248;
// V1M2: rebuilt from main@4861c56, CONFIG_LEN=512 on SBF → ENGINE_OFF=616
const V1M2_ENGINE_OFF = 616;     // align_up(104 + 512, 8) = 616
const V1M2_CONFIG_LEN = 512;     // MarketConfig with u128 native alignment on SBF
const V1M_ENGINE_PARAMS_OFF = 72; // vault(16) + InsuranceFund(56) = 72  (same as V1)
const V1M2_ENGINE_PARAMS_OFF = 96; // vault(16) + InsuranceFund(80) = 96  (expanded in main@4861c56)

// V1M RiskParams: 336 bytes (+48 over V1's 288)
//   Extra fields: fee_utilization_surge_bps(8) [in SDK V1 already? no → +8],
//   balance_incentive_reserve configs (+8?), min_nonzero_mm_req(u128=16),
//   min_nonzero_im_req(u128=16) = +48 total
const V1M_PARAMS_SIZE = 336;

// V1M runtime state starts at engine+408 (72 + 336) instead of V1's +360
const V1M_ENGINE_CURRENT_SLOT_OFF = 408;
const V1M_ENGINE_FUNDING_INDEX_OFF = 416;
const V1M_ENGINE_LAST_FUNDING_SLOT_OFF = 432;
const V1M_ENGINE_FUNDING_RATE_BPS_OFF = 440;
const V1M_ENGINE_MARK_PRICE_OFF = 448;
// funding_frozen(1+7pad) at 456, funding_frozen_rate(8) at 464
const V1M_ENGINE_LAST_CRANK_SLOT_OFF = 472;
const V1M_ENGINE_MAX_CRANK_STALENESS_OFF = 480;
const V1M_ENGINE_TOTAL_OI_OFF = 488;
const V1M_ENGINE_LONG_OI_OFF = 504;
const V1M_ENGINE_SHORT_OI_OFF = 520;
const V1M_ENGINE_C_TOT_OFF = 536;
const V1M_ENGINE_PNL_POS_TOT_OFF = 552;
const V1M_ENGINE_LIQ_CURSOR_OFF = 568;
const V1M_ENGINE_GC_CURSOR_OFF = 570;
const V1M_ENGINE_LAST_SWEEP_START_OFF = 576;
const V1M_ENGINE_LAST_SWEEP_COMPLETE_OFF = 584;
const V1M_ENGINE_CRANK_CURSOR_OFF = 592;
const V1M_ENGINE_SWEEP_START_IDX_OFF = 594;
const V1M_ENGINE_LIFETIME_LIQUIDATIONS_OFF = 600;
const V1M_ENGINE_LIFETIME_FORCE_CLOSES_OFF = 608;
const V1M_ENGINE_NET_LP_POS_OFF = 616;
const V1M_ENGINE_LP_SUM_ABS_OFF = 632;
const V1M_ENGINE_LP_MAX_ABS_OFF = 648;
const V1M_ENGINE_LP_MAX_ABS_SWEEP_OFF = 664;
const V1M_ENGINE_EMERGENCY_OI_MODE_OFF = 680;
const V1M_ENGINE_EMERGENCY_START_SLOT_OFF = 688;
const V1M_ENGINE_LAST_BREAKER_SLOT_OFF = 696;
// trade_twap_e6(8) at 704, twap_last_slot(8) at 712 → bitmap at 720
// No padding between twap_last_slot and used bitmap (u64 array is 8-byte
// aligned and 720 % 8 == 0). Previous value of 726 was wrong — 726 % 8 = 6
// which is invalid for a [u64; N] array under #[repr(C)].
const V1M_ENGINE_BITMAP_OFF = 720;

// V1M2: mainnet program rebuilt from main@4861c56 with --features medium.
// ENGINE_OFF=616 (not 640): CONFIG_LEN=512 on SBF because cfg(target_arch="bpf")
// doesn't match the SBF toolchain (target_arch="sbf"), so u128 align=16 (native) applies.
// align_up(HEADER=104 + CONFIG=512, 8) = 616.
// Slab sizes match V_ADL exactly — disambiguation required via data inspection.
// Confirmed by on-chain probing of slab 7T1Efij9 (SOL-PERP, 323312 bytes, medium tier).
// Engine struct is larger than V1M (990 vs 720 bitmap offset = +270 runtime bytes).
// New runtime fields inserted between fundingRateBps and markPrice:
//   +408: currentSlot, +416: fundingIndex(i128), +432: lastFundingSlot, +440: fundingRateBps
//   +448: NEW lastOracleUpdateSlot(?), +456: authorityPriceE6(?), +464-471: reserved
//   +472: lastEffectivePriceE6(?), +480: markPriceE6, +488-503: reserved
//   +504: lastCrankSlot, +512: maxCrankStaleness
const V1M2_ACCOUNT_SIZE = 312;        // 248 + 64 bytes of new fields per account
// V1M2 bitmap offset: empirically verified from mainnet slab CCTegYZ... (323312 bytes, 1024 accts).
// The V1M2 engine struct is layout-identical to V_ADL — same relative field offsets from engineOff.
// V_ADL_ENGINE_BITMAP_OFF (1008) is correct for V1M2 as well; prior value of 990 was wrong.
const V1M2_ENGINE_BITMAP_OFF = 1008;  // Same as V_ADL_ENGINE_BITMAP_OFF — V1M2 uses V_ADL engine struct

// For backward compatibility, export ENGINE_OFF and ENGINE_MARK_PRICE_OFF
// (used by reinit-slab and other scripts). These refer to V1 layout.
export const ENGINE_OFF = V1_ENGINE_OFF;
export const ENGINE_MARK_PRICE_OFF = V1_ENGINE_MARK_PRICE_OFF;

// ---- Known slab sizes per version and tier ----

/**
 * Compute the total byte size of a slab given its layout parameters.
 * Used to pre-populate the known-size lookup maps at module load time.
 */
function computeSlabSize(
  engineOff: number,
  bitmapOff: number,
  accountSize: number,
  maxAccounts: number,
  // postBitmap bytes immediately after the free-slot bitmap:
  //   SDK default (V0/V1/V1-legacy): 18 = num_used(u16,2) + pad(6) + next_account_id(u64,8) + free_head(u16,2)
  //   V1D deployed program:            2 = free_head(u16,2) only — no num_used, pad, or next_account_id
  postBitmap = 18,
): number {
  const bitmapWords = Math.ceil(maxAccounts / 64);
  const bitmapBytes = bitmapWords * 8;
  const nextFreeBytes = maxAccounts * 2;
  const preAccountsLen = bitmapOff + bitmapBytes + postBitmap + nextFreeBytes;
  const accountsOff = Math.ceil(preAccountsLen / 8) * 8;
  return engineOff + accountsOff + maxAccounts * accountSize;
}

const TIERS = [64, 256, 1024, 4096] as const;

// Pre-compute known slab sizes for fast lookup
const V0_SIZES = new Map<number, number>();
const V1_SIZES = new Map<number, number>();
// Legacy V1 sizes using incorrect ENGINE_OFF=640 (pre-PERC-1094). Orphaned on devnet; read-only.
const V1_SIZES_LEGACY = new Map<number, number>();
// V1D: actually deployed V1 program (ENGINE_OFF=424, BITMAP_OFF=624)
const V1D_SIZES = new Map<number, number>();
// V1D_SIZES_LEGACY: on-chain slabs created before GH#1234 when SDK assumed postBitmap=18.
// These are 16 bytes larger per tier (micro=17080, small=65104, medium=257200, large=1025584).
// The top active market (6ZytbpV4, $14k 24h vol) was created with postBitmap=18 and uses 65104.
// PR #1236 fixed postBitmap for new slabs (→2) but broke recognition of these legacy 65104 slabs.
// GH#1237: add both size variants so detectSlabLayout handles both old and new V1D on-chain data.
// V2: ENGINE_OFF=600, BITMAP_OFF=432, ACCOUNT_SIZE=248, postBitmap=18
const V2_SIZES = new Map<number, number>();
// V1M: mainnet-deployed V1 program (ENGINE_OFF=640, BITMAP_OFF=726, expanded RiskParams)
const V1M_SIZES = new Map<number, number>();
// V_ADL: PERC-8270/8271 ADL-upgraded program (ENGINE_OFF=624, BITMAP_OFF=1008, ACCOUNT_SIZE=312)
const V_ADL_SIZES = new Map<number, number>();
// V1M2: main@4861c56 with 312-byte accounts (ENGINE_OFF=616, BITMAP_OFF=1008, ACCOUNT_SIZE=312)
// After fixing bitmapOff to 1008 for both V1M2 and V_ADL, sizes differ because engineOff differs:
//   V1M2 medium (1024 accts): computeSlabSize(616, 1008, 312, 1024, 18) = 323312
//   V_ADL medium (1024 accts): computeSlabSize(624, 1008, 312, 1024, 18) = 323320
// No disambiguation probe required — size-based detection works correctly.
const V1M2_SIZES = new Map<number, number>();
// V_SETDEXPOOL: PERC-SetDexPool — ENGINE_OFF=648, BITMAP_OFF=1008, ACCOUNT_SIZE=312.
// Same engine and account layout as V_ADL; only ENGINE_OFF changed (+8 from config growth).
//   e.g. large (4096 accts): computeSlabSize(632, 1008, 312, 4096, 18) = 1288336
const V_SETDEXPOOL_SIZES = new Map<number, number>();
// V12_1: percolator-core v12.1 merge — engineOff=648, bitmapOff=1016, accountSize=320.
// Verified by cargo build-sbf compile-time assertions. Account grew 8 bytes, bitmap shifted 8.
//   e.g. large (4096 accts): computeSlabSize(648, 1016, 320, 4096, 18) = 1321112
const V12_1_SIZES = new Map<number, number>();
const V1D_SIZES_LEGACY = new Map<number, number>();
for (const n of TIERS) {
  V0_SIZES.set(computeSlabSize(V0_ENGINE_OFF, V0_ENGINE_BITMAP_OFF, V0_ACCOUNT_SIZE, n), n);
  V1_SIZES.set(computeSlabSize(V1_ENGINE_OFF, V1_ENGINE_BITMAP_OFF, V1_ACCOUNT_SIZE, n), n);
  V1_SIZES_LEGACY.set(computeSlabSize(V1_ENGINE_OFF_LEGACY, V1_ENGINE_BITMAP_OFF, V1_ACCOUNT_SIZE, n), n);
  // GH#1234: V1D deployed program omits num_used/pad/next_account_id → postBitmap=2 (free_head only).
  // This yields 65088 (n=256) and 1025568 (n=4096) matching actual devnet account sizes.
  V1D_SIZES.set(computeSlabSize(V1D_ENGINE_OFF, V1D_ENGINE_BITMAP_OFF, V1D_ACCOUNT_SIZE, n, 2), n);
  // GH#1237: also register the legacy postBitmap=18 sizes for slabs created before GH#1234 fix.
  V1D_SIZES_LEGACY.set(computeSlabSize(V1D_ENGINE_OFF, V1D_ENGINE_BITMAP_OFF, V1D_ACCOUNT_SIZE, n, 18), n);
  // V2: postBitmap=18 — produces same sizes as V1D postBitmap=2 (e.g. 65088 for n=256).
  // Disambiguation requires peeking at the version field in the slab header.
  V2_SIZES.set(computeSlabSize(V2_ENGINE_OFF, V2_ENGINE_BITMAP_OFF, V2_ACCOUNT_SIZE, n, 18), n);
  // V1M: mainnet program with expanded RiskParams (336 bytes) and trade_twap fields.
  // e.g. n=1024 → 257512 bytes (confirmed on-chain for slab 8NY7rvQ).
  V1M_SIZES.set(computeSlabSize(V1M_ENGINE_OFF, V1M_ENGINE_BITMAP_OFF, V1M_ACCOUNT_SIZE, n, 18), n);
  // V_ADL: PERC-8270 ADL-upgraded program — new account size (312) and expanded engine layout.
  // e.g. n=4096 → 1288320 bytes (engineOff=624, bitmapOff=1008).
  V_ADL_SIZES.set(computeSlabSize(V_ADL_ENGINE_OFF, V_ADL_ENGINE_BITMAP_OFF, V_ADL_ACCOUNT_SIZE, n, 18), n);
  // V1M2: main@4861c56 rebuild — engineOff=616, bitmapOff=1008, accountSize=312.
  // e.g. n=1024 → 323312 bytes (confirmed on-chain for slab CCTegYZ...).
  V1M2_SIZES.set(computeSlabSize(V1M2_ENGINE_OFF, V1M2_ENGINE_BITMAP_OFF, V1M2_ACCOUNT_SIZE, n, 18), n);
  // V_SETDEXPOOL: PERC-SetDexPool — engineOff=648, bitmapOff=1008, accountSize=312.
  // e.g. n=4096 → 1288336 bytes.
  V_SETDEXPOOL_SIZES.set(computeSlabSize(V_SETDEXPOOL_ENGINE_OFF, V_ADL_ENGINE_BITMAP_OFF, V_ADL_ACCOUNT_SIZE, n, 18), n);
  // V12_1: percolator-core v12.1 — accountSize=320 on aarch64, 280 on SBF.
  // The SBF binary has different struct alignment (u128 align=8 vs 16 on aarch64).
  // Register BOTH host-computed and SBF-empirical sizes for detection.
  V12_1_SIZES.set(computeSlabSize(V12_1_ENGINE_OFF, V12_1_ENGINE_BITMAP_OFF, V12_1_ACCOUNT_SIZE, n, 18), n);
}
// SBF-specific V12_1 sizes (empirically verified from deployed mainnet binary).
// Account=280 bytes on SBF (vs 320 on aarch64) due to u128 alignment difference.
const V12_1_SBF_ACCOUNT_SIZE = 280;
const V12_1_SBF_ENGINE_PREAMBLE = 558;
for (const [, n] of [["Micro", 64], ["Small", 256], ["Medium", 1024], ["Large", 4096]] as const) {
  const bitmapBytes = Math.ceil(n / 64) * 8;
  const preAccLen = V12_1_SBF_ENGINE_PREAMBLE + bitmapBytes + 18 + n * 2;
  const accountsOff = Math.ceil(preAccLen / 8) * 8;
  const total = V12_1_ENGINE_OFF + accountsOff + n * V12_1_SBF_ACCOUNT_SIZE;
  V12_1_SIZES.set(total, n);
}

/**
 * V2 slab tier sizes (small and large) for discovery.
 * V2 uses ENGINE_OFF=600, BITMAP_OFF=432, ACCOUNT_SIZE=248, postBitmap=18.
 * Sizes overlap with V1D (postBitmap=2) — disambiguation requires reading the version field.
 */
export const SLAB_TIERS_V2 = {
  small: { maxAccounts: 256,  dataSize: 65_088,    label: "Small",  description: "256 slots (V2 BPF intermediate)" },
  large: { maxAccounts: 4096, dataSize: 1_025_568, label: "Large",  description: "4,096 slots (V2 BPF intermediate)" },
} as const;

/**
 * V1M slab tier sizes — mainnet-deployed V1 program (ESa89R5).
 * ENGINE_OFF=640, BITMAP_OFF=726, ACCOUNT_SIZE=248, postBitmap=18.
 * Expanded RiskParams (336 bytes) and trade_twap runtime fields.
 * Confirmed by on-chain probing of slab 8NY7rvQ (SOL/USDC Perpetual, 257512 bytes).
 */
export const SLAB_TIERS_V1M: Record<string, { maxAccounts: number; dataSize: number; label: string; description: string }> = {};
for (const [label, n] of [["Micro", 64], ["Small", 256], ["Medium", 1024], ["Large", 4096]] as const) {
  const size = computeSlabSize(V1M_ENGINE_OFF, V1M_ENGINE_BITMAP_OFF, V1M_ACCOUNT_SIZE, n, 18);
  SLAB_TIERS_V1M[label.toLowerCase()] = { maxAccounts: n, dataSize: size, label, description: `${n} slots (V1M mainnet)` };
}

/**
 * V1M2 slab tier sizes — mainnet program rebuilt from main@4861c56 with 312-byte accounts.
 * ENGINE_OFF=616, BITMAP_OFF=1008 (empirically verified from CCTegYZ...).
 * Engine struct is layout-identical to V_ADL; differs only in engineOff (616 vs 624).
 * Sizes are unique from V_ADL after the bitmap correction: medium=323312 vs V_ADL=323320.
 */
export const SLAB_TIERS_V1M2: Record<string, { maxAccounts: number; dataSize: number; label: string; description: string }> = {};
for (const [label, n] of [["Micro", 64], ["Small", 256], ["Medium", 1024], ["Large", 4096]] as const) {
  const size = computeSlabSize(V1M2_ENGINE_OFF, V1M2_ENGINE_BITMAP_OFF, V1M2_ACCOUNT_SIZE, n, 18);
  SLAB_TIERS_V1M2[label.toLowerCase()] = { maxAccounts: n, dataSize: size, label, description: `${n} slots (V1M2 mainnet upgraded)` };
}

/**
 * V_ADL slab tier sizes — PERC-8270/8271 ADL-upgraded program.
 * ENGINE_OFF=624, BITMAP_OFF=1008, ACCOUNT_SIZE=312, postBitmap=18.
 * New account layout adds ADL tracking fields (+64 bytes/account including alignment padding).
 * BPF SLAB_LEN verified by cargo build-sbf in PERC-8271: large (4096) = 1288320 bytes.
 */
export const SLAB_TIERS_V_ADL: Record<string, { maxAccounts: number; dataSize: number; label: string; description: string }> = {};
for (const [label, n] of [["Micro", 64], ["Small", 256], ["Medium", 1024], ["Large", 4096]] as const) {
  const size = computeSlabSize(V_ADL_ENGINE_OFF, V_ADL_ENGINE_BITMAP_OFF, V_ADL_ACCOUNT_SIZE, n, 18);
  SLAB_TIERS_V_ADL[label.toLowerCase()] = { maxAccounts: n, dataSize: size, label, description: `${n} slots (V_ADL PERC-8270)` };
}

/**
 * Build a complete SlabLayout descriptor for V0 or V1 (including V1-legacy) slabs.
 * Pass `engineOffOverride` to handle orphaned pre-PERC-1094 slabs that used ENGINE_OFF=640.
 */
function buildLayout(version: 0 | 1, maxAccounts: number, engineOffOverride?: number): SlabLayout {
  const isV0 = version === 0;
  const engineOff = engineOffOverride ?? (isV0 ? V0_ENGINE_OFF : V1_ENGINE_OFF);
  const isV1Legacy = !isV0 && engineOffOverride === V1_ENGINE_OFF_LEGACY;
  // For accountsOff calculation, V1_LEGACY must use its actual bitmap offset (672, not 656).
  // Using the formula bitmapOff (656) produces accountsOff=1864, but accounts actually
  // start at 1880 — a 16-byte gap caused by the extra fields in the V1_LEGACY engine.
  // Non-V1_LEGACY slabs: actualBitmapOff === bitmapOff, so no change.
  const bitmapOff = isV0 ? V0_ENGINE_BITMAP_OFF : V1_ENGINE_BITMAP_OFF;
  const actualBitmapOff = isV1Legacy ? V1_LEGACY_ENGINE_BITMAP_OFF_ACTUAL
    : (isV0 ? V0_ENGINE_BITMAP_OFF : V1_ENGINE_BITMAP_OFF);
  const accountSize = isV0 ? V0_ACCOUNT_SIZE : V1_ACCOUNT_SIZE;
  const bitmapWords = Math.ceil(maxAccounts / 64);
  const bitmapBytes = bitmapWords * 8;
  const postBitmap = 18;
  const nextFreeBytes = maxAccounts * 2;
  // Use actualBitmapOff so V1_LEGACY gets accountsOff=1880 (not 1864).
  const preAccountsLen = actualBitmapOff + bitmapBytes + postBitmap + nextFreeBytes;
  const accountsOffRel = Math.ceil(preAccountsLen / 8) * 8;

  return {
    version,
    headerLen: isV0 ? V0_HEADER_LEN : V1_HEADER_LEN,
    configOffset: isV0 ? V0_HEADER_LEN : V1_HEADER_LEN,
    configLen: isV0 ? V0_CONFIG_LEN : V1_CONFIG_LEN,
    reservedOff: isV0 ? V0_RESERVED_OFF : V1_RESERVED_OFF,
    engineOff,
    accountSize,
    maxAccounts,
    bitmapWords,
    accountsOff: engineOff + accountsOffRel,

    engineInsuranceOff: 16,
    engineParamsOff: isV0 ? V0_ENGINE_PARAMS_OFF : V1_ENGINE_PARAMS_OFF,
    paramsSize: isV0 ? V0_PARAMS_SIZE : V1_PARAMS_SIZE,
    engineCurrentSlotOff: isV0 ? V0_ENGINE_CURRENT_SLOT_OFF : V1_ENGINE_CURRENT_SLOT_OFF,
    engineFundingIndexOff: isV0 ? V0_ENGINE_FUNDING_INDEX_OFF : V1_ENGINE_FUNDING_INDEX_OFF,
    engineLastFundingSlotOff: isV0 ? V0_ENGINE_LAST_FUNDING_SLOT_OFF : V1_ENGINE_LAST_FUNDING_SLOT_OFF,
    engineFundingRateBpsOff: isV0 ? V0_ENGINE_FUNDING_RATE_BPS_OFF : V1_ENGINE_FUNDING_RATE_BPS_OFF,
    engineMarkPriceOff: isV0 ? -1 : V1_ENGINE_MARK_PRICE_OFF,
    engineLastCrankSlotOff: isV0 ? V0_ENGINE_LAST_CRANK_SLOT_OFF : V1_ENGINE_LAST_CRANK_SLOT_OFF,
    engineMaxCrankStalenessOff: isV0 ? V0_ENGINE_MAX_CRANK_STALENESS_OFF : V1_ENGINE_MAX_CRANK_STALENESS_OFF,
    engineTotalOiOff: isV0 ? V0_ENGINE_TOTAL_OI_OFF : V1_ENGINE_TOTAL_OI_OFF,
    engineLongOiOff: isV0 ? -1 : V1_ENGINE_LONG_OI_OFF,
    engineShortOiOff: isV0 ? -1 : V1_ENGINE_SHORT_OI_OFF,
    engineCTotOff: isV0 ? V0_ENGINE_C_TOT_OFF : V1_ENGINE_C_TOT_OFF,
    enginePnlPosTotOff: isV0 ? V0_ENGINE_PNL_POS_TOT_OFF : V1_ENGINE_PNL_POS_TOT_OFF,
    engineLiqCursorOff: isV0 ? V0_ENGINE_LIQ_CURSOR_OFF : V1_ENGINE_LIQ_CURSOR_OFF,
    engineGcCursorOff: isV0 ? V0_ENGINE_GC_CURSOR_OFF : V1_ENGINE_GC_CURSOR_OFF,
    engineLastSweepStartOff: isV0 ? V0_ENGINE_LAST_SWEEP_START_OFF : V1_ENGINE_LAST_SWEEP_START_OFF,
    engineLastSweepCompleteOff: isV0 ? V0_ENGINE_LAST_SWEEP_COMPLETE_OFF : V1_ENGINE_LAST_SWEEP_COMPLETE_OFF,
    engineCrankCursorOff: isV0 ? V0_ENGINE_CRANK_CURSOR_OFF : V1_ENGINE_CRANK_CURSOR_OFF,
    engineSweepStartIdxOff: isV0 ? V0_ENGINE_SWEEP_START_IDX_OFF : V1_ENGINE_SWEEP_START_IDX_OFF,
    engineLifetimeLiquidationsOff: isV0 ? V0_ENGINE_LIFETIME_LIQUIDATIONS_OFF : V1_ENGINE_LIFETIME_LIQUIDATIONS_OFF,
    engineLifetimeForceClosesOff: isV0 ? V0_ENGINE_LIFETIME_FORCE_CLOSES_OFF : V1_ENGINE_LIFETIME_FORCE_CLOSES_OFF,
    engineNetLpPosOff: isV0 ? V0_ENGINE_NET_LP_POS_OFF : V1_ENGINE_NET_LP_POS_OFF,
    engineLpSumAbsOff: isV0 ? V0_ENGINE_LP_SUM_ABS_OFF : V1_ENGINE_LP_SUM_ABS_OFF,
    engineLpMaxAbsOff: isV0 ? V0_ENGINE_LP_MAX_ABS_OFF : V1_ENGINE_LP_MAX_ABS_OFF,
    engineLpMaxAbsSweepOff: isV0 ? V0_ENGINE_LP_MAX_ABS_SWEEP_OFF : V1_ENGINE_LP_MAX_ABS_SWEEP_OFF,
    engineEmergencyOiModeOff: isV0 ? -1 : V1_ENGINE_EMERGENCY_OI_MODE_OFF,
    engineEmergencyStartSlotOff: isV0 ? -1 : V1_ENGINE_EMERGENCY_START_SLOT_OFF,
    engineLastBreakerSlotOff: isV0 ? -1 : V1_ENGINE_LAST_BREAKER_SLOT_OFF,
    engineBitmapOff: actualBitmapOff,
    postBitmap: 18,
    acctOwnerOff: ACCT_OWNER_OFF,

    hasInsuranceIsolation: !isV0,
    engineInsuranceIsolatedOff: isV0 ? -1 : 48,
    engineInsuranceIsolationBpsOff: isV0 ? -1 : 64,
  };
}

/**
 * Build layout for V1D (actually deployed V1 program, rev ac18a0e).
 * Uses correct field offsets derived from on-chain probing.
 *
 * @param maxAccounts - Number of account slots in the slab
 * @param postBitmap  - Bytes after the bitmap before next_free array.
 *   2  = free_head(u16) only — deployed program (GH#1234, default for new slabs)
 *   18 = num_used(u16)+pad(6)+next_account_id(u64)+free_head(u16) — legacy on-chain slabs (GH#1237)
 */
/**
 * Build a SlabLayout for the actually-deployed V1D program (ENGINE_OFF=424).
 * `postBitmap` is 2 for new slabs (free_head only) and 18 for legacy on-chain slabs
 * created before the GH#1234 fix that removed num_used/pad/next_account_id.
 */
function buildLayoutV1D(maxAccounts: number, postBitmap = 2): SlabLayout {
  const engineOff = V1D_ENGINE_OFF;
  const bitmapOff = V1D_ENGINE_BITMAP_OFF;
  const accountSize = V1D_ACCOUNT_SIZE;
  const bitmapWords = Math.ceil(maxAccounts / 64);
  const bitmapBytes = bitmapWords * 8;
  const nextFreeBytes = maxAccounts * 2;
  const preAccountsLen = bitmapOff + bitmapBytes + postBitmap + nextFreeBytes;
  const accountsOffRel = Math.ceil(preAccountsLen / 8) * 8;

  return {
    version: 1,
    headerLen: V1_HEADER_LEN,
    configOffset: V1_HEADER_LEN,
    configLen: V1D_CONFIG_LEN,
    reservedOff: V1_RESERVED_OFF,
    engineOff,
    accountSize,
    maxAccounts,
    bitmapWords,
    accountsOff: engineOff + accountsOffRel,

    engineInsuranceOff: V1D_ENGINE_INSURANCE_OFF,
    engineParamsOff: V1D_ENGINE_PARAMS_OFF,
    paramsSize: V1D_PARAMS_SIZE,
    engineCurrentSlotOff: V1D_ENGINE_CURRENT_SLOT_OFF,
    engineFundingIndexOff: V1D_ENGINE_FUNDING_INDEX_OFF,
    engineLastFundingSlotOff: V1D_ENGINE_LAST_FUNDING_SLOT_OFF,
    engineFundingRateBpsOff: V1D_ENGINE_FUNDING_RATE_BPS_OFF,
    engineMarkPriceOff: V1D_ENGINE_MARK_PRICE_OFF,
    engineLastCrankSlotOff: V1D_ENGINE_LAST_CRANK_SLOT_OFF,
    engineMaxCrankStalenessOff: V1D_ENGINE_MAX_CRANK_STALENESS_OFF,
    engineTotalOiOff: V1D_ENGINE_TOTAL_OI_OFF,
    engineLongOiOff: V1D_ENGINE_LONG_OI_OFF,
    engineShortOiOff: V1D_ENGINE_SHORT_OI_OFF,
    engineCTotOff: V1D_ENGINE_C_TOT_OFF,
    enginePnlPosTotOff: V1D_ENGINE_PNL_POS_TOT_OFF,
    engineLiqCursorOff: V1D_ENGINE_LIQ_CURSOR_OFF,
    engineGcCursorOff: V1D_ENGINE_GC_CURSOR_OFF,
    engineLastSweepStartOff: V1D_ENGINE_LAST_SWEEP_START_OFF,
    engineLastSweepCompleteOff: V1D_ENGINE_LAST_SWEEP_COMPLETE_OFF,
    engineCrankCursorOff: V1D_ENGINE_CRANK_CURSOR_OFF,
    engineSweepStartIdxOff: V1D_ENGINE_SWEEP_START_IDX_OFF,
    engineLifetimeLiquidationsOff: V1D_ENGINE_LIFETIME_LIQUIDATIONS_OFF,
    engineLifetimeForceClosesOff: V1D_ENGINE_LIFETIME_FORCE_CLOSES_OFF,
    engineNetLpPosOff: V1D_ENGINE_NET_LP_POS_OFF,
    engineLpSumAbsOff: V1D_ENGINE_LP_SUM_ABS_OFF,
    engineLpMaxAbsOff: -1,              // not present in deployed V1
    engineLpMaxAbsSweepOff: -1,         // not present in deployed V1
    engineEmergencyOiModeOff: -1,       // not present in deployed V1
    engineEmergencyStartSlotOff: -1,    // not present in deployed V1
    engineLastBreakerSlotOff: -1,       // not present in deployed V1
    engineBitmapOff: V1D_ENGINE_BITMAP_OFF,
    postBitmap,
    acctOwnerOff: ACCT_OWNER_OFF,

    hasInsuranceIsolation: true,
    engineInsuranceIsolatedOff: 48,     // same within InsuranceFund
    engineInsuranceIsolationBpsOff: 64, // same within InsuranceFund
  };
}

/**
 * Build a SlabLayout for V2 (BPF intermediate layout).
 * ENGINE_OFF=600, BITMAP_OFF=432, ACCOUNT_SIZE=248, postBitmap=18.
 * V2 lacks mark_price, long_oi, short_oi, emergency OI fields.
 */
function buildLayoutV2(maxAccounts: number): SlabLayout {
  const engineOff = V2_ENGINE_OFF;
  const bitmapOff = V2_ENGINE_BITMAP_OFF;
  const accountSize = V2_ACCOUNT_SIZE;
  const bitmapWords = Math.ceil(maxAccounts / 64);
  const bitmapBytes = bitmapWords * 8;
  const postBitmap = 18;
  const nextFreeBytes = maxAccounts * 2;
  const preAccountsLen = bitmapOff + bitmapBytes + postBitmap + nextFreeBytes;
  const accountsOffRel = Math.ceil(preAccountsLen / 8) * 8;

  return {
    version: 2,
    headerLen: V2_HEADER_LEN,
    configOffset: V2_HEADER_LEN,
    configLen: V2_CONFIG_LEN,
    reservedOff: V1_RESERVED_OFF,   // V2 shares V1's header layout (reserved at 80)
    engineOff,
    accountSize,
    maxAccounts,
    bitmapWords,
    accountsOff: engineOff + accountsOffRel,

    engineInsuranceOff: 16,
    engineParamsOff: V1_ENGINE_PARAMS_OFF,  // same as V1: 72
    paramsSize: V1_PARAMS_SIZE,             // same as V1: 288
    engineCurrentSlotOff: V2_ENGINE_CURRENT_SLOT_OFF,
    engineFundingIndexOff: V2_ENGINE_FUNDING_INDEX_OFF,
    engineLastFundingSlotOff: V2_ENGINE_LAST_FUNDING_SLOT_OFF,
    engineFundingRateBpsOff: V2_ENGINE_FUNDING_RATE_BPS_OFF,
    engineMarkPriceOff: -1,                 // V2 has no mark_price
    engineLastCrankSlotOff: V2_ENGINE_LAST_CRANK_SLOT_OFF,
    engineMaxCrankStalenessOff: V2_ENGINE_MAX_CRANK_STALENESS_OFF,
    engineTotalOiOff: V2_ENGINE_TOTAL_OI_OFF,
    engineLongOiOff: -1,                    // V2 has no long_oi
    engineShortOiOff: -1,                   // V2 has no short_oi
    engineCTotOff: V2_ENGINE_C_TOT_OFF,
    enginePnlPosTotOff: V2_ENGINE_PNL_POS_TOT_OFF,
    engineLiqCursorOff: V2_ENGINE_LIQ_CURSOR_OFF,
    engineGcCursorOff: V2_ENGINE_GC_CURSOR_OFF,
    engineLastSweepStartOff: V2_ENGINE_LAST_SWEEP_START_OFF,
    engineLastSweepCompleteOff: V2_ENGINE_LAST_SWEEP_COMPLETE_OFF,
    engineCrankCursorOff: V2_ENGINE_CRANK_CURSOR_OFF,
    engineSweepStartIdxOff: V2_ENGINE_SWEEP_START_IDX_OFF,
    engineLifetimeLiquidationsOff: V2_ENGINE_LIFETIME_LIQUIDATIONS_OFF,
    engineLifetimeForceClosesOff: V2_ENGINE_LIFETIME_FORCE_CLOSES_OFF,
    engineNetLpPosOff: V2_ENGINE_NET_LP_POS_OFF,
    engineLpSumAbsOff: V2_ENGINE_LP_SUM_ABS_OFF,
    engineLpMaxAbsOff: V2_ENGINE_LP_MAX_ABS_OFF,
    engineLpMaxAbsSweepOff: V2_ENGINE_LP_MAX_ABS_SWEEP_OFF,
    engineEmergencyOiModeOff: -1,           // V2 has no emergency OI fields
    engineEmergencyStartSlotOff: -1,
    engineLastBreakerSlotOff: -1,
    engineBitmapOff: V2_ENGINE_BITMAP_OFF,
    postBitmap: 18,
    acctOwnerOff: ACCT_OWNER_OFF,

    hasInsuranceIsolation: true,
    engineInsuranceIsolatedOff: 48,
    engineInsuranceIsolationBpsOff: 64,
  };
}

/**
 * Build a SlabLayout for the V1M mainnet program (ESa89R5).
 * ENGINE_OFF=640 (same as V1_LEGACY), but expanded RiskParams (336 bytes)
 * and trade_twap runtime fields push the bitmap to offset 726.
 * Confirmed by on-chain probing of slab 8NY7rvQ (257512 bytes, medium tier).
 */
function buildLayoutV1M(maxAccounts: number): SlabLayout {
  const engineOff = V1M_ENGINE_OFF;
  const bitmapOff = V1M_ENGINE_BITMAP_OFF;
  const accountSize = V1M_ACCOUNT_SIZE;
  const bitmapWords = Math.ceil(maxAccounts / 64);
  const bitmapBytes = bitmapWords * 8;
  const postBitmap = 18;
  const nextFreeBytes = maxAccounts * 2;
  const preAccountsLen = bitmapOff + bitmapBytes + postBitmap + nextFreeBytes;
  const accountsOffRel = Math.ceil(preAccountsLen / 8) * 8;

  return {
    version: 1,
    headerLen: V1_HEADER_LEN,
    configOffset: V1_HEADER_LEN,
    configLen: V1M_CONFIG_LEN,
    reservedOff: V1_RESERVED_OFF,
    engineOff,
    accountSize,
    maxAccounts,
    bitmapWords,
    accountsOff: engineOff + accountsOffRel,

    engineInsuranceOff: 16,
    engineParamsOff: V1M_ENGINE_PARAMS_OFF,
    paramsSize: V1M_PARAMS_SIZE,
    engineCurrentSlotOff: V1M_ENGINE_CURRENT_SLOT_OFF,
    engineFundingIndexOff: V1M_ENGINE_FUNDING_INDEX_OFF,
    engineLastFundingSlotOff: V1M_ENGINE_LAST_FUNDING_SLOT_OFF,
    engineFundingRateBpsOff: V1M_ENGINE_FUNDING_RATE_BPS_OFF,
    engineMarkPriceOff: V1M_ENGINE_MARK_PRICE_OFF,
    engineLastCrankSlotOff: V1M_ENGINE_LAST_CRANK_SLOT_OFF,
    engineMaxCrankStalenessOff: V1M_ENGINE_MAX_CRANK_STALENESS_OFF,
    engineTotalOiOff: V1M_ENGINE_TOTAL_OI_OFF,
    engineLongOiOff: V1M_ENGINE_LONG_OI_OFF,
    engineShortOiOff: V1M_ENGINE_SHORT_OI_OFF,
    engineCTotOff: V1M_ENGINE_C_TOT_OFF,
    enginePnlPosTotOff: V1M_ENGINE_PNL_POS_TOT_OFF,
    engineLiqCursorOff: V1M_ENGINE_LIQ_CURSOR_OFF,
    engineGcCursorOff: V1M_ENGINE_GC_CURSOR_OFF,
    engineLastSweepStartOff: V1M_ENGINE_LAST_SWEEP_START_OFF,
    engineLastSweepCompleteOff: V1M_ENGINE_LAST_SWEEP_COMPLETE_OFF,
    engineCrankCursorOff: V1M_ENGINE_CRANK_CURSOR_OFF,
    engineSweepStartIdxOff: V1M_ENGINE_SWEEP_START_IDX_OFF,
    engineLifetimeLiquidationsOff: V1M_ENGINE_LIFETIME_LIQUIDATIONS_OFF,
    engineLifetimeForceClosesOff: V1M_ENGINE_LIFETIME_FORCE_CLOSES_OFF,
    engineNetLpPosOff: V1M_ENGINE_NET_LP_POS_OFF,
    engineLpSumAbsOff: V1M_ENGINE_LP_SUM_ABS_OFF,
    engineLpMaxAbsOff: V1M_ENGINE_LP_MAX_ABS_OFF,
    engineLpMaxAbsSweepOff: V1M_ENGINE_LP_MAX_ABS_SWEEP_OFF,
    engineEmergencyOiModeOff: V1M_ENGINE_EMERGENCY_OI_MODE_OFF,
    engineEmergencyStartSlotOff: V1M_ENGINE_EMERGENCY_START_SLOT_OFF,
    engineLastBreakerSlotOff: V1M_ENGINE_LAST_BREAKER_SLOT_OFF,
    engineBitmapOff: V1M_ENGINE_BITMAP_OFF,
    postBitmap: 18,
    acctOwnerOff: ACCT_OWNER_OFF,

    hasInsuranceIsolation: true,
    engineInsuranceIsolatedOff: 48,
    engineInsuranceIsolationBpsOff: 64,
  };
}

/**
 * Build a SlabLayout for V1M2 — mainnet program rebuilt from main@4861c56 with 312-byte accounts.
 * ENGINE_OFF=616 (align_up(104+512,8)=616), CONFIG_LEN=512.
 * The engine struct is layout-identical to V_ADL (same relative field offsets from engineOff),
 * so all runtime field offsets reuse V_ADL constants. bitmapOff=1008 (same as V_ADL).
 * This differs from V_ADL only in engineOff (616 vs 624) and configLen (512 vs 520).
 * Confirmed by empirical probing of mainnet slab CCTegYZ... (323312 bytes, 1024-account medium tier).
 */
function buildLayoutV1M2(maxAccounts: number): SlabLayout {
  const engineOff = V1M2_ENGINE_OFF;
  const bitmapOff = V1M2_ENGINE_BITMAP_OFF;
  const accountSize = V1M2_ACCOUNT_SIZE;
  const bitmapWords = Math.ceil(maxAccounts / 64);
  const bitmapBytes = bitmapWords * 8;
  const postBitmap = 18;
  const nextFreeBytes = maxAccounts * 2;
  const preAccountsLen = bitmapOff + bitmapBytes + postBitmap + nextFreeBytes;
  const accountsOffRel = Math.ceil(preAccountsLen / 8) * 8;

  return {
    version: 1,
    headerLen: V1_HEADER_LEN,
    configOffset: V1_HEADER_LEN,
    configLen: V1M2_CONFIG_LEN,
    reservedOff: V1_RESERVED_OFF,
    engineOff,
    accountSize,
    maxAccounts,
    bitmapWords,
    accountsOff: engineOff + accountsOffRel,

    engineInsuranceOff: 16,
    engineParamsOff: V1M2_ENGINE_PARAMS_OFF,                         // 96 — expanded InsuranceFund (same as V_ADL)
    paramsSize: V_ADL_PARAMS_SIZE,                                    // 336 — same as V_ADL
    // Runtime fields: V1M2 engine struct is layout-identical to V_ADL — reuse V_ADL constants.
    engineCurrentSlotOff: V_ADL_ENGINE_CURRENT_SLOT_OFF,             // 432
    engineFundingIndexOff: V_ADL_ENGINE_FUNDING_INDEX_OFF,           // 440
    engineLastFundingSlotOff: V_ADL_ENGINE_LAST_FUNDING_SLOT_OFF,   // 456
    engineFundingRateBpsOff: V_ADL_ENGINE_FUNDING_RATE_BPS_OFF,     // 464
    engineMarkPriceOff: V_ADL_ENGINE_MARK_PRICE_OFF,                 // 504
    engineLastCrankSlotOff: V_ADL_ENGINE_LAST_CRANK_SLOT_OFF,       // 528
    engineMaxCrankStalenessOff: V_ADL_ENGINE_MAX_CRANK_STALENESS_OFF, // 536
    engineTotalOiOff: V_ADL_ENGINE_TOTAL_OI_OFF,                     // 544
    engineLongOiOff: V_ADL_ENGINE_LONG_OI_OFF,                       // 560
    engineShortOiOff: V_ADL_ENGINE_SHORT_OI_OFF,                     // 576
    engineCTotOff: V_ADL_ENGINE_C_TOT_OFF,                           // 592
    enginePnlPosTotOff: V_ADL_ENGINE_PNL_POS_TOT_OFF,               // 608
    engineLiqCursorOff: V_ADL_ENGINE_LIQ_CURSOR_OFF,                 // 640
    engineGcCursorOff: V_ADL_ENGINE_GC_CURSOR_OFF,                   // 642
    engineLastSweepStartOff: V_ADL_ENGINE_LAST_SWEEP_START_OFF,     // 648
    engineLastSweepCompleteOff: V_ADL_ENGINE_LAST_SWEEP_COMPLETE_OFF, // 656
    engineCrankCursorOff: V_ADL_ENGINE_CRANK_CURSOR_OFF,             // 664
    engineSweepStartIdxOff: V_ADL_ENGINE_SWEEP_START_IDX_OFF,       // 666
    engineLifetimeLiquidationsOff: V_ADL_ENGINE_LIFETIME_LIQUIDATIONS_OFF, // 672
    engineLifetimeForceClosesOff: V_ADL_ENGINE_LIFETIME_FORCE_CLOSES_OFF,  // 680
    engineNetLpPosOff: V_ADL_ENGINE_NET_LP_POS_OFF,                  // 904
    engineLpSumAbsOff: V_ADL_ENGINE_LP_SUM_ABS_OFF,                  // 920
    engineLpMaxAbsOff: V_ADL_ENGINE_LP_MAX_ABS_OFF,                  // 936
    engineLpMaxAbsSweepOff: V_ADL_ENGINE_LP_MAX_ABS_SWEEP_OFF,      // 952
    engineEmergencyOiModeOff: V_ADL_ENGINE_EMERGENCY_OI_MODE_OFF,    // 968
    engineEmergencyStartSlotOff: V_ADL_ENGINE_EMERGENCY_START_SLOT_OFF, // 976
    engineLastBreakerSlotOff: V_ADL_ENGINE_LAST_BREAKER_SLOT_OFF,   // 984
    engineBitmapOff: V1M2_ENGINE_BITMAP_OFF,
    postBitmap: 18,
    acctOwnerOff: V_ADL_ACCT_OWNER_OFF,            // 192 — same shift as V_ADL (reserved_pnl u64→u128)

    hasInsuranceIsolation: true,
    engineInsuranceIsolatedOff: 48,
    engineInsuranceIsolationBpsOff: 64,
  };
}

/**
 * Build a SlabLayout for the ADL-upgraded program (PERC-8270/8271).
 * ENGINE_OFF=624, BITMAP_OFF=1008, ACCOUNT_SIZE=312.
 *
 * Verified slab sizes (BPF, cargo build-sbf, bitmapOff corrected to 1008):
 *   large  (4096 accounts): 1288320 bytes
 *   medium (1024 accounts): 323320 bytes
 *   small  (256 accounts):  82064 bytes
 */
function buildLayoutVADL(maxAccounts: number): SlabLayout {
  const engineOff = V_ADL_ENGINE_OFF;
  const bitmapOff = V_ADL_ENGINE_BITMAP_OFF;
  const accountSize = V_ADL_ACCOUNT_SIZE;
  const bitmapWords = Math.ceil(maxAccounts / 64);
  const bitmapBytes = bitmapWords * 8;
  const postBitmap = 18;
  const nextFreeBytes = maxAccounts * 2;
  const preAccountsLen = bitmapOff + bitmapBytes + postBitmap + nextFreeBytes;
  const accountsOffRel = Math.ceil(preAccountsLen / 8) * 8;

  return {
    version: 1,
    headerLen: V1_HEADER_LEN,       // 104 (unchanged)
    configOffset: V1_HEADER_LEN,
    configLen: V_ADL_CONFIG_LEN,    // 520
    reservedOff: V1_RESERVED_OFF,   // 80
    engineOff,
    accountSize,
    maxAccounts,
    bitmapWords,
    accountsOff: engineOff + accountsOffRel,

    engineInsuranceOff: 16,
    engineParamsOff: V_ADL_ENGINE_PARAMS_OFF,      // 96 (vault=16 + InsuranceFund=80)
    paramsSize: V_ADL_PARAMS_SIZE,                 // 336
    engineCurrentSlotOff: V_ADL_ENGINE_CURRENT_SLOT_OFF,       // 432
    engineFundingIndexOff: V_ADL_ENGINE_FUNDING_INDEX_OFF,     // 440
    engineLastFundingSlotOff: V_ADL_ENGINE_LAST_FUNDING_SLOT_OFF, // 456
    engineFundingRateBpsOff: V_ADL_ENGINE_FUNDING_RATE_BPS_OFF,  // 464
    engineMarkPriceOff: V_ADL_ENGINE_MARK_PRICE_OFF,           // 504
    engineLastCrankSlotOff: V_ADL_ENGINE_LAST_CRANK_SLOT_OFF,  // 528
    engineMaxCrankStalenessOff: V_ADL_ENGINE_MAX_CRANK_STALENESS_OFF, // 536
    engineTotalOiOff: V_ADL_ENGINE_TOTAL_OI_OFF,               // 544
    engineLongOiOff: V_ADL_ENGINE_LONG_OI_OFF,                 // 560
    engineShortOiOff: V_ADL_ENGINE_SHORT_OI_OFF,               // 576
    engineCTotOff: V_ADL_ENGINE_C_TOT_OFF,                     // 592
    enginePnlPosTotOff: V_ADL_ENGINE_PNL_POS_TOT_OFF,         // 608
    engineLiqCursorOff: V_ADL_ENGINE_LIQ_CURSOR_OFF,           // 640
    engineGcCursorOff: V_ADL_ENGINE_GC_CURSOR_OFF,             // 642
    engineLastSweepStartOff: V_ADL_ENGINE_LAST_SWEEP_START_OFF,     // 648
    engineLastSweepCompleteOff: V_ADL_ENGINE_LAST_SWEEP_COMPLETE_OFF, // 656
    engineCrankCursorOff: V_ADL_ENGINE_CRANK_CURSOR_OFF,       // 664
    engineSweepStartIdxOff: V_ADL_ENGINE_SWEEP_START_IDX_OFF,  // 666
    engineLifetimeLiquidationsOff: V_ADL_ENGINE_LIFETIME_LIQUIDATIONS_OFF, // 672
    engineLifetimeForceClosesOff: V_ADL_ENGINE_LIFETIME_FORCE_CLOSES_OFF,  // 680
    engineNetLpPosOff: V_ADL_ENGINE_NET_LP_POS_OFF,            // 904
    engineLpSumAbsOff: V_ADL_ENGINE_LP_SUM_ABS_OFF,            // 920
    engineLpMaxAbsOff: V_ADL_ENGINE_LP_MAX_ABS_OFF,            // 936
    engineLpMaxAbsSweepOff: V_ADL_ENGINE_LP_MAX_ABS_SWEEP_OFF, // 952
    engineEmergencyOiModeOff: V_ADL_ENGINE_EMERGENCY_OI_MODE_OFF,    // 968
    engineEmergencyStartSlotOff: V_ADL_ENGINE_EMERGENCY_START_SLOT_OFF, // 976
    engineLastBreakerSlotOff: V_ADL_ENGINE_LAST_BREAKER_SLOT_OFF,    // 984
    engineBitmapOff: V_ADL_ENGINE_BITMAP_OFF,                  // 1008
    postBitmap: 18,
    acctOwnerOff: V_ADL_ACCT_OWNER_OFF,                        // 192

    hasInsuranceIsolation: true,
    engineInsuranceIsolatedOff: 48,
    engineInsuranceIsolationBpsOff: 64,
  };
}

/**
 * V_SETDEXPOOL slab tier sizes — PERC-SetDexPool security fix.
 * ENGINE_OFF=632, BITMAP_OFF=1008, ACCOUNT_SIZE=312, CONFIG_LEN=528.
 * e.g. large (4096 accts) = 1288336 bytes.
 */
export const SLAB_TIERS_V_SETDEXPOOL: Record<string, { maxAccounts: number; dataSize: number; label: string; description: string }> = {};
for (const [label, n] of [["Micro", 64], ["Small", 256], ["Medium", 1024], ["Large", 4096]] as const) {
  const size = computeSlabSize(V_SETDEXPOOL_ENGINE_OFF, V_ADL_ENGINE_BITMAP_OFF, V_ADL_ACCOUNT_SIZE, n, 18);
  SLAB_TIERS_V_SETDEXPOOL[label.toLowerCase()] = { maxAccounts: n, dataSize: size, label, description: `${n} slots (V_SETDEXPOOL PERC-SetDexPool)` };
}

/**
 * V12_1 slab tier sizes — percolator-core v12.1 merge.
 * ENGINE_OFF=648, BITMAP_OFF=1016, ACCOUNT_SIZE=320.
 * Verified by cargo build-sbf compile-time assertions.
 */
export const SLAB_TIERS_V12_1: Record<string, { maxAccounts: number; dataSize: number; label: string; description: string }> = {};
for (const [label, n] of [["Micro", 64], ["Small", 256], ["Medium", 1024], ["Large", 4096]] as const) {
  const size = computeSlabSize(V12_1_ENGINE_OFF, V12_1_ENGINE_BITMAP_OFF, V12_1_ACCOUNT_SIZE, n, 18);
  SLAB_TIERS_V12_1[label.toLowerCase()] = { maxAccounts: n, dataSize: size, label, description: `${n} slots (v12.1)` };
}

/**
 * Build a SlabLayout for V_SETDEXPOOL slabs (PERC-SetDexPool security fix).
 * ENGINE_OFF=632 (+8 from V_ADL=624 due to CONFIG_LEN growing 520→528).
 * All engine and account field offsets are identical to V_ADL.
 */
function buildLayoutVSetDexPool(maxAccounts: number): SlabLayout {
  const engineOff = V_SETDEXPOOL_ENGINE_OFF;
  const bitmapOff = V_ADL_ENGINE_BITMAP_OFF;
  const accountSize = V_ADL_ACCOUNT_SIZE;
  const bitmapWords = Math.ceil(maxAccounts / 64);
  const bitmapBytes = bitmapWords * 8;
  const postBitmap = 18;
  const nextFreeBytes = maxAccounts * 2;
  const preAccountsLen = bitmapOff + bitmapBytes + postBitmap + nextFreeBytes;
  const accountsOffRel = Math.ceil(preAccountsLen / 8) * 8;

  return {
    version: 1,
    headerLen: V1_HEADER_LEN,
    configOffset: V1_HEADER_LEN,
    configLen: V_SETDEXPOOL_CONFIG_LEN,   // 544
    reservedOff: V1_RESERVED_OFF,
    engineOff,
    accountSize,
    maxAccounts,
    bitmapWords,
    accountsOff: engineOff + accountsOffRel,

    engineInsuranceOff: 16,
    engineParamsOff: V_ADL_ENGINE_PARAMS_OFF,
    paramsSize: V_ADL_PARAMS_SIZE,
    engineCurrentSlotOff: V_ADL_ENGINE_CURRENT_SLOT_OFF,
    engineFundingIndexOff: V_ADL_ENGINE_FUNDING_INDEX_OFF,
    engineLastFundingSlotOff: V_ADL_ENGINE_LAST_FUNDING_SLOT_OFF,
    engineFundingRateBpsOff: V_ADL_ENGINE_FUNDING_RATE_BPS_OFF,
    engineMarkPriceOff: V_ADL_ENGINE_MARK_PRICE_OFF,
    engineLastCrankSlotOff: V_ADL_ENGINE_LAST_CRANK_SLOT_OFF,
    engineMaxCrankStalenessOff: V_ADL_ENGINE_MAX_CRANK_STALENESS_OFF,
    engineTotalOiOff: V_ADL_ENGINE_TOTAL_OI_OFF,
    engineLongOiOff: V_ADL_ENGINE_LONG_OI_OFF,
    engineShortOiOff: V_ADL_ENGINE_SHORT_OI_OFF,
    engineCTotOff: V_ADL_ENGINE_C_TOT_OFF,
    enginePnlPosTotOff: V_ADL_ENGINE_PNL_POS_TOT_OFF,
    engineLiqCursorOff: V_ADL_ENGINE_LIQ_CURSOR_OFF,
    engineGcCursorOff: V_ADL_ENGINE_GC_CURSOR_OFF,
    engineLastSweepStartOff: V_ADL_ENGINE_LAST_SWEEP_START_OFF,
    engineLastSweepCompleteOff: V_ADL_ENGINE_LAST_SWEEP_COMPLETE_OFF,
    engineCrankCursorOff: V_ADL_ENGINE_CRANK_CURSOR_OFF,
    engineSweepStartIdxOff: V_ADL_ENGINE_SWEEP_START_IDX_OFF,
    engineLifetimeLiquidationsOff: V_ADL_ENGINE_LIFETIME_LIQUIDATIONS_OFF,
    engineLifetimeForceClosesOff: V_ADL_ENGINE_LIFETIME_FORCE_CLOSES_OFF,
    engineNetLpPosOff: V_ADL_ENGINE_NET_LP_POS_OFF,
    engineLpSumAbsOff: V_ADL_ENGINE_LP_SUM_ABS_OFF,
    engineLpMaxAbsOff: V_ADL_ENGINE_LP_MAX_ABS_OFF,
    engineLpMaxAbsSweepOff: V_ADL_ENGINE_LP_MAX_ABS_SWEEP_OFF,
    engineEmergencyOiModeOff: V_ADL_ENGINE_EMERGENCY_OI_MODE_OFF,
    engineEmergencyStartSlotOff: V_ADL_ENGINE_EMERGENCY_START_SLOT_OFF,
    engineLastBreakerSlotOff: V_ADL_ENGINE_LAST_BREAKER_SLOT_OFF,
    engineBitmapOff: V_ADL_ENGINE_BITMAP_OFF,
    postBitmap: 18,
    acctOwnerOff: V_ADL_ACCT_OWNER_OFF,

    hasInsuranceIsolation: true,
    engineInsuranceIsolatedOff: 48,
    engineInsuranceIsolationBpsOff: 64,
  };
}

function buildLayoutV12_1(maxAccounts: number, dataLen?: number): SlabLayout {
  // SBF vs host detection: SBF has different struct alignment (u128 align=8 vs 16).
  // This affects ENGINE_OFF, CONFIG_LEN, ACCOUNT_SIZE, and BITMAP_OFF.
  // Empirically verified from mainnet slab BVjPc6rd (290120 bytes):
  //   SBF: headerLen=72, configLen=544, engineOff=616, accountSize=280
  //   Host: headerLen=72, configLen=576, engineOff=648, accountSize=320
  const hostSize = computeSlabSize(V12_1_ENGINE_OFF, V12_1_ENGINE_BITMAP_OFF, V12_1_ACCOUNT_SIZE, maxAccounts, 18);
  const isSbf = dataLen !== undefined && dataLen !== hostSize;
  const engineOff = isSbf ? 616 : V12_1_ENGINE_OFF;
  // SBF bitmap: engine+590 (abs 1206). Host: engine+368 (abs 1016).
  const bitmapOff = isSbf ? 590 : (V12_1_ENGINE_BITMAP_OFF - V12_1_ENGINE_OFF);
  const accountSize = isSbf ? V12_1_ACCOUNT_SIZE_SBF : V12_1_ACCOUNT_SIZE;
  const bitmapWords = Math.ceil(maxAccounts / 64);
  const bitmapBytes = bitmapWords * 8;
  const postBitmap = 18;
  const nextFreeBytes = maxAccounts * 2;
  const preAccountsLen = bitmapOff + bitmapBytes + postBitmap + nextFreeBytes;
  const accountsOffRel = Math.ceil(preAccountsLen / 8) * 8;

  return {
    version: 1,
    // V12_1 upstream rebase uses 72-byte header (SlabHeader only, no V1 extension).
    // Empirically verified: USDC mint found at offset 72 on mainnet slab BVjPc6rd.
    headerLen: V0_HEADER_LEN,     // 72 (not 104 — V12_1 removed the 32-byte header extension)
    configOffset: V0_HEADER_LEN,  // 72
    configLen: isSbf ? 544 : 576,  // SBF=544, host=576 (alignment diff)
    reservedOff: V1_RESERVED_OFF,
    engineOff,
    accountSize,
    maxAccounts,
    bitmapWords,
    accountsOff: engineOff + accountsOffRel,

    engineInsuranceOff: 16,
    engineParamsOff: V12_1_ENGINE_PARAMS_OFF,
    paramsSize: V12_1_PARAMS_SIZE,
    engineCurrentSlotOff: V12_1_ENGINE_CURRENT_SLOT_OFF,
    engineFundingIndexOff: V12_1_ENGINE_FUNDING_INDEX_OFF,
    engineLastFundingSlotOff: V12_1_ENGINE_LAST_FUNDING_SLOT_OFF,
    engineFundingRateBpsOff: V12_1_ENGINE_FUNDING_RATE_BPS_OFF,
    engineMarkPriceOff: V12_1_ENGINE_MARK_PRICE_OFF,
    engineLastCrankSlotOff: V12_1_ENGINE_LAST_CRANK_SLOT_OFF,
    engineMaxCrankStalenessOff: V12_1_ENGINE_MAX_CRANK_STALENESS_OFF,
    engineTotalOiOff: V12_1_ENGINE_TOTAL_OI_OFF,
    engineLongOiOff: V12_1_ENGINE_LONG_OI_OFF,
    engineShortOiOff: V12_1_ENGINE_SHORT_OI_OFF,
    engineCTotOff: V12_1_ENGINE_C_TOT_OFF,
    enginePnlPosTotOff: V12_1_ENGINE_PNL_POS_TOT_OFF,
    engineLiqCursorOff: V12_1_ENGINE_LIQ_CURSOR_OFF,
    engineGcCursorOff: V12_1_ENGINE_GC_CURSOR_OFF,
    engineLastSweepStartOff: V12_1_ENGINE_LAST_SWEEP_START_OFF,
    engineLastSweepCompleteOff: V12_1_ENGINE_LAST_SWEEP_COMPLETE_OFF,
    engineCrankCursorOff: V12_1_ENGINE_CRANK_CURSOR_OFF,
    engineSweepStartIdxOff: V12_1_ENGINE_SWEEP_START_IDX_OFF,
    engineLifetimeLiquidationsOff: V12_1_ENGINE_LIFETIME_LIQUIDATIONS_OFF,
    engineLifetimeForceClosesOff: V12_1_ENGINE_LIFETIME_FORCE_CLOSES_OFF,
    engineNetLpPosOff: V12_1_ENGINE_NET_LP_POS_OFF,
    engineLpSumAbsOff: V12_1_ENGINE_LP_SUM_ABS_OFF,
    engineLpMaxAbsOff: V12_1_ENGINE_LP_MAX_ABS_OFF,
    engineLpMaxAbsSweepOff: V12_1_ENGINE_LP_MAX_ABS_SWEEP_OFF,
    engineEmergencyOiModeOff: V12_1_ENGINE_EMERGENCY_OI_MODE_OFF,
    engineEmergencyStartSlotOff: V12_1_ENGINE_EMERGENCY_START_SLOT_OFF,
    engineLastBreakerSlotOff: V12_1_ENGINE_LAST_BREAKER_SLOT_OFF,
    engineBitmapOff: V12_1_ENGINE_BITMAP_OFF,
    postBitmap: 18,
    acctOwnerOff: V12_1_ACCT_OWNER_OFF,

    hasInsuranceIsolation: true,
    engineInsuranceIsolatedOff: 48,
    engineInsuranceIsolationBpsOff: 64,
  };
}

/**
 * Detect the slab layout version from the raw account data length.
 * Returns the full SlabLayout descriptor, or null if the size is unrecognised.
 * Checks V12_1, V_SETDEXPOOL, V1M2, V_ADL, V1M, V0, V1D, V1D-legacy, V1, and V1-legacy sizes.
 *
 * When `data` is provided and the size matches V1D, the version field at offset 8 is read
 * to disambiguate V2 slabs (which produce identical sizes to V1D with postBitmap=2).
 * V2 slabs have version===2 at offset 8 (u32 LE).
 *
 * @param dataLen - The slab account data length in bytes
 * @param data    - Optional raw slab data for version-field disambiguation
 */
export function detectSlabLayout(dataLen: number, data?: Uint8Array): SlabLayout | null {
  // Check V12_1 sizes first (percolator-core v12.1, ACCOUNT_SIZE=320, BITMAP_OFF=1016).
  // Largest account size — no size collision with any earlier layout.
  const v121n = V12_1_SIZES.get(dataLen);
  if (v121n !== undefined) return buildLayoutV12_1(v121n, dataLen);

  // Check V_SETDEXPOOL sizes (PERC-SetDexPool, ENGINE_OFF=648, CONFIG_LEN=544).
  // These are the pre-v12.1 newest slabs — largest ENGINE_OFF so no size collision with V_ADL (624).
  const vsdpn = V_SETDEXPOOL_SIZES.get(dataLen);
  if (vsdpn !== undefined) return buildLayoutVSetDexPool(vsdpn);

  // Check V1M2 sizes. After fixing bitmapOff to 1008 for both V1M2 and V_ADL,
  // their sizes no longer collide (engineOff differs: 616 vs 624), so size-based detection
  // works directly — no data-probe disambiguation required.
  //   V1M2 medium (1024 accts): computeSlabSize(616, 1008, 312, 1024, 18) = 323312
  //   V_ADL medium (1024 accts): computeSlabSize(624, 1008, 312, 1024, 18) = 323320
  const v1m2n = V1M2_SIZES.get(dataLen);
  if (v1m2n !== undefined) return buildLayoutV1M2(v1m2n);

  // Check V_ADL sizes (PERC-8270/8271, ENGINE_OFF=624, BITMAP_OFF=1008, ACCOUNT_SIZE=312).
  const vadln = V_ADL_SIZES.get(dataLen);
  if (vadln !== undefined) return buildLayoutVADL(vadln);

  // Check V1M sizes (mainnet-deployed V1 program, ESa89R5).
  // Must be checked before V1_LEGACY because V1M sizes are unique and don't overlap.
  const v1mn = V1M_SIZES.get(dataLen);
  if (v1mn !== undefined) return buildLayoutV1M(v1mn);

  // Check V0 sizes (deployed devnet V0 program)
  const v0n = V0_SIZES.get(dataLen);
  if (v0n !== undefined) return buildLayout(0, v0n);

  // Check V1D sizes (actually deployed V1 program — ENGINE_OFF=424, correct struct layout).
  // V2 slabs produce identical sizes (postBitmap=18 for V2 == postBitmap=2 for V1D).
  // When data is available, peek at the version field to disambiguate.
  const v1dn = V1D_SIZES.get(dataLen);
  if (v1dn !== undefined) {
    if (data && data.length >= 12) {
      const version = readU32LE(data, 8);
      if (version === 2) return buildLayoutV2(v1dn);
    }
    return buildLayoutV1D(v1dn, 2);
  }

  // Check V1D legacy sizes (postBitmap=18 on-chain slabs created before GH#1234 fix).
  // e.g. slab 6ZytbpV4 (TEST/USD, top active market) = 65104 bytes, uses postBitmap=18.
  // PR #1236 broke these by only registering the postBitmap=2 size; GH#1237 restores support.
  const v1dln = V1D_SIZES_LEGACY.get(dataLen);
  if (v1dln !== undefined) return buildLayoutV1D(v1dln, 18);

  // Check V1 sizes (future V1 program — ENGINE_OFF=600, PERC-1094 corrected)
  const v1n = V1_SIZES.get(dataLen);
  if (v1n !== undefined) return buildLayout(1, v1n);

  // Check legacy V1 sizes (pre-PERC-1094 SDK used ENGINE_OFF=640; orphaned on devnet)
  const v1ln = V1_SIZES_LEGACY.get(dataLen);
  // PERC-1095 follow-up: must pass V1_ENGINE_OFF_LEGACY (640) so the returned SlabLayout
  // has .engineOff=640 — without the override buildLayout would use V1_ENGINE_OFF=600,
  // causing all engine reads on legacy slabs to land at the wrong byte offset.
  if (v1ln !== undefined) return buildLayout(1, v1ln, V1_ENGINE_OFF_LEGACY);

  return null;
}

/**
 * Legacy detectLayout for backward compat.
 * Returns { bitmapWords, accountsOff, maxAccounts } or null.
 *
 * GH#1238: previously recomputed accountsOff with hardcoded postBitmap=18, which gave a value
 * 16 bytes too large for V1D slabs (which use postBitmap=2). Now delegates directly to the
 * SlabLayout descriptor so each variant uses its own correct accountsOff.
 */
export function detectLayout(dataLen: number) {
  const layout = detectSlabLayout(dataLen);
  if (!layout) return null;
  return { bitmapWords: layout.bitmapWords, accountsOff: layout.accountsOff, maxAccounts: layout.maxAccounts };
}

// =============================================================================
// RiskParams Layout (field offsets within params, same for V0 and V1 basic fields)
// =============================================================================
const PARAMS_WARMUP_PERIOD_OFF = 0;
const PARAMS_MAINTENANCE_MARGIN_OFF = 8;
const PARAMS_INITIAL_MARGIN_OFF = 16;
const PARAMS_TRADING_FEE_OFF = 24;
const PARAMS_MAX_ACCOUNTS_OFF = 32;
const PARAMS_NEW_ACCOUNT_FEE_OFF = 40;
// V1-only extended params (offset 56+)
const PARAMS_RISK_THRESHOLD_OFF = 56;
const PARAMS_MAINTENANCE_FEE_OFF = 72;
const PARAMS_MAX_CRANK_STALENESS_OFF = 88;
const PARAMS_LIQUIDATION_FEE_BPS_OFF = 96;
const PARAMS_LIQUIDATION_FEE_CAP_OFF = 104;
const PARAMS_LIQUIDATION_BUFFER_OFF = 120;
const PARAMS_MIN_LIQUIDATION_OFF = 128;

// =============================================================================
// Account Layout (240/248 bytes)
// The first 240 bytes are identical in V0 and V1.
// V1 adds last_partial_liquidation_slot (u64, 8 bytes) at offset 240.
// =============================================================================
const ACCT_ACCOUNT_ID_OFF = 0;
const ACCT_CAPITAL_OFF = 8;
const ACCT_KIND_OFF = 24;
const ACCT_PNL_OFF = 32;
const ACCT_RESERVED_PNL_OFF = 48;
const ACCT_WARMUP_STARTED_OFF = 56;
const ACCT_WARMUP_SLOPE_OFF = 64;
const ACCT_POSITION_SIZE_OFF = 80;
const ACCT_ENTRY_PRICE_OFF = 96;
const ACCT_FUNDING_INDEX_OFF = 104;
const ACCT_MATCHER_PROGRAM_OFF = 120;
const ACCT_MATCHER_CONTEXT_OFF = 152;
const ACCT_OWNER_OFF = 184;
const ACCT_FEE_CREDITS_OFF = 216;
const ACCT_LAST_FEE_SLOT_OFF = 232;

// =============================================================================
// Interfaces
// =============================================================================

export interface SlabHeader {
  magic: bigint;
  version: number;
  bump: number;
  flags: number;
  resolved: boolean;
  paused: boolean;
  admin: PublicKey;
  nonce: bigint;
  lastThrUpdateSlot: bigint;
}

export interface MarketConfig {
  collateralMint: PublicKey;
  vaultPubkey: PublicKey;
  indexFeedId: PublicKey;
  maxStalenessSlots: bigint;
  confFilterBps: number;
  vaultAuthorityBump: number;
  invert: number;
  unitScale: number;
  fundingHorizonSlots: bigint;
  fundingKBps: bigint;
  fundingInvScaleNotionalE6: bigint;
  fundingMaxPremiumBps: bigint;
  fundingMaxBpsPerSlot: bigint;
  /** @deprecated Removed in V12_1 — always 0 */ fundingPremiumWeightBps: bigint;
  /** @deprecated Removed in V12_1 — always 0 */ fundingSettlementIntervalSlots: bigint;
  /** @deprecated Removed in V12_1 — always 0 */ fundingPremiumDampeningE6: bigint;
  /** @deprecated Removed in V12_1 — always 0 */ fundingPremiumMaxBpsPerSlot: bigint;
  threshFloor: bigint;
  threshRiskBps: bigint;
  threshUpdateIntervalSlots: bigint;
  threshStepBps: bigint;
  threshAlphaBps: bigint;
  threshMin: bigint;
  threshMax: bigint;
  threshMinStep: bigint;
  oracleAuthority: PublicKey;
  authorityPriceE6: bigint;
  authorityTimestamp: bigint;
  oraclePriceCapE2bps: bigint;
  lastEffectivePriceE6: bigint;
  oiCapMultiplierBps: bigint;
  maxPnlCap: bigint;
  adaptiveFundingEnabled: boolean;
  adaptiveScaleBps: number;
  adaptiveMaxFundingBps: bigint;
  marketCreatedSlot: bigint;
  oiRampSlots: bigint;
  resolvedSlot: bigint;
  insuranceIsolationBps: number;
  /** PERC-622: Oracle phase (0=Nascent, 1=Growing, 2=Mature) */
  oraclePhase: number;
  /** PERC-622: Cumulative trade volume in e6 format */
  cumulativeVolumeE6: bigint;
  /** PERC-622: Slots elapsed from market creation to Phase 2 entry (u24) */
  phase2DeltaSlots: number;
  /**
   * PERC-SetDexPool: Admin-pinned DEX pool pubkey for HYPERP markets.
   * Null when reading old slabs (pre-SetDexPool configLen < 528) or when
   * SetDexPool has never been called (all-zero pubkey).
   * Non-null means the program will reject any UpdateHyperpMark that passes
   * a different pool account.
   */
  dexPool: PublicKey | null;
}

export interface InsuranceFund {
  balance: bigint;
  feeRevenue: bigint;
  isolatedBalance: bigint;
  isolationBps: number;
}

export interface RiskParams {
  warmupPeriodSlots: bigint;
  maintenanceMarginBps: bigint;
  initialMarginBps: bigint;
  tradingFeeBps: bigint;
  maxAccounts: bigint;
  newAccountFee: bigint;
  riskReductionThreshold: bigint;
  maintenanceFeePerSlot: bigint;
  maxCrankStalenessSlots: bigint;
  liquidationFeeBps: bigint;
  liquidationFeeCap: bigint;
  liquidationBufferBps: bigint;
  minLiquidationAbs: bigint;
}

export interface EngineState {
  vault: bigint;
  insuranceFund: InsuranceFund;
  currentSlot: bigint;
  fundingIndexQpbE6: bigint;
  lastFundingSlot: bigint;
  fundingRateBpsPerSlotLast: bigint;
  lastCrankSlot: bigint;
  maxCrankStalenessSlots: bigint;
  totalOpenInterest: bigint;
  longOi: bigint;
  shortOi: bigint;
  cTot: bigint;
  pnlPosTot: bigint;
  liqCursor: number;
  gcCursor: number;
  lastSweepStartSlot: bigint;
  lastSweepCompleteSlot: bigint;
  crankCursor: number;
  sweepStartIdx: number;
  lifetimeLiquidations: bigint;
  lifetimeForceCloses: bigint;
  netLpPos: bigint;
  lpSumAbs: bigint;
  lpMaxAbs: bigint;
  lpMaxAbsSweep: bigint;
  emergencyOiMode: boolean;
  emergencyStartSlot: bigint;
  lastBreakerSlot: bigint;
  numUsedAccounts: number;
  nextAccountId: bigint;
  markPriceE6: bigint;
}

export enum AccountKind {
  User = 0,
  LP = 1,
}

export interface Account {
  kind: AccountKind;
  accountId: bigint;
  capital: bigint;
  pnl: bigint;
  reservedPnl: bigint;
  warmupStartedAtSlot: bigint;
  warmupSlopePerStep: bigint;
  positionSize: bigint;
  entryPrice: bigint;
  fundingIndex: bigint;
  matcherProgram: PublicKey;
  matcherContext: PublicKey;
  owner: PublicKey;
  feeCredits: bigint;
  lastFeeSlot: bigint;
}

// =============================================================================
// Fetch
// =============================================================================

export async function fetchSlab(
  connection: Connection,
  slabPubkey: PublicKey
): Promise<Uint8Array> {
  const info = await connection.getAccountInfo(slabPubkey);
  if (!info) {
    throw new Error(`Slab account not found: ${slabPubkey.toBase58()}`);
  }
  return new Uint8Array(info.data);
}

// =============================================================================
// PERC-302: Market Maturity OI Ramp
// =============================================================================

export const RAMP_START_BPS = 1000n;
export const DEFAULT_OI_RAMP_SLOTS = 432_000n;

export function computeEffectiveOiCapBps(config: MarketConfig, currentSlot: bigint): bigint {
  const target = config.oiCapMultiplierBps;
  if (target === 0n) return 0n;
  if (config.oiRampSlots === 0n) return target;
  if (target <= RAMP_START_BPS) return target;
  const elapsed = currentSlot > config.marketCreatedSlot
    ? currentSlot - config.marketCreatedSlot
    : 0n;
  if (elapsed >= config.oiRampSlots) return target;
  const range = target - RAMP_START_BPS;
  const rampAdd = (range * elapsed) / config.oiRampSlots;
  const result = RAMP_START_BPS + rampAdd;
  return result < target ? result : target;
}

// =============================================================================
// Header helpers
// =============================================================================

export function readNonce(data: Uint8Array): bigint {
  const layout = detectSlabLayout(data.length, data);
  if (!layout) {
    throw new Error(`readNonce: unrecognized slab data length ${data.length}`);
  }
  const roff = layout.reservedOff;
  if (data.length < roff + 8) throw new Error("Slab data too short for nonce");
  return readU64LE(data, roff);
}

export function readLastThrUpdateSlot(data: Uint8Array): bigint {
  const layout = detectSlabLayout(data.length, data);
  if (!layout) {
    throw new Error(`readLastThrUpdateSlot: unrecognized slab data length ${data.length}`);
  }
  const roff = layout.reservedOff;
  if (data.length < roff + 16) throw new Error("Slab data too short for lastThrUpdateSlot");
  return readU64LE(data, roff + 8);
}

// =============================================================================
// Parsing Functions
// =============================================================================

/**
 * Parse slab header (first 72 bytes — layout-independent).
 */
export function parseHeader(data: Uint8Array): SlabHeader {
  if (data.length < V0_HEADER_LEN) {
    throw new Error(`Slab data too short for header: ${data.length} < ${V0_HEADER_LEN}`);
  }

  const magic = readU64LE(data, 0);
  if (magic !== MAGIC) {
    throw new Error(`Invalid slab magic: expected ${MAGIC.toString(16)}, got ${magic.toString(16)}`);
  }

  const version = readU32LE(data, 8);
  const bump = readU8(data, 12);
  const flags = readU8(data, 13);
  const admin = new PublicKey(data.subarray(16, 48));

  // Reserved field location depends on layout
  const layout = detectSlabLayout(data.length, data);
  const roff = layout ? layout.reservedOff : V0_RESERVED_OFF;
  const nonce = readU64LE(data, roff);
  const lastThrUpdateSlot = readU64LE(data, roff + 8);

  return {
    magic,
    version,
    bump,
    flags,
    resolved: (flags & FLAG_RESOLVED) !== 0,
    paused: (flags & 0x02) !== 0,
    admin,
    nonce,
    lastThrUpdateSlot,
  };
}

/**
 * Parse market config. Layout-version aware.
 * For V0 slabs, fields beyond the basic config are read if present in the data,
 * otherwise defaults are returned.
 *
 * @param data - Slab data (may be a partial slice for discovery; pass layoutHint in that case)
 * @param layoutHint - Pre-detected layout to use; if omitted, detected from data.length.
 */
export function parseConfig(data: Uint8Array, layoutHint?: SlabLayout | null): MarketConfig {
  const layout = layoutHint !== undefined ? layoutHint : detectSlabLayout(data.length, data);
  const configOff = layout ? layout.configOffset : V0_HEADER_LEN;
  const configLen = layout ? layout.configLen : V0_CONFIG_LEN;

  const minLen = configOff + Math.min(configLen, 120); // need at least basic fields
  if (data.length < minLen) {
    throw new Error(`Slab data too short for config: ${data.length} < ${minLen}`);
  }

  let off = configOff;

  const collateralMint = new PublicKey(data.subarray(off, off + 32));
  off += 32;

  const vaultPubkey = new PublicKey(data.subarray(off, off + 32));
  off += 32;

  const indexFeedId = new PublicKey(data.subarray(off, off + 32));
  off += 32;

  const maxStalenessSlots = readU64LE(data, off);
  off += 8;

  const confFilterBps = readU16LE(data, off);
  off += 2;

  const vaultAuthorityBump = readU8(data, off);
  off += 1;

  const invert = readU8(data, off);
  off += 1;

  const unitScale = readU32LE(data, off);
  off += 4;

  // Funding rate parameters
  const fundingHorizonSlots = readU64LE(data, off);
  off += 8;

  const fundingKBps = readU64LE(data, off);
  off += 8;

  const fundingInvScaleNotionalE6 = readU128LE(data, off);
  off += 16;

  const fundingMaxPremiumBps = readI64LE(data, off);
  off += 8;

  const fundingMaxBpsPerSlot = readI64LE(data, off);
  off += 8;

  // NOTE: Extended funding fields (fundingPremiumWeightBps, fundingSettlementIntervalSlots,
  // fundingPremiumDampeningE6, fundingPremiumMaxBpsPerSlot) were removed in V12_1 upstream
  // rebase. They do NOT exist in the on-chain MarketConfig struct. Reading them here shifted
  // all subsequent fields by 32 bytes, causing oracle_authority to read garbage.

  // Threshold parameters
  const threshFloor = readU128LE(data, off);
  off += 16;

  const threshRiskBps = readU64LE(data, off);
  off += 8;

  const threshUpdateIntervalSlots = readU64LE(data, off);
  off += 8;

  const threshStepBps = readU64LE(data, off);
  off += 8;

  const threshAlphaBps = readU64LE(data, off);
  off += 8;

  const threshMin = readU128LE(data, off);
  off += 16;

  const threshMax = readU128LE(data, off);
  off += 16;

  const threshMinStep = readU128LE(data, off);
  off += 16;

  // Oracle authority fields
  const oracleAuthority = new PublicKey(data.subarray(off, off + 32));
  off += 32;

  const authorityPriceE6 = readU64LE(data, off);
  off += 8;

  const authorityTimestamp = readI64LE(data, off);
  off += 8;

  // Oracle price circuit breaker
  const oraclePriceCapE2bps = readU64LE(data, off);
  off += 8;

  const lastEffectivePriceE6 = readU64LE(data, off);
  off += 8;

  // OI cap
  const oiCapMultiplierBps = readU64LE(data, off);
  off += 8;

  const maxPnlCap = readU64LE(data, off);
  off += 8;

  // Check if we have enough data for V1-only fields
  const remaining = configOff + configLen - off;

  let adaptiveFundingEnabled = false;
  let adaptiveScaleBps = 0;
  let adaptiveMaxFundingBps = 0n;
  let marketCreatedSlot = 0n;
  let oiRampSlots = 0n;
  let resolvedSlot = 0n;
  let insuranceIsolationBps = 0;
  let oraclePhase = 0;
  let cumulativeVolumeE6 = 0n;
  let phase2DeltaSlots = 0;

  if (remaining >= 40) {
    // V1 extended fields — on-chain order (percolator.rs:3617-3639):
    //   market_created_slot(u64), oi_ramp_slots(u64),
    //   adaptive_funding_enabled(u8), _pad(u8), adaptive_scale_bps(u16),
    //   _pad2(u32), adaptive_max_funding_bps(u64),
    //   insurance_isolation_bps(u16), _insurance_isolation_padding([u8;14])
    marketCreatedSlot = readU64LE(data, off);
    off += 8;

    oiRampSlots = readU64LE(data, off);
    off += 8;

    adaptiveFundingEnabled = readU8(data, off) !== 0;
    off += 1;
    off += 1; // _adaptive_pad
    adaptiveScaleBps = readU16LE(data, off);
    off += 2;
    off += 4; // _adaptive_pad2
    adaptiveMaxFundingBps = readU64LE(data, off);
    off += 8;

    if (remaining >= 42) {
      insuranceIsolationBps = readU16LE(data, off);
      // PERC-622: Read oracle phase fields from _insurance_isolation_padding
      // padding starts at off + 2 (after u16 insuranceIsolationBps)
      // [0..2] = mark_oracle_weight (PERC-118), [2] = oracle_phase, [3..11] = cumulative_volume, [11..14] = phase2_delta
      if (remaining >= 56) { // 42 + 14 bytes padding
        const padOff = off + 2;
        oraclePhase = Math.min(readU8(data, padOff + 2), 2);
        cumulativeVolumeE6 = readU64LE(data, padOff + 3);
        // phase2_delta_slots is u24 LE (3 bytes)
        phase2DeltaSlots = data[padOff + 11] | (data[padOff + 12] << 8) | (data[padOff + 13] << 16);
      }
    }
  }

  // PERC-SetDexPool: read dex_pool at BPF offset 496 within config.
  // Only present in V_SETDEXPOOL slabs (configLen >= 528).
  // All-zero pubkey means SetDexPool was never called.
  let dexPool: PublicKey | null = null;
  const DEX_POOL_REL_OFF = 512; // SBF offset of dex_pool within MarketConfig (CONFIG_LEN=544, dex_pool at end = 544-32=512)
  if (configLen >= DEX_POOL_REL_OFF + 32 && data.length >= configOff + DEX_POOL_REL_OFF + 32) {
    const dexPoolBytes = data.subarray(configOff + DEX_POOL_REL_OFF, configOff + DEX_POOL_REL_OFF + 32);
    // Return null if all-zero (SetDexPool never called)
    if (dexPoolBytes.some(b => b !== 0)) {
      dexPool = new PublicKey(dexPoolBytes);
    }
  }

  return {
    collateralMint,
    vaultPubkey,
    indexFeedId,
    maxStalenessSlots,
    confFilterBps,
    vaultAuthorityBump,
    invert,
    unitScale,
    fundingHorizonSlots,
    fundingKBps,
    fundingInvScaleNotionalE6,
    fundingMaxPremiumBps,
    fundingMaxBpsPerSlot,
    fundingPremiumWeightBps: 0n,
    fundingSettlementIntervalSlots: 0n,
    fundingPremiumDampeningE6: 0n,
    fundingPremiumMaxBpsPerSlot: 0n,
    threshFloor,
    threshRiskBps,
    threshUpdateIntervalSlots,
    threshStepBps,
    threshAlphaBps,
    threshMin,
    threshMax,
    threshMinStep,
    oracleAuthority,
    authorityPriceE6,
    authorityTimestamp,
    oraclePriceCapE2bps,
    lastEffectivePriceE6,
    oiCapMultiplierBps,
    maxPnlCap,
    adaptiveFundingEnabled,
    adaptiveScaleBps,
    adaptiveMaxFundingBps,
    marketCreatedSlot,
    oiRampSlots,
    resolvedSlot,
    insuranceIsolationBps,
    oraclePhase,
    cumulativeVolumeE6,
    phase2DeltaSlots,
    dexPool,
  };
}

/**
 * Parse RiskParams from engine data. Layout-version aware.
 * For V0 slabs, extended params (risk_threshold, maintenance_fee, etc.) are
 * not present on-chain, so defaults (0) are returned.
 *
 * @param data - Slab data (may be a partial slice; pass layoutHint in that case)
 * @param layoutHint - Pre-detected layout to use; if omitted, detected from data.length.
 */
export function parseParams(data: Uint8Array, layoutHint?: SlabLayout | null): RiskParams {
  const layout = layoutHint !== undefined ? layoutHint : detectSlabLayout(data.length, data);
  const engineOff = layout ? layout.engineOff : V0_ENGINE_OFF;
  const paramsOff = layout ? layout.engineParamsOff : V0_ENGINE_PARAMS_OFF;
  const paramsSize = layout ? layout.paramsSize : V0_PARAMS_SIZE;
  const base = engineOff + paramsOff;

  if (data.length < base + Math.min(paramsSize, 56)) {
    throw new Error("Slab data too short for RiskParams");
  }

  // Basic params present in both V0 and V1
  const result: RiskParams = {
    warmupPeriodSlots: readU64LE(data, base + PARAMS_WARMUP_PERIOD_OFF),
    maintenanceMarginBps: readU64LE(data, base + PARAMS_MAINTENANCE_MARGIN_OFF),
    initialMarginBps: readU64LE(data, base + PARAMS_INITIAL_MARGIN_OFF),
    tradingFeeBps: readU64LE(data, base + PARAMS_TRADING_FEE_OFF),
    maxAccounts: readU64LE(data, base + PARAMS_MAX_ACCOUNTS_OFF),
    newAccountFee: readU128LE(data, base + PARAMS_NEW_ACCOUNT_FEE_OFF),
    // Extended params: only read if V1 (paramsSize >= 144)
    riskReductionThreshold: 0n,
    maintenanceFeePerSlot: 0n,
    maxCrankStalenessSlots: 0n,
    liquidationFeeBps: 0n,
    liquidationFeeCap: 0n,
    liquidationBufferBps: 0n,
    minLiquidationAbs: 0n,
  };

  if (paramsSize >= 144) {
    result.riskReductionThreshold = readU128LE(data, base + PARAMS_RISK_THRESHOLD_OFF);
    result.maintenanceFeePerSlot = readU128LE(data, base + PARAMS_MAINTENANCE_FEE_OFF);
    result.maxCrankStalenessSlots = readU64LE(data, base + PARAMS_MAX_CRANK_STALENESS_OFF);
    result.liquidationFeeBps = readU64LE(data, base + PARAMS_LIQUIDATION_FEE_BPS_OFF);
    result.liquidationFeeCap = readU128LE(data, base + PARAMS_LIQUIDATION_FEE_CAP_OFF);
    result.liquidationBufferBps = readU64LE(data, base + PARAMS_LIQUIDATION_BUFFER_OFF);
    result.minLiquidationAbs = readU128LE(data, base + PARAMS_MIN_LIQUIDATION_OFF);
  }

  return result;
}

/**
 * Parse RiskEngine state (excluding accounts array). Layout-version aware.
 */
export function parseEngine(data: Uint8Array): EngineState {
  const layout = detectSlabLayout(data.length, data);
  if (!layout) {
    throw new Error(`Unrecognized slab data length: ${data.length}. Cannot determine layout version.`);
  }

  const base = layout.engineOff;

  return {
    vault: readU128LE(data, base),
    insuranceFund: {
      balance: readU128LE(data, base + layout.engineInsuranceOff),
      feeRevenue: readU128LE(data, base + layout.engineInsuranceOff + 16),
      isolatedBalance: layout.hasInsuranceIsolation
        ? readU128LE(data, base + layout.engineInsuranceIsolatedOff)
        : 0n,
      isolationBps: layout.hasInsuranceIsolation
        ? readU16LE(data, base + layout.engineInsuranceIsolationBpsOff)
        : 0,
    },
    currentSlot: readU64LE(data, base + layout.engineCurrentSlotOff),
    fundingIndexQpbE6: readI128LE(data, base + layout.engineFundingIndexOff),
    lastFundingSlot: readU64LE(data, base + layout.engineLastFundingSlotOff),
    fundingRateBpsPerSlotLast: readI64LE(data, base + layout.engineFundingRateBpsOff),
    lastCrankSlot: readU64LE(data, base + layout.engineLastCrankSlotOff),
    maxCrankStalenessSlots: readU64LE(data, base + layout.engineMaxCrankStalenessOff),
    totalOpenInterest: readU128LE(data, base + layout.engineTotalOiOff),
    longOi: layout.engineLongOiOff >= 0
      ? readU128LE(data, base + layout.engineLongOiOff)
      : 0n,
    shortOi: layout.engineShortOiOff >= 0
      ? readU128LE(data, base + layout.engineShortOiOff)
      : 0n,
    cTot: readU128LE(data, base + layout.engineCTotOff),
    pnlPosTot: readU128LE(data, base + layout.enginePnlPosTotOff),
    liqCursor: readU16LE(data, base + layout.engineLiqCursorOff),
    gcCursor: readU16LE(data, base + layout.engineGcCursorOff),
    lastSweepStartSlot: readU64LE(data, base + layout.engineLastSweepStartOff),
    lastSweepCompleteSlot: readU64LE(data, base + layout.engineLastSweepCompleteOff),
    crankCursor: readU16LE(data, base + layout.engineCrankCursorOff),
    sweepStartIdx: readU16LE(data, base + layout.engineSweepStartIdxOff),
    lifetimeLiquidations: readU64LE(data, base + layout.engineLifetimeLiquidationsOff),
    lifetimeForceCloses: readU64LE(data, base + layout.engineLifetimeForceClosesOff),
    netLpPos: readI128LE(data, base + layout.engineNetLpPosOff),
    lpSumAbs: readU128LE(data, base + layout.engineLpSumAbsOff),
    lpMaxAbs: layout.engineLpMaxAbsOff >= 0 ? readU128LE(data, base + layout.engineLpMaxAbsOff) : 0n,
    lpMaxAbsSweep: layout.engineLpMaxAbsSweepOff >= 0 ? readU128LE(data, base + layout.engineLpMaxAbsSweepOff) : 0n,
    emergencyOiMode: layout.engineEmergencyOiModeOff >= 0
      ? data[base + layout.engineEmergencyOiModeOff] !== 0
      : false,
    emergencyStartSlot: layout.engineEmergencyStartSlotOff >= 0
      ? readU64LE(data, base + layout.engineEmergencyStartSlotOff)
      : 0n,
    lastBreakerSlot: layout.engineLastBreakerSlotOff >= 0
      ? readU64LE(data, base + layout.engineLastBreakerSlotOff)
      : 0n,
    markPriceE6: layout.engineMarkPriceOff >= 0
      ? readU64LE(data, base + layout.engineMarkPriceOff)
      : 0n,
    numUsedAccounts: (() => {
      if (layout.postBitmap < 18) return 0;
      const bw = layout.bitmapWords;
      return readU16LE(data, base + layout.engineBitmapOff + bw * 8);
    })(),
    nextAccountId: (() => {
      if (layout.postBitmap < 18) return 0n;
      const bw = layout.bitmapWords;
      const numUsedOff = layout.engineBitmapOff + bw * 8;
      return readU64LE(data, base + Math.ceil((numUsedOff + 2) / 8) * 8);
    })(),
  };
}

/**
 * Read bitmap to get list of used account indices.
 */
/**
 * Return all account indices whose bitmap bit is set (i.e. slot is in use).
 * Uses the layout-aware bitmap offset so V1_LEGACY slabs (bitmap at rel+672) are handled correctly.
 */
export function parseUsedIndices(data: Uint8Array): number[] {
  const layout = detectSlabLayout(data.length, data);
  if (!layout) throw new Error(`Unrecognized slab data length: ${data.length}`);

  const base = layout.engineOff + layout.engineBitmapOff;
  if (data.length < base + layout.bitmapWords * 8) {
    throw new Error("Slab data too short for bitmap");
  }

  const used: number[] = [];
  for (let word = 0; word < layout.bitmapWords; word++) {
    const bits = readU64LE(data, base + word * 8);
    if (bits === 0n) continue;
    for (let bit = 0; bit < 64; bit++) {
      if ((bits >> BigInt(bit)) & 1n) {
        used.push(word * 64 + bit);
      }
    }
  }
  return used;
}

/**
 * Check if a specific account index is used.
 */
export function isAccountUsed(data: Uint8Array, idx: number): boolean {
  const layout = detectSlabLayout(data.length, data);
  if (!layout) return false;
  if (!Number.isInteger(idx) || idx < 0 || idx >= layout.maxAccounts) return false;
  const base = layout.engineOff + layout.engineBitmapOff;
  const word = Math.floor(idx / 64);
  const bit = idx % 64;
  const bits = readU64LE(data, base + word * 8);
  return ((bits >> BigInt(bit)) & 1n) !== 0n;
}

/**
 * Calculate the maximum valid account index for a given slab size.
 */
export function maxAccountIndex(dataLen: number): number {
  const layout = detectSlabLayout(dataLen);
  if (!layout) return 0;
  const accountsEnd = dataLen - layout.accountsOff;
  if (accountsEnd <= 0) return 0;
  return Math.floor(accountsEnd / layout.accountSize);
}

/**
 * Parse a single account by index.
 */
export function parseAccount(data: Uint8Array, idx: number): Account {
  const layout = detectSlabLayout(data.length, data);
  if (!layout) throw new Error(`Unrecognized slab data length: ${data.length}`);

  const maxIdx = maxAccountIndex(data.length);
  if (!Number.isInteger(idx) || idx < 0 || idx >= maxIdx) {
    throw new Error(`Account index out of range: ${idx} (max: ${maxIdx - 1})`);
  }

  const base = layout.accountsOff + idx * layout.accountSize;
  if (data.length < base + layout.accountSize) {
    throw new Error("Slab data too short for account");
  }

  // Select layout-dependent account field offsets.
  // V12_1 (account_size=320): new fields (position_basis_q, adl_a_basis, adl_k_snap, adl_epoch_snap)
  //   shift matcher/owner/fee offsets +16 from V_ADL, and move legacy fields to end.
  // V_ADL (account_size=312): reserved_pnl grew u64→u128 (PERC-8267), shifting from pre-ADL offsets.
  // Pre-ADL (account_size<312): original offsets.
  // V12_1: engineOff=648 + bitmapOff(rel)=368. Detect by engineOff (most reliable).
  // Account is 320 on aarch64, 280 on SBF — accountSize alone is ambiguous.
  const isV12_1 = layout.engineOff === V12_1_ENGINE_OFF && (layout.accountSize === V12_1_ACCOUNT_SIZE || layout.accountSize === V12_1_ACCOUNT_SIZE_SBF);
  const isAdl = layout.accountSize >= 312 || isV12_1;
  const warmupStartedOff = isAdl ? V_ADL_ACCT_WARMUP_STARTED_OFF : ACCT_WARMUP_STARTED_OFF;
  const warmupSlopeOff   = isAdl ? V_ADL_ACCT_WARMUP_SLOPE_OFF   : ACCT_WARMUP_SLOPE_OFF;
  const positionSizeOff  = isV12_1 ? V12_1_ACCT_POSITION_SIZE_OFF : (isAdl ? V_ADL_ACCT_POSITION_SIZE_OFF : ACCT_POSITION_SIZE_OFF);
  const entryPriceOff    = isV12_1 ? V12_1_ACCT_ENTRY_PRICE_OFF   : (isAdl ? V_ADL_ACCT_ENTRY_PRICE_OFF   : ACCT_ENTRY_PRICE_OFF);
  const fundingIndexOff  = isV12_1 ? V12_1_ACCT_FUNDING_INDEX_OFF : (isAdl ? V_ADL_ACCT_FUNDING_INDEX_OFF : ACCT_FUNDING_INDEX_OFF);
  const matcherProgOff   = isV12_1 ? V12_1_ACCT_MATCHER_PROGRAM_OFF : (isAdl ? V_ADL_ACCT_MATCHER_PROGRAM_OFF : ACCT_MATCHER_PROGRAM_OFF);
  const matcherCtxOff    = isV12_1 ? V12_1_ACCT_MATCHER_CONTEXT_OFF : (isAdl ? V_ADL_ACCT_MATCHER_CONTEXT_OFF : ACCT_MATCHER_CONTEXT_OFF);
  const feeCreditsOff    = isV12_1 ? V12_1_ACCT_FEE_CREDITS_OFF   : (isAdl ? V_ADL_ACCT_FEE_CREDITS_OFF   : ACCT_FEE_CREDITS_OFF);
  const lastFeeSlotOff   = isV12_1 ? V12_1_ACCT_LAST_FEE_SLOT_OFF : (isAdl ? V_ADL_ACCT_LAST_FEE_SLOT_OFF : ACCT_LAST_FEE_SLOT_OFF);

  const kindByte = readU8(data, base + ACCT_KIND_OFF);
  const kind = kindByte === 1 ? AccountKind.LP : AccountKind.User;

  return {
    kind,
    accountId: readU64LE(data, base + ACCT_ACCOUNT_ID_OFF),
    capital: readU128LE(data, base + ACCT_CAPITAL_OFF),
    pnl: readI128LE(data, base + ACCT_PNL_OFF),
    reservedPnl: isAdl ? readU128LE(data, base + ACCT_RESERVED_PNL_OFF) : readU64LE(data, base + ACCT_RESERVED_PNL_OFF),
    warmupStartedAtSlot: readU64LE(data, base + warmupStartedOff),
    warmupSlopePerStep: readU128LE(data, base + warmupSlopeOff),
    positionSize: readI128LE(data, base + positionSizeOff),
    entryPrice: entryPriceOff >= 0 ? readU64LE(data, base + entryPriceOff) : 0n, // V12_1: entry_price removed
    // V12_1 changed funding_index from i128 to i64 (legacy field moved to end of account)
    fundingIndex: isV12_1 ? BigInt(readI64LE(data, base + fundingIndexOff)) : readI128LE(data, base + fundingIndexOff),
    matcherProgram: new PublicKey(data.subarray(base + matcherProgOff, base + matcherProgOff + 32)),
    matcherContext: new PublicKey(data.subarray(base + matcherCtxOff, base + matcherCtxOff + 32)),
    owner: new PublicKey(data.subarray(base + layout.acctOwnerOff, base + layout.acctOwnerOff + 32)),
    feeCredits: readI128LE(data, base + feeCreditsOff),
    lastFeeSlot: readU64LE(data, base + lastFeeSlotOff),
  };
}

/**
 * Parse all used accounts.
 */
export function parseAllAccounts(data: Uint8Array): { idx: number; account: Account }[] {
  const indices = parseUsedIndices(data);
  const maxIdx = maxAccountIndex(data.length);
  const validIndices = indices.filter(idx => idx < maxIdx);
  const droppedCount = indices.length - validIndices.length;
  if (droppedCount > 0) {
    console.warn(
      `[parseAllAccounts] bitmap claims ${indices.length} used accounts but only ${maxIdx} fit ` +
      `in the slab — ${droppedCount} out-of-bounds indices dropped (possible bitmap corruption)`,
    );
  }
  return validIndices.map(idx => ({
    idx,
    account: parseAccount(data, idx),
  }));
}

