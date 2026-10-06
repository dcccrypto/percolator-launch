/*
 * LOCAL ADAPTER PORT, not original code: verbatim from percolator-sdk feat/v22-sdk @ ecb6215 (draft dcccrypto/percolator-sdk#406, sdk 9.0.0-candidate),
 * src/solana/slab.ts. Only the imports are retargeted (the installed @percolatorct/sdk 8.0.0 root, the v2.1 txv1 port, and the sibling v22 ports).
 * Delete when @percolatorct/sdk >= 9.0.0 ships and point ./index.ts at the package. Do not edit here; fix upstream in percolator-sdk.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { ACCOUNT_KIND, resolveLayout, resolveMarketGeometry, resolvePortfolioLayout } from "./layout";
import type { LayoutTable } from "./layout";

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
  if (off >= data.length) {
    throw new RangeError(`readU8: offset ${off} out of bounds (length ${data.length})`);
  }
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

/** Slab magic number ("PERCOLAT" as little-endian u64). */
export const SLAB_MAGIC = MAGIC;

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

  // Optional fallback for engines without a stored mark_price field (v12.17+):
  // absolute offset into the slab of `config.mark_ewma_e6` (u64 little-endian,
  // scaled 1e6). Consumers that previously read `engine.mark_price` should
  // check this when `engineMarkPriceOff < 0`. Undefined on layouts that
  // predate v12.17 and already expose a real engine.mark_price.
  configMarkEwmaOff?: number;
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
// V12_1 layout constants — verified via `cargo build-sbf` compile-time offset_of! assertions.
// IMPORTANT: The deployed `percolator` library is DIFFERENT from `percolator-core`.
// The deployed struct has a simpler InsuranceFund (16 bytes), simpler RiskParams (184 bytes),
// and NO fields for: total_oi, long_oi, short_oi, net_lp_pos, lp_sum_abs, lp_max_abs,
// mark_price_e6, funding_index, last_funding_slot, emergency_*, lifetime_force_closes.
// Those fields exist in percolator-core but NOT in the deployed binary.
//
// HOST constants below are for aarch64 test builds (percolator-core).
// SBF constants are for the actual deployed program.
const V12_1_ENGINE_OFF = 648;      // HOST: align_up(72 + 576, 16) = 648
const V12_1_ACCOUNT_SIZE = 320;    // HOST aarch64 size
const V12_1_ACCOUNT_SIZE_SBF = 280; // SBF: verified by cargo build-sbf
const V12_1_ENGINE_BITMAP_OFF = 1016; // HOST bitmap offset (used field in percolator-core RiskEngine)
// SBF layout: InsuranceFund = {balance: U128} = 16 bytes. RiskParams = 184 bytes.
// vault(16) + InsuranceFund(16) = 32 → params at engine+32.
const V12_1_ENGINE_PARAMS_OFF_SBF = 32;   // offset_of!(RiskEngine, params) on SBF
const V12_1_ENGINE_PARAMS_OFF_HOST = 96;   // HOST value (percolator-core with 80-byte InsuranceFund)
const V12_1_ENGINE_PARAMS_OFF = 96;
const V12_1_PARAMS_SIZE_SBF = 184;        // SBF: size_of::<RiskParams>() = 184
const V12_1_PARAMS_SIZE = 352;            // HOST: percolator-core RiskParams
// SBF engine field offsets (relative to engineOff=616), verified by compiler:
const V12_1_SBF_OFF_CURRENT_SLOT = 216;
const V12_1_SBF_OFF_FUNDING_RATE = 224;
const V12_1_SBF_OFF_LAST_CRANK_SLOT = 232;
const V12_1_SBF_OFF_MAX_CRANK_STALENESS = 240;
const V12_1_SBF_OFF_C_TOT = 248;
const V12_1_SBF_OFF_PNL_POS_TOT = 264;
const V12_1_SBF_OFF_LIQ_CURSOR = 296;
const V12_1_SBF_OFF_GC_CURSOR = 298;
const V12_1_SBF_OFF_LAST_SWEEP_START = 304;
const V12_1_SBF_OFF_LAST_SWEEP_COMPLETE = 312;
const V12_1_SBF_OFF_CRANK_CURSOR = 320;
const V12_1_SBF_OFF_SWEEP_START_IDX = 322;
const V12_1_SBF_OFF_LIFETIME_LIQUIDATIONS = 328;
// Probed from mainnet slab FLF9ghf6H4sfSexcQzDwse4gcGZKPb6qYCqo5Btat98 (290120 bytes).
// These fields DO exist in the deployed SBF binary despite earlier "not in deployed struct" notes.
const V12_1_SBF_OFF_TOTAL_OI = 448;           // u128: totalOpenInterest (verified: 907109 matches sum of abs positions)
const V12_1_SBF_OFF_LONG_OI = 464;            // u128: longOi (verified: 907109 = all positions are long)
const V12_1_SBF_OFF_SHORT_OI = 480;           // u128: shortOi (verified: 0)
const V12_1_SBF_OFF_MARK_PRICE_E6 = 560;      // u64: markPriceE6 (verified: 85187279 = $85.19)
const V12_1_SBF_OFF_MARK_PRICE_SLOT = 568;    // u64: slot when mark price was last updated
const V12_1_SBF_OFF_EFFECTIVE_PRICE_E6 = 576;  // u64: lastEffectivePriceE6 (verified: matches mark)
// ADL state: 336–576 (adl_mult, adl_coeff, adl_epoch, oi_eff, side_mode, etc.)
// last_oracle_price: 560, last_market_slot: 568, funding_price_sample: 576
// Bitmap (used field): 584
// Fields NOT present in deployed program (return -1):
// total_oi, long_oi, short_oi, net_lp_pos, lp_sum_abs, lp_max_abs, lp_max_abs_sweep,
// mark_price, funding_index, last_funding_slot, emergency_*, lifetime_force_closes
//
// HOST engine field offsets (percolator-core, for test builds):
const V12_1_ENGINE_CURRENT_SLOT_OFF = 448;
const V12_1_ENGINE_FUNDING_RATE_BPS_OFF = 456;
const V12_1_ENGINE_LAST_CRANK_SLOT_OFF = 464;
const V12_1_ENGINE_MAX_CRANK_STALENESS_OFF = 472;
const V12_1_ENGINE_C_TOT_OFF = 480;
const V12_1_ENGINE_PNL_POS_TOT_OFF = 496;
const V12_1_ENGINE_LIQ_CURSOR_OFF = 528;
const V12_1_ENGINE_GC_CURSOR_OFF = 530;
const V12_1_ENGINE_LAST_SWEEP_START_OFF = 536;
const V12_1_ENGINE_LAST_SWEEP_COMPLETE_OFF = 544;
const V12_1_ENGINE_CRANK_CURSOR_OFF = 552;
const V12_1_ENGINE_SWEEP_START_IDX_OFF = 554;
const V12_1_ENGINE_LIFETIME_LIQUIDATIONS_OFF = 560;
// HOST-only fields (percolator-core has these, deployed percolator does not):
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
const V12_1_ENGINE_EMERGENCY_OI_MODE_OFF = 968;
const V12_1_ENGINE_EMERGENCY_START_SLOT_OFF = 976;
const V12_1_ENGINE_LAST_BREAKER_SLOT_OFF = 984;
const V12_1_ENGINE_LIFETIME_FORCE_CLOSES_OFF = 1008;
// V12_1 account field offsets (relative to account slot start):
// New fields position_basis_q(i128@88), adl_a_basis(u128@104), adl_k_snap(i128@120),
// adl_epoch_snap(u64@136) inserted before matcher_*, shifting everything from offset 128+ by +16.
const V12_1_ACCT_MATCHER_PROGRAM_OFF = 144; // was 128 in V_ADL (+16 from new ADL fields)
const V12_1_ACCT_MATCHER_CONTEXT_OFF = 176; // was 160 in V_ADL (+16 from new ADL fields)
const V12_1_ACCT_OWNER_OFF = 208;           // was 192 in V_ADL (+16 from new ADL fields)
const V12_1_ACCT_FEE_CREDITS_OFF = 240;     // was 224 in V_ADL
const V12_1_ACCT_LAST_FEE_SLOT_OFF = 256;   // was 240 in V_ADL
const V12_1_ACCT_POSITION_SIZE_OFF = 88;     // position_basis_q: i128 at offset 88 (SBF)
const V12_1_ACCT_ENTRY_PRICE_OFF = -1;       // -1 for old V12_1 slabs (280-byte accounts)
const V12_1_ACCT_FUNDING_INDEX_OFF = -1;     // does not exist in SBF layout

// ---- V12_1_EP: V12_1 with entry_price re-added (accountSize=288 on SBF, 304 on host) ----
// entry_price(u64) inserted after adl_epoch_snap, shifting matcher/owner/fees +8.
// SBF layout (u128 align=8):
//   ...adl_epoch_snap(u64@136) → entry_price(u64@144) → matcher_program(@152)
//   → matcher_context(@184) → owner(@216) → fee_credits(@248) → last_fee_slot(@264)
//   → fees_earned_total(@272) = 288 bytes
const V12_1_EP_SBF_ACCOUNT_SIZE = 288;
const V12_1_EP_ACCT_ENTRY_PRICE_OFF = 144;
const V12_1_EP_ACCT_MATCHER_PROGRAM_OFF = 152;
const V12_1_EP_ACCT_MATCHER_CONTEXT_OFF = 184;
const V12_1_EP_ACCT_OWNER_OFF = 216;
const V12_1_EP_ACCT_FEE_CREDITS_OFF = 248;
const V12_1_EP_ACCT_LAST_FEE_SLOT_OFF = 264;

// ---- V12_15 layout constants (percolator engine+prog v12.15 sync) ----
// Account struct completely redesigned: sizeof=4400 bytes (SBF and host identical — all fields
// explicitly sized, no pointer-derived alignment differences).
// Fields REMOVED: warmupStartedAtSlot, warmupSlopePerStep, lastFeeSlot.
// Fields ADDED: entry_price(u64@120), exact_reserve_cohorts(62*64=3968 bytes@256),
//   exact_cohort_count(u8@4224), overflow_older(ReserveCohort=64 bytes@4240),
//   overflow_older_present(u8@4304), overflow_newest(ReserveCohort=64@4320),
//   overflow_newest_present(u8@4384).
// RiskParams sizeof=192: warmup_period_slots split into h_min(u64@160) + h_max(u64@168).
//   Field max_accounts moved to offset 24, insurance_floor at 144.
// RiskEngine: ENGINE_OFF=624 (HEADER=72 + CONFIG=552, SBF aligned).
//   funding_rate renamed funding_rate_e9, now i128 (16 bytes) at offset 240 (was i64 at 224).
//   market_mode(u8) added at offset 256. pnl_matured_pos_tot(u128) added at 384.
//   RISK_BUF_OFF = ENGINE_OFF + ENGINE_LEN; RISK_BUF_LEN = 160.
// SBF SLAB_LEN for --features small (MAX_ACCOUNTS=256): 1,128,448 bytes (verified by native test).
// All account offsets below match both SBF and native (no alignment divergence for this struct).
const V12_15_ENGINE_OFF = 624;        // native: align_up(616, 16) = 624
const V12_15_ENGINE_OFF_SBF = 616;    // SBF: align_up(616, 8) = 616 (i128 align=8)
const V12_15_ACCOUNT_SIZE = 4400; // sizeof(Account) with 62 cohorts (default)
const V12_15_ACCOUNT_SIZE_SMALL = 920; // SBF sizeof(Account) with 8 cohorts (--features small, u128 align=8)
const V12_15_DEFAULT_MAX_ACCOUNTS = 2048; // was 4096, changed in v12.15

// V12_15 account field offsets (relative to account slot start):
const V12_15_ACCT_ACCOUNT_ID_OFF     = 0;   // u64
const V12_15_ACCT_CAPITAL_OFF        = 8;   // u128
const V12_15_ACCT_KIND_OFF           = 24;  // u8 + 7 pad
const V12_15_ACCT_PNL_OFF            = 32;  // i128
const V12_15_ACCT_RESERVED_PNL_OFF   = 48;  // u128
const V12_15_ACCT_POSITION_BASIS_Q_OFF = 64; // i128
const V12_15_ACCT_ADL_A_BASIS_OFF    = 80;  // u128
const V12_15_ACCT_ADL_K_SNAP_OFF     = 96;  // i128
const V12_15_ACCT_ADL_EPOCH_SNAP_OFF = 112; // u64
const V12_15_ACCT_ENTRY_PRICE_OFF    = 120; // u64 (NEW — re-added in v12.15)
const V12_15_ACCT_MATCHER_PROGRAM_OFF = 128; // Pubkey
const V12_15_ACCT_MATCHER_CONTEXT_OFF = 160; // Pubkey
const V12_15_ACCT_OWNER_OFF          = 192; // Pubkey
const V12_15_ACCT_FEE_CREDITS_OFF    = 224; // i128 (16)
const V12_15_ACCT_FEES_EARNED_TOTAL_OFF = 240; // u128 (16)
// exact_reserve_cohorts: [ReserveCohort; 62], each 64 bytes = 3968 bytes
const V12_15_ACCT_EXACT_RESERVE_COHORTS_OFF = 256;  // 62 * 64 = 3968 bytes
const V12_15_ACCT_EXACT_COHORT_COUNT_OFF = 4224;    // u8 (+ 15 pad = 16 bytes)
const V12_15_ACCT_OVERFLOW_OLDER_OFF = 4240;         // ReserveCohort (64 bytes)
const V12_15_ACCT_OVERFLOW_OLDER_PRESENT_OFF = 4304; // u8 (+ 15 pad = 16 bytes)
const V12_15_ACCT_OVERFLOW_NEWEST_OFF = 4320;        // ReserveCohort (64 bytes)
const V12_15_ACCT_OVERFLOW_NEWEST_PRESENT_OFF = 4384; // u8 (+ 15 pad = 16 bytes)

// V12_15 RiskParams offsets (relative to params base):
// sizeof(RiskParams) = 192
const V12_15_PARAMS_SIZE = 192;
const V12_15_PARAMS_MAX_ACCOUNTS_OFF  = 24;  // u64 (moved from 32)
const V12_15_PARAMS_INSURANCE_FLOOR_OFF = 144; // u128
const V12_15_PARAMS_H_MIN_OFF         = 160; // u64 (was warmup_period_slots)
const V12_15_PARAMS_H_MAX_OFF         = 168; // u64 (NEW)

// V12_15 RiskEngine offsets (relative to ENGINE_OFF):
// vault(16) + InsuranceFund(16) + RiskParams(192) = 224 before current_slot
const V12_15_ENGINE_PARAMS_OFF        = 32;   // vault(16) + InsuranceFund(16) = 32
const V12_15_ENGINE_CURRENT_SLOT_OFF  = 224;  // u64
// 8-byte gap at 232 (padding or auxiliary field before i128-aligned funding_rate_e9)
const V12_15_ENGINE_FUNDING_RATE_E9_OFF = 240; // i128 (NEW — was i64 funding_rate at 224)
const V12_15_ENGINE_MARKET_MODE_OFF   = 256;  // u8 (NEW — 0=Live, 1=Resolved)
// c_tot at 344, pnl_pos_tot at 368, pnl_matured_pos_tot at 384 (NEW)
const V12_15_ENGINE_C_TOT_OFF         = 344;  // u128
const V12_15_ENGINE_PNL_POS_TOT_OFF   = 368;  // u128
const V12_15_ENGINE_PNL_MATURED_POS_TOT_OFF = 384; // u128 (NEW)
// Bitmap offset derived from SLAB_LEN=1,128,448 for n=256 and accountsOff_rel=1424:
// bitmapOff = 1424 - ceil(256/64)*8 - 18 - 256*2 = 1424 - 32 - 18 - 512 = 862
const V12_15_ENGINE_BITMAP_OFF        = 862;

// V12_15 size map for layout detection
const V12_15_SIZES = new Map<number, number>();

// ---- V12_17 layout constants (two-bucket warmup, per-side funding) ----
// Account: 368 bytes (native, i128 align=16) / 352 bytes (SBF, i128 align=8).
//   62-cohort reserve queue → two-bucket warmup (sched_* + pending_*).
//   Removed: account_id, entry_price, fees_earned_total, cohort arrays.
//   Added: f_snap(i128), sched_present/remaining_q/anchor_q/start_slot/horizon/release_q,
//          pending_present/remaining_q/horizon/created_slot.
// RiskParams sizeof=192 (native) / 184 (SBF). Same fields as v12.15.
// RiskEngine: vault(16) + InsuranceFund(16) + RiskParams = 224 (native) / 216 (SBF) before current_slot.
//   Removed: funding_rate_e9 (stored). Added: per-side f_long_num/f_short_num cumulative funding.
//   Added: market_mode, resolved_*, neg_pnl_account_count, fund_px_last.
//   MAX_ACCOUNTS default=4096 (was 2048 in v12.15).
// RISK_BUF_OFF = ENGINE_OFF + ENGINE_LEN; RISK_BUF_LEN = 160.
// On-chain (SBF) SLAB_LEN includes RISK_BUF; native test SLAB_LEN also includes it.

// MarketConfig size — 512 bytes post Phase A/B/E (fork addition of 80 bytes:
//   max_pnl_cap, last_audit_pause_slot, oi_cap_multiplier_bps, dispute_window_slots,
//   dispute_bond_amount, lp_collateral_enabled, lp_collateral_ltv_bps,
//   _new_fields_pad, pending_admin[32]).
// Verified against percolator-prog/src/percolator.rs::MarketConfig via
//   size_of::<MarketConfig>() = 512 (both native and SBF — u128 fields happen
//   to land on 16-aligned offsets, so the u128 align=8 vs 16 rule is a no-op).

// Native (i128 align=16)
const V12_17_ENGINE_OFF           = 592;  // align_up(72 + 512, 16) = 592
const V12_17_ACCOUNT_SIZE         = 368;
const V12_17_ENGINE_BITMAP_OFF    = 752;  // offset_of!(RiskEngine, used) on native — relative, unchanged
const V12_17_DEFAULT_MAX_ACCOUNTS = 4096;
const V12_17_RISK_BUF_LEN         = 160;
// Per-account generation table appended after RISK_BUF in percolator-prog.
// See percolator-prog/src/percolator.rs:87 — GEN_TABLE_LEN = MAX_ACCOUNTS * 8.
const V12_17_GEN_TABLE_ENTRY      = 8;

// SBF (i128 align=8)
const V12_17_ENGINE_OFF_SBF       = 584;  // align_up(72 + 512, 8) = 584
const V12_17_ACCOUNT_SIZE_SBF     = 352;
const V12_17_ENGINE_BITMAP_OFF_SBF = 712; // offset_of!(RiskEngine, used) on SBF — relative, unchanged

// V12_17 account field offsets (native — SBF offsets are 8 bytes less for fields after kind)
const V12_17_ACCT_CAPITAL_OFF         = 0;    // U128=[u64;2]
const V12_17_ACCT_KIND_OFF            = 16;   // u8
const V12_17_ACCT_PNL_OFF             = 32;   // i128 (native 16-align pad from 17→32)
const V12_17_ACCT_RESERVED_PNL_OFF    = 48;   // u128
const V12_17_ACCT_POSITION_BASIS_Q_OFF = 64;  // i128
const V12_17_ACCT_ADL_A_BASIS_OFF     = 80;   // u128
const V12_17_ACCT_ADL_K_SNAP_OFF      = 96;   // i128
const V12_17_ACCT_F_SNAP_OFF          = 112;  // i128
const V12_17_ACCT_ADL_EPOCH_SNAP_OFF  = 128;  // u64
const V12_17_ACCT_MATCHER_PROGRAM_OFF = 136;  // [u8;32]
const V12_17_ACCT_MATCHER_CONTEXT_OFF = 168;  // [u8;32]
const V12_17_ACCT_OWNER_OFF           = 200;  // [u8;32]
const V12_17_ACCT_FEE_CREDITS_OFF     = 232;  // I128=[u64;2]
const V12_17_ACCT_SCHED_PRESENT_OFF   = 248;  // u8
const V12_17_ACCT_SCHED_REMAINING_Q_OFF = 256; // u128
const V12_17_ACCT_SCHED_ANCHOR_Q_OFF  = 272;  // u128
const V12_17_ACCT_SCHED_START_SLOT_OFF = 288; // u64
const V12_17_ACCT_SCHED_HORIZON_OFF   = 296;  // u64
const V12_17_ACCT_SCHED_RELEASE_Q_OFF = 304;  // u128
const V12_17_ACCT_PENDING_PRESENT_OFF = 320;  // u8
const V12_17_ACCT_PENDING_REMAINING_Q_OFF = 336; // u128
const V12_17_ACCT_PENDING_HORIZON_OFF = 352;  // u64
const V12_17_ACCT_PENDING_CREATED_SLOT_OFF = 360; // u64

// V12_17 RiskEngine field offsets (native, relative to engine start)
const V12_17_ENGINE_PARAMS_OFF          = 32;   // vault(16) + InsuranceFund(16)
const V12_17_ENGINE_CURRENT_SLOT_OFF    = 224;  // params starts at 32, size 192 → 224
const V12_17_ENGINE_MARKET_MODE_OFF     = 232;  // u8 (MarketMode enum)
const V12_17_ENGINE_RESOLVED_PRICE_OFF  = 240;  // u64
const V12_17_ENGINE_RESOLVED_K_LONG_OFF = 304;  // i128
const V12_17_ENGINE_RESOLVED_K_SHORT_OFF = 320; // i128
const V12_17_ENGINE_RESOLVED_LIVE_PRICE_OFF = 336; // u64
const V12_17_ENGINE_LAST_CRANK_SLOT_OFF = 344;  // u64 — verified via offset_of!(RiskEngine, last_crank_slot)
const V12_17_ENGINE_C_TOT_OFF          = 352;  // U128
const V12_17_ENGINE_PNL_POS_TOT_OFF    = 368;  // u128
const V12_17_ENGINE_PNL_MATURED_POS_TOT_OFF = 384; // u128
const V12_17_ENGINE_GC_CURSOR_OFF      = 400;  // u16
const V12_17_ENGINE_OI_EFF_LONG_OFF    = 528;  // u128 — oi_eff_long_q
const V12_17_ENGINE_OI_EFF_SHORT_OFF   = 544;  // u128 — oi_eff_short_q
const V12_17_ENGINE_NEG_PNL_COUNT_OFF  = 648;  // u64
const V12_17_ENGINE_LAST_ORACLE_PRICE_OFF = 656; // u64
const V12_17_ENGINE_FUND_PX_LAST_OFF   = 664;  // u64
const V12_17_ENGINE_F_LONG_NUM_OFF     = 688;  // i128
const V12_17_ENGINE_F_SHORT_NUM_OFF    = 704;  // i128

// SBF engine field offsets differ because RiskParams=184 (not 192) shifts everything after params.
// Offset delta: native params=192, SBF params=184, so diff=8 starting from current_slot.
// Additional differences accumulate from i128 alignment padding changes within the engine struct.
const V12_17_SBF_ENGINE_CURRENT_SLOT_OFF = 216;
const V12_17_SBF_ENGINE_MARKET_MODE_OFF  = 224;
const V12_17_SBF_ENGINE_LAST_CRANK_SLOT_OFF = 328; // u64 — native 344 − 16 (resolved u128 pad)
const V12_17_SBF_ENGINE_C_TOT_OFF       = 336;
const V12_17_SBF_ENGINE_PNL_POS_TOT_OFF = 352;
const V12_17_SBF_ENGINE_PNL_MATURED_POS_TOT_OFF = 368;
const V12_17_SBF_ENGINE_GC_CURSOR_OFF   = 384;   // u16 — native 400 − 16
const V12_17_SBF_ENGINE_OI_EFF_LONG_OFF = 504;   // u128 — native 528 − 24 (adl u128 pad)
const V12_17_SBF_ENGINE_OI_EFF_SHORT_OFF = 520;  // u128 — native 544 − 24
const V12_17_SBF_ENGINE_NEG_PNL_COUNT_OFF = 616;
const V12_17_SBF_ENGINE_LAST_ORACLE_PRICE_OFF = 624;
const V12_17_SBF_ENGINE_FUND_PX_LAST_OFF = 632;
const V12_17_SBF_ENGINE_F_LONG_NUM_OFF  = 648;
const V12_17_SBF_ENGINE_F_SHORT_NUM_OFF = 664;

// V12_17 size map for layout detection
const V12_17_SIZES = new Map<number, number>();

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
  // V12_15: account_size=4400, ENGINE_OFF=624. MAX_ACCOUNTS default=2048, also support 256/1024/4096.
  V12_15_SIZES.set(computeSlabSize(V12_15_ENGINE_OFF, V12_15_ENGINE_BITMAP_OFF, V12_15_ACCOUNT_SIZE, n, 18), n);
}
// V12_15 additional tier: MAX_ACCOUNTS=2048 (new default, changed from 4096 in v12.15).
V12_15_SIZES.set(computeSlabSize(V12_15_ENGINE_OFF, V12_15_ENGINE_BITMAP_OFF, V12_15_ACCOUNT_SIZE, 2048, 18), 2048);
// V12_15_SMALL: --features small (8 cohorts, 944-byte accounts). Hardcoded sizes verified via cargo test.
V12_15_SIZES.set(237512, 256);  // small (SBF): 256 accounts, 8 cohorts, SLAB_LEN=237512 (SBF u128 align=8)

// V12_17 sizes — native and SBF, with and without RISK_BUF (160 bytes).
// Native: Account align=16 → accountsOff alignment is 16, not 8.
// SBF: Account align=8 → accountsOff alignment is 8.
// Both on-chain and wrapper tests use SLAB_LEN which includes RISK_BUF.
// postBitmap=4 (num_used_accounts: u16 + free_head: u16, no next_account_id or pad).
const V12_17_TIERS = [256, 1024, 4096] as const;
for (const n of V12_17_TIERS) {
  const bitmapWords = Math.ceil(n / 64);
  const bitmapBytes = bitmapWords * 8;
  const postBitmap = 4;
  const nextFreeBytes = n * 2;

  // Native (i128 align=16, Account align=16)
  const preAccNative = V12_17_ENGINE_BITMAP_OFF + bitmapBytes + postBitmap + nextFreeBytes;
  const accountsOffNative = Math.ceil(preAccNative / 16) * 16; // align to Account alignment (16)
  const nativeSize = V12_17_ENGINE_OFF + accountsOffNative + n * V12_17_ACCOUNT_SIZE + V12_17_RISK_BUF_LEN + n * V12_17_GEN_TABLE_ENTRY;
  V12_17_SIZES.set(nativeSize, n);

  // SBF (i128 align=8, Account align=8)
  const preAccSbf = V12_17_ENGINE_BITMAP_OFF_SBF + bitmapBytes + postBitmap + nextFreeBytes;
  const accountsOffSbf = Math.ceil(preAccSbf / 8) * 8;
  const sbfSize = V12_17_ENGINE_OFF_SBF + accountsOffSbf + n * V12_17_ACCOUNT_SIZE_SBF + V12_17_RISK_BUF_LEN + n * V12_17_GEN_TABLE_ENTRY;
  V12_17_SIZES.set(sbfSize, n);
}

// ---- V12_19 layout constants ----
// AUTHORITATIVE SBF VALUES extracted via deliberately-wrong const assertions
// in the wrapper compiled with `cargo build-sbf --features small`. Every value
// below comes from a Rust compile-error message that revealed the real SBF
// offset. Source: 2026-04-28 SBF probe session, see audit notes.
//
// V12_19 vs V12_17 SBF differences:
// - HEADER_LEN: 72 -> 136 (header gained insurance_authority + insurance_operator)
// - CONFIG_LEN: 512 -> 480 (dropped max_insurance_floor and _iw_padding2)
// - ENGINE_OFF: 584 -> 616
// - ACCOUNT_SIZE: 352 -> 360
// - SLAB_LEN small: 94168 -> 96784 (cu_benchmark.rs constant is stale)
// - RiskEngine grew substantially; accounts now inline within engine struct.
const V12_19_HEADER_LEN_SBF      = 136;
const V12_19_CONFIG_LEN          = 480;
const V12_19_ENGINE_OFF_SBF      = 616;
const V12_19_ACCOUNT_SIZE_SBF    = 360;
const V12_19_SBF_RISK_BUF_LEN    = 160;
const V12_19_SBF_GEN_TABLE_ENTRY = 8;

// Within RiskEngine, relative to engine start (probe-confirmed on the live
// af43efc mainnet small-tier slab). Some bitmap-region offsets depend on
// MAX_ACCOUNTS; small (256) shown here.
const V12_19_SBF_ENGINE_BITMAP_OFF        = 736;  // [u64; ceil(MAX/64)] starts here
const V12_19_SBF_ENGINE_NUM_USED_OFF_S    = 768;  // small: bitmap is 32 bytes
const V12_19_SBF_ENGINE_FREE_HEAD_OFF_S   = 770;
const V12_19_SBF_ENGINE_NEXT_FREE_OFF_S   = 772;  // [u16; 256] for small
const V12_19_SBF_ENGINE_PREV_FREE_OFF_S   = 1284; // small: after next_free 512 bytes
const V12_19_SBF_ENGINE_ACCOUNTS_OFF_S    = 1800; // small: after prev_free + 4-byte align

// V12_19 SBF RiskEngine field offsets (rel to engine start, probe-confirmed):
const V12_19_SBF_ENGINE_PARAMS_OFF              = 32;
const V12_19_SBF_ENGINE_PARAMS_SIZE             = 168;  // current_slot at 200, params is 168 bytes
const V12_19_SBF_ENGINE_CURRENT_SLOT_OFF        = 200;
const V12_19_SBF_ENGINE_MARKET_MODE_OFF         = 208;
const V12_19_SBF_ENGINE_RESOLVED_PRICE_OFF      = 216;
const V12_19_SBF_ENGINE_RESOLVED_LIVE_PRICE_OFF = 304;
const V12_19_SBF_ENGINE_C_TOT_OFF               = 312;
const V12_19_SBF_ENGINE_PNL_POS_TOT_OFF         = 328;
const V12_19_SBF_ENGINE_PNL_MATURED_POS_TOT_OFF = 344;
const V12_19_SBF_ENGINE_OI_EFF_LONG_OFF         = 472;
const V12_19_SBF_ENGINE_OI_EFF_SHORT_OFF        = 488;
const V12_19_SBF_ENGINE_NEG_PNL_COUNT_OFF       = 584;
const V12_19_SBF_ENGINE_RR_CURSOR_OFF           = 592;  // replaces V12_17 gc_cursor
const V12_19_SBF_ENGINE_LAST_ORACLE_PRICE_OFF   = 624;
const V12_19_SBF_ENGINE_FUND_PX_LAST_OFF        = 632;
const V12_19_SBF_ENGINE_LAST_MARKET_SLOT_OFF    = 640;  // replaces V12_17 last_crank_slot
const V12_19_SBF_ENGINE_F_LONG_NUM_OFF          = 648;
const V12_19_SBF_ENGINE_F_SHORT_NUM_OFF         = 664;

// V12_19 SBF MarketConfig field offsets (rel to config start, probe-confirmed):
const V12_19_SBF_CONFIG_HYPERP_AUTH_OFF         = 144;
const V12_19_SBF_CONFIG_LAST_EFFECTIVE_OFF      = 192;
const V12_19_SBF_CONFIG_TVL_INSURANCE_CAP_OFF   = 202;
const V12_19_SBF_CONFIG_ORACLE_PRICE_CAP_OFF    = 216;
const V12_19_SBF_CONFIG_MIN_ORACLE_CAP_OFF      = 224;
const V12_19_SBF_CONFIG_MAINTENANCE_FEE_OFF     = 320;
const V12_19_SBF_CONFIG_DEX_POOL_OFF            = 368;
const V12_19_SBF_CONFIG_MAX_PNL_CAP_OFF         = 400;
const V12_19_SBF_CONFIG_OI_CAP_MULT_OFF         = 416;
const V12_19_SBF_CONFIG_PENDING_ADMIN_OFF       = 448;

// V12_19 SLAB_LEN values: probe-confirmed for small. Derived for other tiers
// via the same formula: SLAB_LEN = ENGINE_OFF + ENGINE_LEN(N) + RISK_BUF_LEN
//                     + GEN_TABLE_LEN(N), where ENGINE_LEN(N) = 712 + bitmap_bytes
//                     + 4 (num_used + free_head) + 2N (next_free) + 2N (prev_free)
//                     + (8-byte align pad) + N*360 (accounts).
// Result after af43efc wrapper redeploy: micro=26872, small=96784
// (mainnet probe-confirmed), medium=376432, large=1495024.
// NOTE: cu_benchmark.rs constants (19640/94168/372280/1484728) are STALE for v12.19.
const V12_19_SIZES = new Map<number, number>([
  [26872, 64],      // --features micro (derived)
  [96784, 256],     // --features small (probe-confirmed; deployed mainnet ESa89R5...)
  [376432, 1024],   // --features medium (derived)
  [1495024, 4096],  // default features / large (derived)
]);

/**
 * V12_19 slab layout. Probe-confirmed SBF values from compiled wrapper.
 *
 * Major structural difference vs V12_17 SBF: accounts array is INLINE within
 * RiskEngine (was separate region in V12_17). Bitmap moved from rel-engine
 * 736 area to same offset but the post-bitmap region now contains both
 * `next_free` and `prev_free` arrays (v12.19 added prev_free), plus padding
 * before the inline accounts.
 *
 * For the small tier (MAX_ACCOUNTS=256), accounts start at engineOff + 1800.
 * For other tiers, the offset shifts because next_free/prev_free sizes scale
 * linearly with MAX_ACCOUNTS.
 */
function buildLayoutV12_19(maxAccounts: number, _dataLen: number): SlabLayout {
  // Compute layout-dependent offsets for this tier.
  const bitmapWords = Math.ceil(maxAccounts / 64);
  const bitmapBytes = bitmapWords * 8;
  const numUsedOff = V12_19_SBF_ENGINE_BITMAP_OFF + bitmapBytes;        // bitmap end
  const freeHeadOff = numUsedOff + 2;                                    // after num_used u16
  const nextFreeOff = freeHeadOff + 2;                                   // after free_head u16
  const prevFreeOff = nextFreeOff + maxAccounts * 2;                     // after next_free [u16; N]
  const accountsRelEnd = prevFreeOff + maxAccounts * 2;                  // after prev_free [u16; N]
  const accountsOffRel = Math.ceil(accountsRelEnd / 8) * 8;              // 8-align Account
  const accountsOff = V12_19_ENGINE_OFF_SBF + accountsOffRel;            // absolute slab offset

  // Inherit Account-internal field offsets from V12_17 (they're the same since
  // the Account struct definition is identical between v12.17 and v12.19;
  // the +8 byte size diff is from trailing padding, not field reordering).
  const base = buildLayoutV12_17(maxAccounts, /* synthetic V12_17 SBF size */ 94168);

  return {
    ...base,
    headerLen: V12_19_HEADER_LEN_SBF,
    configLen: V12_19_CONFIG_LEN,
    configOffset: V12_19_HEADER_LEN_SBF,    // header runs 0..136 in v12.19
    engineOff: V12_19_ENGINE_OFF_SBF,
    accountSize: V12_19_ACCOUNT_SIZE_SBF,
    accountsOff,
    bitmapWords,
    paramsSize: V12_19_SBF_ENGINE_PARAMS_SIZE,
    engineBitmapOff: V12_19_SBF_ENGINE_BITMAP_OFF,
    // V12_19-specific engine field offsets (probe-confirmed):
    engineCurrentSlotOff: V12_19_SBF_ENGINE_CURRENT_SLOT_OFF,
    engineCTotOff: V12_19_SBF_ENGINE_C_TOT_OFF,
    enginePnlPosTotOff: V12_19_SBF_ENGINE_PNL_POS_TOT_OFF,
    engineLongOiOff: V12_19_SBF_ENGINE_OI_EFF_LONG_OFF,
    engineShortOiOff: V12_19_SBF_ENGINE_OI_EFF_SHORT_OFF,
    // last_market_slot replaces V12_17 last_crank_slot semantics.
    engineLastCrankSlotOff: V12_19_SBF_ENGINE_LAST_MARKET_SLOT_OFF,
    // rr_cursor_position replaces V12_17 gc_cursor semantics.
    engineGcCursorOff: V12_19_SBF_ENGINE_RR_CURSOR_OFF,
  };
}

// SBF-specific V12_1 sizes (verified via cargo build-sbf compile-time offset_of! assertions).
// SBF has ENGINE_OFF=616 (not 648) because HEADER=72 + CONFIG=544 = 616, align_up(616,8)=616.
// Account=280 bytes on SBF (vs 320 on aarch64) due to u128 align=8 vs 16.
// Bitmap at engine+584 (used field in RiskEngine).
const V12_1_SBF_ACCOUNT_SIZE = 280;
const V12_1_SBF_ENGINE_OFF = 616;
const V12_1_SBF_BITMAP_OFF = 584; // offset_of!(RiskEngine, used) on SBF
for (const [, n] of [["Micro", 64], ["Small", 256], ["Medium", 1024], ["Large", 4096]] as const) {
  const bitmapBytes = Math.ceil(n / 64) * 8;
  const preAccLen = V12_1_SBF_BITMAP_OFF + bitmapBytes + 18 + n * 2;
  const accountsOff = Math.ceil(preAccLen / 8) * 8;
  const total = V12_1_SBF_ENGINE_OFF + accountsOff + n * V12_1_SBF_ACCOUNT_SIZE;
  V12_1_SIZES.set(total, n);
}
// V12_1_EP: entry_price re-added, accountSize=288 on SBF. Same engineOff/bitmapOff.
const V12_1_EP_SIZES = new Map<number, number>();
for (const [, n] of [["Micro", 64], ["Small", 256], ["Medium", 1024], ["Large", 4096]] as const) {
  const bitmapBytes = Math.ceil(n / 64) * 8;
  const preAccLen = V12_1_SBF_BITMAP_OFF + bitmapBytes + 18 + n * 2;
  const accountsOff = Math.ceil(preAccLen / 8) * 8;
  const total = V12_1_SBF_ENGINE_OFF + accountsOff + n * V12_1_EP_SBF_ACCOUNT_SIZE;
  V12_1_EP_SIZES.set(total, n);
}

/**
 * V2 slab tier sizes (small and large) for discovery.
 * V2 uses ENGINE_OFF=600, BITMAP_OFF=432, ACCOUNT_SIZE=248, postBitmap=18.
 * Sizes overlap with V1D (postBitmap=2) — disambiguation requires reading the version field.
 */
export const SLAB_TIERS_V2 = Object.freeze({
  small: { maxAccounts: 256,  dataSize: 65_088,    label: "Small",  description: "256 slots (V2 BPF intermediate)" },
  large: { maxAccounts: 4096, dataSize: 1_025_568, label: "Large",  description: "4,096 slots (V2 BPF intermediate)" },
} as const);

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
Object.freeze(SLAB_TIERS_V1M);

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
Object.freeze(SLAB_TIERS_V1M2);

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
Object.freeze(SLAB_TIERS_V_ADL);

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
    acctOwnerOff: isV1Legacy ? V1_LEGACY_ACCT_OWNER_OFF : ACCT_OWNER_OFF,

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
Object.freeze(SLAB_TIERS_V_SETDEXPOOL);

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
Object.freeze(SLAB_TIERS_V12_1);

/**
 * V12_15 slab tier sizes — percolator v12.15 (engine+prog sync).
 * ENGINE_OFF=624, BITMAP_OFF=862 (relative), ACCOUNT_SIZE=4400, postBitmap=18.
 * MAX_ACCOUNTS default changed from 4096 to 2048. Verified SLAB_LEN=1,128,448 for small (256).
 * Account layout completely redesigned with reserve cohort arrays.
 */
export const SLAB_TIERS_V12_15: Record<string, { maxAccounts: number; dataSize: number; label: string; description: string }> = {};
for (const [label, n] of [["Micro", 64], ["Small", 256], ["Medium", 1024], ["Medium2048", 2048], ["Large", 4096]] as const) {
  const size = computeSlabSize(V12_15_ENGINE_OFF, V12_15_ENGINE_BITMAP_OFF, V12_15_ACCOUNT_SIZE, n, 18);
  SLAB_TIERS_V12_15[label.toLowerCase()] = { maxAccounts: n, dataSize: size, label, description: `${n} slots (v12.15)` };
}
Object.freeze(SLAB_TIERS_V12_15);

/**
 * V12_17 slab tier sizes — percolator v12.17 (two-bucket warmup, per-side funding).
 * Uses SBF sizes (on-chain layout) for the dataSize values.
 * ENGINE_OFF=504 (SBF), ACCOUNT_SIZE=352 (SBF), BITMAP_OFF=712 (SBF), postBitmap=4.
 * RISK_BUF_LEN=160 appended after engine.
 * Supported tiers: small(256), medium(1024), large(4096).
 */
export const SLAB_TIERS_V12_17: Record<string, { maxAccounts: number; dataSize: number; label: string; description: string }> = {};
for (const [label, n] of [["Small", 256], ["Medium", 1024], ["Large", 4096]] as const) {
  const bitmapBytes = Math.ceil(n / 64) * 8;
  const preAcc = V12_17_ENGINE_BITMAP_OFF_SBF + bitmapBytes + 4 + n * 2;
  const accountsOff = Math.ceil(preAcc / 8) * 8;
  const size = V12_17_ENGINE_OFF_SBF + accountsOff + n * V12_17_ACCOUNT_SIZE_SBF + V12_17_RISK_BUF_LEN + n * V12_17_GEN_TABLE_ENTRY;
  SLAB_TIERS_V12_17[label.toLowerCase()] = { maxAccounts: n, dataSize: size, label, description: `${n} slots (v12.17)` };
}
Object.freeze(SLAB_TIERS_V12_17);

/**
 * V12_19 slab tier sizes (probe-confirmed via cargo build-sbf compile-time
 * assertions on 2026-04-28). Used by `discoverMarkets` to filter program
 * accounts by dataSize. Without this tier set, v12.19 slabs (the only kind
 * the deployed mainnet program ESa89R5... produces post-2026-04-28 upgrade)
 * fall through to the memcmp fallback path with no layout hint.
 *
 * Sizes derived from V12_19_SIZES Map (defined earlier in this file at the
 * V12_19 layout block). Kept as Record for parity with other SLAB_TIERS_*
 * exports consumed by discovery.ts.
 */
export const SLAB_TIERS_V12_19: Record<string, { maxAccounts: number; dataSize: number; label: string; description: string }> = Object.freeze({
  micro:  { maxAccounts: 64,    dataSize: 26_872,    label: "Micro",  description: "64 slots (v12.19, --features micro)" },
  small:  { maxAccounts: 256,   dataSize: 96_784,    label: "Small",  description: "256 slots (v12.19, --features small) — deployed mainnet ESa89R5..." },
  medium: { maxAccounts: 1024,  dataSize: 376_432,   label: "Medium", description: "1024 slots (v12.19, --features medium)" },
  large:  { maxAccounts: 4096,  dataSize: 1_495_024, label: "Large",  description: "4096 slots (v12.19, default features)" },
});

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
  // SBF vs host detection via size comparison.
  // SBF (deployed): HEADER=72, CONFIG=544, ENGINE_OFF=616, ACCOUNT=280, BITMAP=engine+584
  // Host (tests):   HEADER=72, CONFIG=576, ENGINE_OFF=648, ACCOUNT=320, BITMAP=engine+1016
  // All SBF offsets verified via `cargo build-sbf` compile-time offset_of! assertions.
  const hostSize = computeSlabSize(V12_1_ENGINE_OFF, V12_1_ENGINE_BITMAP_OFF, V12_1_ACCOUNT_SIZE, maxAccounts, 18);
  const isSbf = dataLen !== undefined && dataLen !== hostSize;
  const engineOff = isSbf ? V12_1_SBF_ENGINE_OFF : V12_1_ENGINE_OFF;
  const bitmapOff = isSbf ? V12_1_SBF_BITMAP_OFF : V12_1_ENGINE_BITMAP_OFF;
  const accountSize = isSbf ? V12_1_ACCOUNT_SIZE_SBF : V12_1_ACCOUNT_SIZE;
  const bitmapWords = Math.ceil(maxAccounts / 64);
  const bitmapBytes = bitmapWords * 8;
  const postBitmap = 18;
  const nextFreeBytes = maxAccounts * 2;
  const preAccountsLen = bitmapOff + bitmapBytes + postBitmap + nextFreeBytes;
  const accountsOffRel = Math.ceil(preAccountsLen / 8) * 8;

  return {
    version: 1,
    headerLen: V0_HEADER_LEN,     // 72
    configOffset: V0_HEADER_LEN,  // 72
    configLen: isSbf ? 544 : 576,
    reservedOff: V1_RESERVED_OFF,
    engineOff,
    accountSize,
    maxAccounts,
    bitmapWords,
    accountsOff: engineOff + accountsOffRel,

    engineInsuranceOff: 16,
    engineParamsOff: isSbf ? V12_1_ENGINE_PARAMS_OFF_SBF : V12_1_ENGINE_PARAMS_OFF_HOST,
    paramsSize: isSbf ? V12_1_PARAMS_SIZE_SBF : V12_1_PARAMS_SIZE,
    // SBF engine offsets — all verified by cargo build-sbf offset_of! assertions.
    // Fields that don't exist in the deployed program are set to -1 on SBF.
    engineCurrentSlotOff: isSbf ? V12_1_SBF_OFF_CURRENT_SLOT : V12_1_ENGINE_CURRENT_SLOT_OFF,
    engineFundingIndexOff: isSbf ? -1 : V12_1_ENGINE_FUNDING_INDEX_OFF, // not in deployed struct
    engineLastFundingSlotOff: isSbf ? -1 : V12_1_ENGINE_LAST_FUNDING_SLOT_OFF, // not in deployed struct
    engineFundingRateBpsOff: isSbf ? V12_1_SBF_OFF_FUNDING_RATE : V12_1_ENGINE_FUNDING_RATE_BPS_OFF,
    engineMarkPriceOff: isSbf ? V12_1_SBF_OFF_MARK_PRICE_E6 : V12_1_ENGINE_MARK_PRICE_OFF,
    engineLastCrankSlotOff: isSbf ? V12_1_SBF_OFF_LAST_CRANK_SLOT : V12_1_ENGINE_LAST_CRANK_SLOT_OFF,
    engineMaxCrankStalenessOff: isSbf ? V12_1_SBF_OFF_MAX_CRANK_STALENESS : V12_1_ENGINE_MAX_CRANK_STALENESS_OFF,
    engineTotalOiOff: isSbf ? V12_1_SBF_OFF_TOTAL_OI : V12_1_ENGINE_TOTAL_OI_OFF,
    engineLongOiOff: isSbf ? V12_1_SBF_OFF_LONG_OI : V12_1_ENGINE_LONG_OI_OFF,
    engineShortOiOff: isSbf ? V12_1_SBF_OFF_SHORT_OI : V12_1_ENGINE_SHORT_OI_OFF,
    engineCTotOff: isSbf ? V12_1_SBF_OFF_C_TOT : V12_1_ENGINE_C_TOT_OFF,
    enginePnlPosTotOff: isSbf ? V12_1_SBF_OFF_PNL_POS_TOT : V12_1_ENGINE_PNL_POS_TOT_OFF,
    engineLiqCursorOff: isSbf ? V12_1_SBF_OFF_LIQ_CURSOR : V12_1_ENGINE_LIQ_CURSOR_OFF,
    engineGcCursorOff: isSbf ? V12_1_SBF_OFF_GC_CURSOR : V12_1_ENGINE_GC_CURSOR_OFF,
    engineLastSweepStartOff: isSbf ? V12_1_SBF_OFF_LAST_SWEEP_START : V12_1_ENGINE_LAST_SWEEP_START_OFF,
    engineLastSweepCompleteOff: isSbf ? V12_1_SBF_OFF_LAST_SWEEP_COMPLETE : V12_1_ENGINE_LAST_SWEEP_COMPLETE_OFF,
    engineCrankCursorOff: isSbf ? V12_1_SBF_OFF_CRANK_CURSOR : V12_1_ENGINE_CRANK_CURSOR_OFF,
    engineSweepStartIdxOff: isSbf ? V12_1_SBF_OFF_SWEEP_START_IDX : V12_1_ENGINE_SWEEP_START_IDX_OFF,
    engineLifetimeLiquidationsOff: isSbf ? V12_1_SBF_OFF_LIFETIME_LIQUIDATIONS : V12_1_ENGINE_LIFETIME_LIQUIDATIONS_OFF,
    engineLifetimeForceClosesOff: isSbf ? -1 : V12_1_ENGINE_LIFETIME_FORCE_CLOSES_OFF, // not in deployed struct
    engineNetLpPosOff: isSbf ? -1 : V12_1_ENGINE_NET_LP_POS_OFF,           // not in deployed struct
    engineLpSumAbsOff: isSbf ? -1 : V12_1_ENGINE_LP_SUM_ABS_OFF,           // not in deployed struct
    engineLpMaxAbsOff: isSbf ? -1 : V12_1_ENGINE_LP_MAX_ABS_OFF,           // not in deployed struct
    engineLpMaxAbsSweepOff: isSbf ? -1 : V12_1_ENGINE_LP_MAX_ABS_SWEEP_OFF, // not in deployed struct
    engineEmergencyOiModeOff: isSbf ? -1 : V12_1_ENGINE_EMERGENCY_OI_MODE_OFF, // not in deployed struct
    engineEmergencyStartSlotOff: isSbf ? -1 : V12_1_ENGINE_EMERGENCY_START_SLOT_OFF, // not in deployed struct
    engineLastBreakerSlotOff: isSbf ? -1 : V12_1_ENGINE_LAST_BREAKER_SLOT_OFF, // not in deployed struct
    engineBitmapOff: bitmapOff,
    postBitmap: 18,
    acctOwnerOff: V12_1_ACCT_OWNER_OFF,

    // InsuranceFund on deployed program is just {balance: U128} = 16 bytes.
    // No isolated_balance or insurance_isolation_bps fields.
    hasInsuranceIsolation: !isSbf,
    engineInsuranceIsolatedOff: isSbf ? -1 : 48,
    engineInsuranceIsolationBpsOff: isSbf ? -1 : 64,
  };
}

/**
 * V12_1 with entry_price re-added (SBF only, accountSize=288).
 * Same engine layout as V12_1 SBF, but account offsets shift +8 after entry_price.
 */
function buildLayoutV12_1EP(maxAccounts: number): SlabLayout {
  const engineOff = V12_1_SBF_ENGINE_OFF; // 616
  const bitmapOff = V12_1_SBF_BITMAP_OFF; // 584
  const accountSize = V12_1_EP_SBF_ACCOUNT_SIZE; // 288
  const bitmapWords = Math.ceil(maxAccounts / 64);
  const bitmapBytes = bitmapWords * 8;
  const postBitmap = 18;
  const nextFreeBytes = maxAccounts * 2;
  const preAccountsLen = bitmapOff + bitmapBytes + postBitmap + nextFreeBytes;
  const accountsOffRel = Math.ceil(preAccountsLen / 8) * 8;

  return {
    version: 1,
    headerLen: 72,
    configOffset: 72,
    configLen: 544,
    reservedOff: 80, // V1_RESERVED_OFF
    engineOff,
    accountSize,
    maxAccounts,
    bitmapWords,
    accountsOff: engineOff + accountsOffRel,

    engineInsuranceOff: 16,
    engineParamsOff: 32, // V12_1_ENGINE_PARAMS_OFF_SBF
    paramsSize: 184, // V12_1_PARAMS_SIZE_SBF
    // Engine offsets identical to V12_1 SBF
    engineCurrentSlotOff: V12_1_SBF_OFF_CURRENT_SLOT,
    engineFundingIndexOff: -1,
    engineLastFundingSlotOff: -1,
    engineFundingRateBpsOff: V12_1_SBF_OFF_FUNDING_RATE,
    engineMarkPriceOff: V12_1_SBF_OFF_MARK_PRICE_E6,
    engineLastCrankSlotOff: V12_1_SBF_OFF_LAST_CRANK_SLOT,
    engineMaxCrankStalenessOff: V12_1_SBF_OFF_MAX_CRANK_STALENESS,
    engineTotalOiOff: V12_1_SBF_OFF_TOTAL_OI,
    engineLongOiOff: V12_1_SBF_OFF_LONG_OI,
    engineShortOiOff: V12_1_SBF_OFF_SHORT_OI,
    engineCTotOff: V12_1_SBF_OFF_C_TOT,
    enginePnlPosTotOff: V12_1_SBF_OFF_PNL_POS_TOT,
    engineLiqCursorOff: V12_1_SBF_OFF_LIQ_CURSOR,
    engineGcCursorOff: V12_1_SBF_OFF_GC_CURSOR,
    engineLastSweepStartOff: V12_1_SBF_OFF_LAST_SWEEP_START,
    engineLastSweepCompleteOff: V12_1_SBF_OFF_LAST_SWEEP_COMPLETE,
    engineCrankCursorOff: V12_1_SBF_OFF_CRANK_CURSOR,
    engineSweepStartIdxOff: V12_1_SBF_OFF_SWEEP_START_IDX,
    engineLifetimeLiquidationsOff: V12_1_SBF_OFF_LIFETIME_LIQUIDATIONS,
    engineLifetimeForceClosesOff: -1,
    engineNetLpPosOff: -1,
    engineLpSumAbsOff: -1,
    engineLpMaxAbsOff: -1,
    engineLpMaxAbsSweepOff: -1,
    engineEmergencyOiModeOff: -1,
    engineEmergencyStartSlotOff: -1,
    engineLastBreakerSlotOff: -1,
    engineBitmapOff: bitmapOff,
    postBitmap: 18,
    // Account offsets — shifted +8 from V12_1 due to entry_price insertion
    acctOwnerOff: V12_1_EP_ACCT_OWNER_OFF, // 216 (was 208)
    hasInsuranceIsolation: false,
    engineInsuranceIsolatedOff: -1,
    engineInsuranceIsolationBpsOff: -1,
  };
}

/**
 * Build a SlabLayout for V12_15 slabs (percolator v12.15 engine+prog sync).
 * ENGINE_OFF=624, ACCOUNT_SIZE=4400, BITMAP_OFF=862 (relative to engineOff).
 * Account layout: new reserve cohort arrays, entry_price re-added at offset 120,
 * warmupStartedAtSlot/warmupSlopePerStep/lastFeeSlot removed.
 *
 * @param maxAccounts - Number of account slots (256, 1024, 2048, or 4096)
 */
function buildLayoutV12_15(maxAccounts: number, dataLen?: number): SlabLayout {
  // SBF has i128 align=8 (not 16), so ENGINE_OFF=616 (not 624) and params=184 (not 192).
  const isSbf = dataLen === 237512;
  const accountSize = isSbf ? V12_15_ACCOUNT_SIZE_SMALL : V12_15_ACCOUNT_SIZE;
  const engineOff = isSbf ? V12_15_ENGINE_OFF_SBF : V12_15_ENGINE_OFF;
  const bitmapOff = V12_15_ENGINE_BITMAP_OFF;
  // SBF small has different bitmap/accounts offsets due to u128 align=8
  const effectiveBitmapOff = isSbf ? 648 : bitmapOff; // SBF bitmap at engine+648 (verified on-chain)
  const bitmapWords = Math.ceil(maxAccounts / 64);
  const bitmapBytes = bitmapWords * 8;
  const postBitmap = 18;
  const nextFreeBytes = maxAccounts * 2;
  const preAccountsLen = effectiveBitmapOff + bitmapBytes + postBitmap + nextFreeBytes;
  const accountsOffRel = Math.ceil(preAccountsLen / 8) * 8;

  return {
    version: 2,
    headerLen: V0_HEADER_LEN,     // 72
    configOffset: V0_HEADER_LEN,  // 72
    configLen: 552,               // SBF CONFIG_LEN for v12.15
    reservedOff: V1_RESERVED_OFF, // 80
    engineOff,
    accountSize,
    maxAccounts,
    bitmapWords,
    accountsOff: engineOff + accountsOffRel,

    engineInsuranceOff: 16,
    engineParamsOff: V12_15_ENGINE_PARAMS_OFF, // 32
    paramsSize: isSbf ? 184 : V12_15_PARAMS_SIZE, // SBF=184 (no trailing pad), native=192
    engineCurrentSlotOff: isSbf ? 216 : V12_15_ENGINE_CURRENT_SLOT_OFF, // SBF=216, native=224
    engineFundingIndexOff: -1,                 // not present in v12.15 engine struct
    engineLastFundingSlotOff: -1,              // not present in v12.15 engine struct
    engineFundingRateBpsOff: isSbf ? 224 : V12_15_ENGINE_FUNDING_RATE_E9_OFF, // SBF=224, native=240
    engineMarkPriceOff: -1,                    // not present in v12.15
    engineLastCrankSlotOff: -1,                // not yet mapped
    engineMaxCrankStalenessOff: -1,            // not yet mapped
    engineTotalOiOff: -1,                      // not present in v12.15 engine
    engineLongOiOff: -1,                       // not present in v12.15 engine
    engineShortOiOff: -1,                      // not present in v12.15 engine
    engineCTotOff: isSbf ? 320 : V12_15_ENGINE_C_TOT_OFF,    // SBF=320 (verified on-chain), native=344
    enginePnlPosTotOff: isSbf ? 336 : V12_15_ENGINE_PNL_POS_TOT_OFF, // SBF=336 (verified), native=368
    engineLiqCursorOff: -1,                    // not yet mapped
    engineGcCursorOff: -1,                     // not yet mapped
    engineLastSweepStartOff: -1,               // not yet mapped
    engineLastSweepCompleteOff: -1,            // not yet mapped
    engineCrankCursorOff: -1,                  // not yet mapped
    engineSweepStartIdxOff: -1,                // not yet mapped
    engineLifetimeLiquidationsOff: -1,         // not yet mapped
    engineLifetimeForceClosesOff: -1,          // not present in v12.15
    engineNetLpPosOff: -1,                     // not present in v12.15
    engineLpSumAbsOff: -1,                     // not present in v12.15
    engineLpMaxAbsOff: -1,                     // not present in v12.15
    engineLpMaxAbsSweepOff: -1,                // not present in v12.15
    engineEmergencyOiModeOff: -1,              // not present in v12.15
    engineEmergencyStartSlotOff: -1,           // not present in v12.15
    engineLastBreakerSlotOff: -1,              // not present in v12.15
    engineBitmapOff: effectiveBitmapOff,        // SBF=640, native=862
    postBitmap,
    acctOwnerOff: V12_15_ACCT_OWNER_OFF, // 192

    hasInsuranceIsolation: false,
    engineInsuranceIsolatedOff: -1,
    engineInsuranceIsolationBpsOff: -1,
  };
}

/**
 * Build a SlabLayout for V12_17 slabs (two-bucket warmup, per-side funding).
 * Account: 368 bytes (native) / 352 bytes (SBF). No cohort arrays, no account_id, no entry_price.
 * Engine: per-side cumulative funding (f_long_num/f_short_num), no stored funding_rate_e9.
 * postBitmap=4 (num_used_accounts: u16 + free_head: u16).
 * RISK_BUF_LEN=160 appended after engine.
 */
function buildLayoutV12_17(maxAccounts: number, dataLen: number): SlabLayout {
  // Detect SBF vs native from account size and engine offset.
  // SBF: ACCOUNT_SIZE=352, ENGINE_OFF=504. Native: ACCOUNT_SIZE=368, ENGINE_OFF=512.
  const isSbf = (() => {
    // Compute expected native size for this tier
    const bitmapBytes = Math.ceil(maxAccounts / 64) * 8;
    const preAccNative = V12_17_ENGINE_BITMAP_OFF + bitmapBytes + 4 + maxAccounts * 2;
    const accountsOffNative = Math.ceil(preAccNative / 16) * 16;
    const nativeSize = V12_17_ENGINE_OFF + accountsOffNative + maxAccounts * V12_17_ACCOUNT_SIZE + V12_17_RISK_BUF_LEN + maxAccounts * V12_17_GEN_TABLE_ENTRY;
    return dataLen !== nativeSize;
  })();

  const engineOff = isSbf ? V12_17_ENGINE_OFF_SBF : V12_17_ENGINE_OFF;
  const accountSize = isSbf ? V12_17_ACCOUNT_SIZE_SBF : V12_17_ACCOUNT_SIZE;
  const bitmapOff = isSbf ? V12_17_ENGINE_BITMAP_OFF_SBF : V12_17_ENGINE_BITMAP_OFF;
  const bitmapWords = Math.ceil(maxAccounts / 64);
  const bitmapBytes = bitmapWords * 8;
  const postBitmap = 4;
  const nextFreeBytes = maxAccounts * 2;
  const preAccountsLen = bitmapOff + bitmapBytes + postBitmap + nextFreeBytes;
  const acctAlign = isSbf ? 8 : 16;
  const accountsOffRel = Math.ceil(preAccountsLen / acctAlign) * acctAlign;

  return {
    version: 2,
    headerLen: V0_HEADER_LEN,      // 72
    configOffset: V0_HEADER_LEN,   // 72
    // configLen = 512 (SBF-aligned MarketConfig size after Phase A/B/E).
    // Verified field-by-field against percolator-prog/src/percolator.rs MarketConfig struct.
    // Missing 80 bytes from prior value 432: max_pnl_cap, last_audit_pause_slot,
    // oi_cap_multiplier_bps, dispute_window_slots, dispute_bond_amount,
    // lp_collateral_enabled, lp_collateral_ltv_bps, _new_fields_pad, pending_admin.
    configLen: 512,
    reservedOff: V1_RESERVED_OFF,  // 80
    engineOff,
    accountSize,
    maxAccounts,
    bitmapWords,
    accountsOff: engineOff + accountsOffRel,

    engineInsuranceOff: 16,
    engineParamsOff: V12_17_ENGINE_PARAMS_OFF, // 32
    paramsSize: isSbf ? 184 : 192,
    engineCurrentSlotOff: isSbf ? V12_17_SBF_ENGINE_CURRENT_SLOT_OFF : V12_17_ENGINE_CURRENT_SLOT_OFF,
    engineFundingIndexOff: -1,                 // replaced by per-side f_long_num/f_short_num
    engineLastFundingSlotOff: -1,
    engineFundingRateBpsOff: -1,               // no stored funding rate in v12.17
    engineMarkPriceOff: -1,                    // v12.17 computes mark from state; no stored field
    engineLastCrankSlotOff: isSbf ? V12_17_SBF_ENGINE_LAST_CRANK_SLOT_OFF : V12_17_ENGINE_LAST_CRANK_SLOT_OFF,
    engineMaxCrankStalenessOff: -1,
    engineTotalOiOff: -1,                      // parseEngine sums long + short when total offset is -1
    engineLongOiOff: isSbf ? V12_17_SBF_ENGINE_OI_EFF_LONG_OFF : V12_17_ENGINE_OI_EFF_LONG_OFF,
    engineShortOiOff: isSbf ? V12_17_SBF_ENGINE_OI_EFF_SHORT_OFF : V12_17_ENGINE_OI_EFF_SHORT_OFF,
    engineCTotOff: isSbf ? V12_17_SBF_ENGINE_C_TOT_OFF : V12_17_ENGINE_C_TOT_OFF,
    enginePnlPosTotOff: isSbf ? V12_17_SBF_ENGINE_PNL_POS_TOT_OFF : V12_17_ENGINE_PNL_POS_TOT_OFF,
    engineLiqCursorOff: -1,                    // removed in v12.17
    engineGcCursorOff: isSbf ? V12_17_SBF_ENGINE_GC_CURSOR_OFF : V12_17_ENGINE_GC_CURSOR_OFF,
    engineLastSweepStartOff: -1,
    engineLastSweepCompleteOff: -1,
    engineCrankCursorOff: -1,
    engineSweepStartIdxOff: -1,
    engineLifetimeLiquidationsOff: -1,
    engineLifetimeForceClosesOff: -1,
    engineNetLpPosOff: -1,
    engineLpSumAbsOff: -1,
    engineLpMaxAbsOff: -1,
    engineLpMaxAbsSweepOff: -1,
    engineEmergencyOiModeOff: -1,
    engineEmergencyStartSlotOff: -1,
    engineLastBreakerSlotOff: -1,
    engineBitmapOff: bitmapOff,
    postBitmap,
    acctOwnerOff: isSbf ? 192 : V12_17_ACCT_OWNER_OFF, // SBF=192, native=200

    hasInsuranceIsolation: false,
    engineInsuranceIsolatedOff: -1,
    engineInsuranceIsolationBpsOff: -1,

    // v12.17 dropped the engine.mark_price field (see engineMarkPriceOff above).
    // The EWMA-smoothed mark that the matcher actually quotes against lives in
    // MarketConfig.mark_ewma_e6 at offset 304 within the config struct.
    // Layout is identical on SBF and native. configOffset is V0_HEADER_LEN = 72,
    // so absolute offset in the slab is 72 + 304 = 376.
    configMarkEwmaOff: V0_HEADER_LEN + 304,
  };
}

/**
 * Detect the slab layout version from the raw account data length.
 * Returns the full SlabLayout descriptor, or null if the size is unrecognised.
 * Checks V12_15, V12_1_EP, V12_1, V_SETDEXPOOL, V1M2, V_ADL, V1M, V0, V1D, V1D-legacy, V1, and V1-legacy sizes.
 *
 * When `data` is provided and the size matches V1D, the version field at offset 8 is read
 * to disambiguate V2 slabs (which produce identical sizes to V1D with postBitmap=2).
 * V2 slabs have version===2 at offset 8 (u32 LE).
 *
 * @param dataLen - The slab account data length in bytes
 * @param data    - Optional raw slab data for version-field disambiguation
 */
/**
 * Assert that a built SlabLayout is internally consistent.
 * Throws if accountsOff > dataLen or if any required bitmap region extends past the data.
 * Used by layout builders to catch offset arithmetic bugs early.
 *
 * @param layout - Layout descriptor to validate.
 * @param dataLen - Actual byte length of the slab data buffer.
 * @returns The validated layout (identity function for chaining).
 */
function validateLayout(layout: SlabLayout, dataLen: number): SlabLayout {
  if (layout.accountsOff > dataLen) {
    throw new Error(
      `validateLayout: accountsOff (${layout.accountsOff}) exceeds data length (${dataLen}) ` +
      `for engineOff=${layout.engineOff} accountSize=${layout.accountSize} maxAccounts=${layout.maxAccounts}`
    );
  }
  const bitmapEnd = layout.engineOff + layout.engineBitmapOff + layout.bitmapWords * 8;
  if (bitmapEnd > dataLen) {
    throw new Error(
      `validateLayout: bitmap region end (${bitmapEnd}) exceeds data length (${dataLen})`
    );
  }
  return layout;
}

export function detectSlabLayout(dataLen: number, data?: Uint8Array): SlabLayout | null {
  // Check V12_19 sizes first. Mainnet program ESa89R5... was upgraded to
  // v12.19 (--features small) on 2026-04-28; any slab created post-upgrade
  // is v12.19. Some sizes (94168) collide with V12_17 SBF small; the
  // deployed program only emits v12.19 going forward, so this priority
  // is correct for live mainnet reads.
  const v1219n = V12_19_SIZES.get(dataLen);
  if (v1219n !== undefined) return validateLayout(buildLayoutV12_19(v1219n, dataLen), dataLen);

  // Check V12_17 sizes (two-bucket warmup, per-side funding).
  // Unique account sizes (368 native / 352 SBF) + RISK_BUF — no collision with V12_15 (4400-byte accounts).
  const v1217n = V12_17_SIZES.get(dataLen);
  if (v1217n !== undefined) return validateLayout(buildLayoutV12_17(v1217n, dataLen), dataLen);

  // Check V12_15 sizes (v12.15 engine+prog sync, ACCOUNT_SIZE=4400).
  // Vastly larger account size — no collision with any earlier layout possible.
  const v1215n = V12_15_SIZES.get(dataLen);
  if (v1215n !== undefined) return validateLayout(buildLayoutV12_15(v1215n, dataLen), dataLen);

  // Check V12_1_EP sizes (entry_price re-added, ACCOUNT_SIZE=288 on SBF).
  // Must be checked before V12_1 (280-byte accounts) to avoid misdetection.
  const v121epn = V12_1_EP_SIZES.get(dataLen);
  if (v121epn !== undefined) return validateLayout(buildLayoutV12_1EP(v121epn), dataLen);

  // Check V12_1 sizes (percolator-core v12.1, ACCOUNT_SIZE=320/280, no entry_price).
  const v121n = V12_1_SIZES.get(dataLen);
  if (v121n !== undefined) return validateLayout(buildLayoutV12_1(v121n, dataLen), dataLen);

  // Check V_SETDEXPOOL sizes (PERC-SetDexPool, ENGINE_OFF=648, CONFIG_LEN=544).
  // These are the pre-v12.1 newest slabs — largest ENGINE_OFF so no size collision with V_ADL (624).
  const vsdpn = V_SETDEXPOOL_SIZES.get(dataLen);
  if (vsdpn !== undefined) return validateLayout(buildLayoutVSetDexPool(vsdpn), dataLen);

  // Check V1M2 sizes. After fixing bitmapOff to 1008 for both V1M2 and V_ADL,
  // their sizes no longer collide (engineOff differs: 616 vs 624), so size-based detection
  // works directly — no data-probe disambiguation required.
  //   V1M2 medium (1024 accts): computeSlabSize(616, 1008, 312, 1024, 18) = 323312
  //   V_ADL medium (1024 accts): computeSlabSize(624, 1008, 312, 1024, 18) = 323320
  const v1m2n = V1M2_SIZES.get(dataLen);
  if (v1m2n !== undefined) return validateLayout(buildLayoutV1M2(v1m2n), dataLen);

  // Check V_ADL sizes (PERC-8270/8271, ENGINE_OFF=624, BITMAP_OFF=1008, ACCOUNT_SIZE=312).
  const vadln = V_ADL_SIZES.get(dataLen);
  if (vadln !== undefined) return validateLayout(buildLayoutVADL(vadln), dataLen);

  // Check V1M sizes (mainnet-deployed V1 program, ESa89R5).
  // Must be checked before V1_LEGACY because V1M sizes are unique and don't overlap.
  const v1mn = V1M_SIZES.get(dataLen);
  if (v1mn !== undefined) return validateLayout(buildLayoutV1M(v1mn), dataLen);

  // Check V0 sizes (deployed devnet V0 program)
  const v0n = V0_SIZES.get(dataLen);
  if (v0n !== undefined) return validateLayout(buildLayout(0, v0n), dataLen);

  // Check V1D sizes (actually deployed V1 program — ENGINE_OFF=424, correct struct layout).
  // V2 slabs produce identical sizes (postBitmap=18 for V2 == postBitmap=2 for V1D).
  // When data is available, peek at the version field to disambiguate.
  const v1dn = V1D_SIZES.get(dataLen);
  if (v1dn !== undefined) {
    if (data && data.length >= 12) {
      const version = readU32LE(data, 8);
      if (version === 2) return validateLayout(buildLayoutV2(v1dn), dataLen);
    }
    return validateLayout(buildLayoutV1D(v1dn, 2), dataLen);
  }

  // Check V1D legacy sizes (postBitmap=18 on-chain slabs created before GH#1234 fix).
  // e.g. slab 6ZytbpV4 (TEST/USD, top active market) = 65104 bytes, uses postBitmap=18.
  // PR #1236 broke these by only registering the postBitmap=2 size; GH#1237 restores support.
  const v1dln = V1D_SIZES_LEGACY.get(dataLen);
  if (v1dln !== undefined) return validateLayout(buildLayoutV1D(v1dln, 18), dataLen);

  // Check V1 sizes (future V1 program — ENGINE_OFF=600, PERC-1094 corrected)
  const v1n = V1_SIZES.get(dataLen);
  if (v1n !== undefined) return validateLayout(buildLayout(1, v1n), dataLen);

  // Check legacy V1 sizes (pre-PERC-1094 SDK used ENGINE_OFF=640; orphaned on devnet)
  const v1ln = V1_SIZES_LEGACY.get(dataLen);
  // PERC-1095 follow-up: must pass V1_ENGINE_OFF_LEGACY (640) so the returned SlabLayout
  // has .engineOff=640 — without the override buildLayout would use V1_ENGINE_OFF=600,
  // causing all engine reads on legacy slabs to land at the wrong byte offset.
  if (v1ln !== undefined) return validateLayout(buildLayout(1, v1ln, V1_ENGINE_OFF_LEGACY), dataLen);

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
// V1-only extended params (offset 56+) — legacy offsets (V0/V1/V1D layouts with
// riskReductionThreshold and liquidationBufferBps fields).
const PARAMS_RISK_THRESHOLD_OFF = 56;
const PARAMS_MAINTENANCE_FEE_OFF = 72;
const PARAMS_MAX_CRANK_STALENESS_OFF = 88;
const PARAMS_LIQUIDATION_FEE_BPS_OFF = 96;
const PARAMS_LIQUIDATION_FEE_CAP_OFF = 104;
const PARAMS_LIQUIDATION_BUFFER_OFF = 120;
const PARAMS_MIN_LIQUIDATION_OFF = 128;

// V12_1 SBF params offsets — deployed struct has NO riskReductionThreshold or
// liquidationBufferBps. Instead: maintenance_fee_per_slot follows new_account_fee
// directly, and min_initial_deposit/min_nonzero_mm_req/min_nonzero_im_req/insurance_floor
// are appended at the end. Verified via cargo build-sbf offset_of! assertions.
const V12_1_PARAMS_MAINT_FEE_OFF = 56;       // U128
const V12_1_PARAMS_MAX_CRANK_OFF = 72;        // u64
const V12_1_PARAMS_LIQ_FEE_BPS_OFF = 80;      // u64
const V12_1_PARAMS_LIQ_FEE_CAP_OFF = 88;      // U128
const V12_1_PARAMS_MIN_LIQ_OFF = 104;          // U128
const V12_1_PARAMS_MIN_INITIAL_DEP_OFF = 120;  // U128
const V12_1_PARAMS_MIN_NZ_MM_OFF = 136;        // u128
const V12_1_PARAMS_MIN_NZ_IM_OFF = 152;        // u128
const V12_1_PARAMS_INS_FLOOR_OFF = 168;        // U128

// V12_19 SBF engine RiskParams offsets. The wrapper still accepts a wider
// InitMarket wire payload for policy fields such as new_account_fee and
// insurance_floor, but those fields are not stored inside engine RiskParams.
const V12_19_PARAMS_MAINTENANCE_MARGIN_OFF = 0;
const V12_19_PARAMS_INITIAL_MARGIN_OFF = 8;
const V12_19_PARAMS_TRADING_FEE_OFF = 16;
const V12_19_PARAMS_MAX_ACCOUNTS_OFF = 24;
const V12_19_PARAMS_LIQ_FEE_BPS_OFF = 32;
const V12_19_PARAMS_LIQ_FEE_CAP_OFF = 40;
const V12_19_PARAMS_MIN_LIQ_OFF = 56;
const V12_19_PARAMS_MIN_NZ_MM_OFF = 72;
const V12_19_PARAMS_MIN_NZ_IM_OFF = 88;
const V12_19_PARAMS_H_MIN_OFF = 104;
const V12_19_PARAMS_H_MAX_OFF = 112;
const V12_19_PARAMS_RESOLVE_PRICE_DEVIATION_OFF = 120;
const V12_19_PARAMS_MAX_ACCRUAL_DT_OFF = 128;

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
  /**
   * @stub Always 0n — not yet read from the on-chain MarketConfig struct.
   * Do not use for market-resolution logic until a parser is wired.
   */
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
  /**
   * @deprecated Split into hMin/hMax in v12.15 RiskParams. On V12_15 slabs this field returns
   * hMin for backwards compatibility. On pre-v12.15 slabs hMin/hMax both mirror this value.
   */
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
  /** Minimum initial deposit to open an account (V12_1+ only) */
  minInitialDeposit: bigint;
  /** Minimum nonzero maintenance margin requirement (V12_1+ only) */
  minNonzeroMmReq: bigint;
  /** Minimum nonzero initial margin requirement (V12_1+ only) */
  minNonzeroImReq: bigint;
  /** Insurance fund floor (V12_1+ only) */
  insuranceFloor: bigint;
  /** Minimum horizon slots (v12.15+). Replaces warmupPeriodSlots. 0n on pre-v12.15 slabs. */
  hMin: bigint;
  /** Maximum horizon slots (v12.15+). 0n on pre-v12.15 slabs. */
  hMax: bigint;
}

export interface EngineState {
  vault: bigint;
  insuranceFund: InsuranceFund;
  currentSlot: bigint;
  fundingIndexQpbE6: bigint;
  lastFundingSlot: bigint;
  /**
   * Funding rate per slot. On pre-v12.15 slabs: i64 in BPS units.
   * On v12.15+ slabs: i128 in e9 units (field renamed `funding_rate_e9` on-chain).
   */
  fundingRateBpsPerSlotLast: bigint;
  /**
   * Funding rate in e9 units (i128). v12.15+ only.
   * 0n on pre-v12.15 slabs.
   */
  fundingRateE9: bigint;
  /**
   * Market mode. v12.15+ only. 0 = Live, 1 = Resolved. null on pre-v12.15 slabs.
   */
  marketMode: 0 | 1 | null;
  lastCrankSlot: bigint;
  maxCrankStalenessSlots: bigint;
  totalOpenInterest: bigint;
  longOi: bigint;
  shortOi: bigint;
  cTot: bigint;
  pnlPosTot: bigint;
  /**
   * Matured (settled) positive PnL total (u128). v12.15+ only. 0n on pre-v12.15 slabs.
   */
  pnlMaturedPosTot: bigint;
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
  /** last_oracle_price (u64, e6). V12_15+ only. 0n on pre-v12.15. */
  oraclePriceE6: bigint;

  // ---- V12_17 engine fields ----
  /** Cumulative funding numerator for long side (i128). 0n on pre-v12.17. */
  fLongNum: bigint;
  /** Cumulative funding numerator for short side (i128). 0n on pre-v12.17. */
  fShortNum: bigint;
  /** Count of accounts with negative PnL. 0n on pre-v12.17. */
  negPnlAccountCount: bigint;
  /** Last funding-sample price (u64 e6). 0n on pre-v12.17. */
  fundPxLast: bigint;
  /** Matured positive PnL total (u128). v12.15+ only. 0n on pre-v12.15 slabs. */
  resolvedKLongTerminalDelta: bigint;
  /** Terminal K delta for short side (i128). 0n on pre-v12.17. */
  resolvedKShortTerminalDelta: bigint;
  /** Live oracle price used during resolution (u64 e6). 0n on pre-v12.17. */
  resolvedLivePrice: bigint;
}

export enum AccountKind {
  User = 0,
  LP = 1,
}

/** Parsed reserve cohort (64 bytes on-chain). Raw bytes; structure is program-internal. */
export type ReserveCohortBytes = Uint8Array;

export interface Account {
  kind: AccountKind;
  accountId: bigint;
  capital: bigint;
  pnl: bigint;
  reservedPnl: bigint;
  /** @deprecated Removed in v12.15. Always 0n on V12_15 slabs. */
  warmupStartedAtSlot: bigint;
  /** @deprecated Removed in v12.15. Always 0n on V12_15 slabs. */
  warmupSlopePerStep: bigint;
  positionSize: bigint;
  /** Entry price in e6 units. Present in V12_15 (offset 120) and V_ADL/V12_1_EP. -1 signals absent. */
  entryPrice: bigint;
  fundingIndex: bigint;
  matcherProgram: PublicKey;
  matcherContext: PublicKey;
  owner: PublicKey;
  feeCredits: bigint;
  /** @deprecated Removed in v12.15. Always 0n on V12_15 slabs. */
  lastFeeSlot: bigint;
  /** Total fees earned over account lifetime (u128). Present from v12.15. 0n on older layouts. */
  feesEarnedTotal: bigint;
  /**
   * Reserve cohorts array (v12.15+). Up to 62 cohorts of 64 bytes each.
   * `null` on pre-v12.15 slabs. Parse the raw bytes according to the on-chain ReserveCohort struct.
   */
  exactReserveCohorts: ReserveCohortBytes[] | null;
  /** Number of active reserve cohorts (0-62). null on pre-v12.15 slabs. */
  exactCohortCount: number | null;
  /** Overflow (oldest) cohort raw bytes. null on pre-v12.15 slabs or when not present. */
  overflowOlder: ReserveCohortBytes | null;
  /** True if overflowOlder contains valid data. null on pre-v12.15 slabs. */
  overflowOlderPresent: boolean | null;
  /** Overflow (newest) cohort raw bytes. null on pre-v12.15 slabs or when not present. */
  overflowNewest: ReserveCohortBytes | null;
  /** True if overflowNewest contains valid data. null on pre-v12.15 slabs. */
  overflowNewestPresent: boolean | null;

  // ---- V12_17 fields (two-bucket warmup, per-side funding) ----
  /** Per-account cumulative funding snapshot (i128). 0n on pre-v12.17 slabs. */
  fSnap: bigint;
  /** ADL A-basis snapshot (u128). 0n on pre-v12.17 slabs. */
  adlABasis: bigint;
  /** ADL K-coefficient snapshot (i128). 0n on pre-v12.17 slabs. */
  adlKSnap: bigint;
  /** ADL epoch snapshot (u64). 0n on pre-v12.17 slabs. */
  adlEpochSnap: bigint;

  // Scheduled reserve bucket (older, matures linearly)
  /** True if the scheduled warmup bucket is active. null on pre-v12.17. */
  schedPresent: boolean | null;
  /** Remaining unreleased quantity in scheduled bucket. null on pre-v12.17. */
  schedRemainingQ: bigint | null;
  /** Anchor quantity for scheduled bucket. null on pre-v12.17. */
  schedAnchorQ: bigint | null;
  /** Start slot for scheduled bucket. null on pre-v12.17. */
  schedStartSlot: bigint | null;
  /** Warmup horizon for scheduled bucket. null on pre-v12.17. */
  schedHorizon: bigint | null;
  /** Release quantity for scheduled bucket. null on pre-v12.17. */
  schedReleaseQ: bigint | null;

  // Pending reserve bucket (newest, does not mature while pending)
  /** True if the pending warmup bucket is active. null on pre-v12.17. */
  pendingPresent: boolean | null;
  /** Remaining unreleased quantity in pending bucket. null on pre-v12.17. */
  pendingRemainingQ: bigint | null;
  /** Warmup horizon for pending bucket. null on pre-v12.17. */
  pendingHorizon: bigint | null;
  /** Creation slot for pending bucket. null on pre-v12.17. */
  pendingCreatedSlot: bigint | null;
}

// =============================================================================
// Fetch
// =============================================================================

export async function fetchSlab(
  connection: Connection,
  slabPubkey: PublicKey,
  expectedOwner?: PublicKey
): Promise<Uint8Array> {
  const info = await connection.getAccountInfo(slabPubkey);
  if (!info) {
    throw new Error(`Slab account not found: ${slabPubkey.toBase58()}`);
  }
  if (expectedOwner && !info.owner.equals(expectedOwner)) {
    throw new Error(
      `fetchSlab: account ${slabPubkey.toBase58()} is owned by ${info.owner.toBase58()} but expected ${expectedOwner.toBase58()}`
    );
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
/**
 * V12_17 MarketConfig parser. Struct definition: percolator-prog/src/percolator.rs:2194.
 * SBF layout (u128 align=8, total size 512 bytes):
 *   0   collateral_mint [32]
 *   32  vault_pubkey [32]
 *   64  index_feed_id [32]
 *   96  max_staleness_secs u64
 *   104 conf_filter_bps u16
 *   106 vault_authority_bump u8
 *   107 invert u8
 *   108 unit_scale u32
 *   112 funding_horizon_slots u64
 *   120 funding_k_bps u64
 *   128 funding_max_premium_bps i64
 *   136 funding_max_bps_per_slot i64
 *   144 oracle_authority [32]
 *   176 authority_price_e6 u64
 *   184 authority_timestamp i64
 *   192 oracle_price_cap_e2bps u64
 *   200 last_effective_price_e6 u64
 *   208 max_insurance_floor u128
 *   224 min_oracle_price_cap_e2bps u64
 *   232 insurance_withdraw_max_bps u16 (+ 6 pad)
 *   240 insurance_withdraw_cooldown_slots u64
 *   248 _iw_padding2 [u64;2]
 *   264 last_hyperp_index_slot u64
 *   272 last_mark_push_slot u128
 *   288 last_insurance_withdraw_slot u64 (+ 8 pad)
 *   304 mark_ewma_e6 u64
 *   312 mark_ewma_last_slot u64
 *   320 mark_ewma_halflife_slots u64 (+ 8 pad)
 *   336 permissionless_resolve_stale_slots u64
 *   344 last_good_oracle_slot u64
 *   352 maintenance_fee_per_slot u128
 *   368 last_fee_charge_slot u64 (+ 8 pad)
 *   384 mark_min_fee u64
 *   392 force_close_delay_slots u64
 *   400 dex_pool [32]
 *   432 max_pnl_cap u64
 *   440 last_audit_pause_slot u64
 *   448 oi_cap_multiplier_bps u64
 *   456 dispute_window_slots u64
 *   464 dispute_bond_amount u64
 *   472 lp_collateral_enabled u8
 *   473 _pad u8
 *   474 lp_collateral_ltv_bps u16 (+ 4 pad)
 *   480 pending_admin [32]
 *   512 end
 */
function parseConfigV12_17(data: Uint8Array, configOff: number): MarketConfig {
  const MIN_V12_17_BYTES = 512;
  if (data.length < configOff + MIN_V12_17_BYTES) {
    throw new Error(`Slab data too short for V12_17 config: ${data.length} < ${configOff + MIN_V12_17_BYTES}`);
  }

  const b = configOff;
  const collateralMint = new PublicKey(data.subarray(b + 0, b + 32));
  const vaultPubkey = new PublicKey(data.subarray(b + 32, b + 64));
  const indexFeedId = new PublicKey(data.subarray(b + 64, b + 96));
  const maxStalenessSlots = readU64LE(data, b + 96);
  const confFilterBps = readU16LE(data, b + 104);
  const vaultAuthorityBump = readU8(data, b + 106);
  const invert = readU8(data, b + 107);
  const unitScale = readU32LE(data, b + 108);
  const fundingHorizonSlots = readU64LE(data, b + 112);
  const fundingKBps = readU64LE(data, b + 120);
  const fundingMaxPremiumBps = readI64LE(data, b + 128);
  const fundingMaxBpsPerSlot = readI64LE(data, b + 136);
  const oracleAuthority = new PublicKey(data.subarray(b + 144, b + 176));
  const authorityPriceE6 = readU64LE(data, b + 176);
  const authorityTimestamp = readI64LE(data, b + 184);
  const oraclePriceCapE2bps = readU64LE(data, b + 192);
  const lastEffectivePriceE6 = readU64LE(data, b + 200);
  // max_insurance_floor, min_oracle_price_cap, mark_ewma, dispute, etc. — not
  // currently surfaced by the MarketConfig type; read them when/if callers
  // need them. Only dex_pool is consumed downstream.

  const dexPoolBytes = data.subarray(b + 400, b + 432);
  const dexPool = dexPoolBytes.some(x => x !== 0) ? new PublicKey(dexPoolBytes) : null;

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
    fundingInvScaleNotionalE6: 0n,        // removed in v12.17
    fundingMaxPremiumBps,
    fundingMaxBpsPerSlot,
    threshFloor: 0n,                      // removed in v12.17
    threshRiskBps: 0n,
    threshUpdateIntervalSlots: 0n,
    threshStepBps: 0n,
    threshAlphaBps: 0n,
    threshMin: 0n,
    threshMax: 0n,
    threshMinStep: 0n,
    oracleAuthority,
    authorityPriceE6,
    authorityTimestamp,
    oraclePriceCapE2bps,
    lastEffectivePriceE6,
    oiCapMultiplierBps: readU64LE(data, b + 448),
    maxPnlCap: readU64LE(data, b + 432),
    adaptiveFundingEnabled: false,        // removed in v12.17
    adaptiveScaleBps: 0,
    adaptiveMaxFundingBps: 0n,
    marketCreatedSlot: 0n,
    oiRampSlots: 0n,
    resolvedSlot: 0n,
    insuranceIsolationBps: 0,
    oraclePhase: 0,
    cumulativeVolumeE6: 0n,
    phase2DeltaSlots: 0,
    dexPool,
  };
}

/**
 * V12_19 MarketConfig parser. SBF layout (480 bytes total, u128 align=8).
 * Probe-confirmed against /path/to/percolator-prog (cargo build-sbf
 * --features small) on 2026-04-28.
 *
 *   0   collateral_mint [32]
 *   32  vault_pubkey [32]
 *   64  index_feed_id [32]
 *   96  max_staleness_secs u64
 *   104 conf_filter_bps u16
 *   106 vault_authority_bump u8
 *   107 invert u8
 *   108 unit_scale u32
 *   112 funding_horizon_slots u64
 *   120 funding_k_bps u64
 *   128 funding_max_premium_bps i64
 *   136 funding_max_e9_per_slot i64
 *   144 hyperp_authority [32]                  ← was oracle_authority in v12.17, renamed
 *   176 hyperp_mark_e6 u64                     ← v12.19 only
 *   184 last_oracle_publish_time i64
 *   192 last_effective_price_e6 u64            ← shifted from v12.17 (was at 200)
 *   200 insurance_withdraw_max_bps u16
 *   202 tvl_insurance_cap_mult u16             ← v12.19 only
 *   204 _iw_padding [u8;4]
 *   208 insurance_withdraw_cooldown_slots u64
 *   216 oracle_price_cap_e2bps u64             ← shifted from v12.17 (was at 192)
 *   224 min_oracle_price_cap_e2bps u64
 *   232 last_hyperp_index_slot u64
 *   240 last_mark_push_slot u128
 *   256 last_insurance_withdraw_slot u64
 *   264 _pad u64
 *   272 mark_ewma_e6 u64
 *   280 mark_ewma_last_slot u64
 *   288 mark_ewma_halflife_slots u64
 *   296 init_restart_slot u64
 *   304 permissionless_resolve_stale_slots u64
 *   312 last_good_oracle_slot u64
 *   320 maintenance_fee_per_slot u128
 *   336 fee_sweep_cursor_word u64
 *   344 fee_sweep_cursor_bit u64
 *   352 mark_min_fee u64
 *   360 force_close_delay_slots u64
 *   368 dex_pool [32]                          ← shifted from v12.17 (was at 400)
 *   400 max_pnl_cap u64                        ← shifted from v12.17 (was at 432)
 *   408 last_audit_pause_slot u64
 *   416 oi_cap_multiplier_bps u64
 *   424 dispute_window_slots u64
 *   432 dispute_bond_amount u64
 *   440 lp_collateral_enabled u8
 *   441 _pad u8
 *   442 lp_collateral_ltv_bps u16
 *   444 _pad [u8;4]
 *   448 pending_admin [32]
 *   480 end
 */
function parseConfigV12_19(data: Uint8Array, configOff: number): MarketConfig {
  const MIN_V12_19_BYTES = 480;
  if (data.length < configOff + MIN_V12_19_BYTES) {
    throw new Error(`Slab data too short for V12_19 config: ${data.length} < ${configOff + MIN_V12_19_BYTES}`);
  }

  const b = configOff;
  const collateralMint = new PublicKey(data.subarray(b + 0, b + 32));
  const vaultPubkey = new PublicKey(data.subarray(b + 32, b + 64));
  const indexFeedId = new PublicKey(data.subarray(b + 64, b + 96));
  const maxStalenessSlots = readU64LE(data, b + 96);
  const confFilterBps = readU16LE(data, b + 104);
  const vaultAuthorityBump = readU8(data, b + 106);
  const invert = readU8(data, b + 107);
  const unitScale = readU32LE(data, b + 108);
  const fundingHorizonSlots = readU64LE(data, b + 112);
  const fundingKBps = readU64LE(data, b + 120);
  const fundingMaxPremiumBps = readI64LE(data, b + 128);
  const fundingMaxBpsPerSlot = readI64LE(data, b + 136);
  const oracleAuthority = new PublicKey(data.subarray(b + 144, b + 176));
  const authorityPriceE6 = readU64LE(data, b + 176);
  const authorityTimestamp = readI64LE(data, b + 184);
  const lastEffectivePriceE6 = readU64LE(data, b + 192);
  const oraclePriceCapE2bps = readU64LE(data, b + 216);

  const dexPoolBytes = data.subarray(b + 368, b + 400);
  const dexPool = dexPoolBytes.some(x => x !== 0) ? new PublicKey(dexPoolBytes) : null;

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
    fundingInvScaleNotionalE6: 0n,
    fundingMaxPremiumBps,
    fundingMaxBpsPerSlot,
    threshFloor: 0n,
    threshRiskBps: 0n,
    threshUpdateIntervalSlots: 0n,
    threshStepBps: 0n,
    threshAlphaBps: 0n,
    threshMin: 0n,
    threshMax: 0n,
    threshMinStep: 0n,
    oracleAuthority,
    authorityPriceE6,
    authorityTimestamp,
    oraclePriceCapE2bps,
    lastEffectivePriceE6,
    oiCapMultiplierBps: readU64LE(data, b + 416),
    maxPnlCap: readU64LE(data, b + 400),
    adaptiveFundingEnabled: false,
    adaptiveScaleBps: 0,
    adaptiveMaxFundingBps: 0n,
    marketCreatedSlot: 0n,
    oiRampSlots: 0n,
    resolvedSlot: 0n,
    insuranceIsolationBps: 0,
    oraclePhase: 0,
    cumulativeVolumeE6: 0n,
    phase2DeltaSlots: 0,
    dexPool,
  };
}

export function parseConfig(data: Uint8Array, layoutHint?: SlabLayout | null): MarketConfig {
  if (data.length >= 8 && readU64LE(data, 0) !== MAGIC) {
    throw new Error('parseConfig: invalid slab magic');
  }
  const layout = layoutHint !== undefined ? layoutHint : detectSlabLayout(data.length, data);
  const configOff = layout ? layout.configOffset : V0_HEADER_LEN;
  const configLen = layout ? layout.configLen : V0_CONFIG_LEN;

  // V12_19 MarketConfig (480 bytes, hyperp/dex_pool reordered vs v12.17).
  // Detect by accountSize=360 (probe-confirmed v12.19 SBF Account size).
  const isV12_19 = layout && layout.accountSize === V12_19_ACCOUNT_SIZE_SBF;
  if (isV12_19) {
    return parseConfigV12_19(data, configOff);
  }

  // V12_17 MarketConfig has a completely different layout — no funding_inv_scale,
  // no thresh_* fields. Parse it via its own field-ordered reader. The legacy
  // sequential code below covers pre-v12.17 layouts.
  const isV12_17 = layout && (layout.accountSize === V12_17_ACCOUNT_SIZE || layout.accountSize === V12_17_ACCOUNT_SIZE_SBF);
  if (isV12_17) {
    return parseConfigV12_17(data, configOff);
  }

  // Mandatory config fields (collateralMint..maxPnlCap) consume 376 bytes.
  // V1 extended fields are optional and guarded by their own `remaining` checks.
  const MIN_CONFIG_BYTES = 376;
  const minLen = configOff + Math.min(configLen, MIN_CONFIG_BYTES);
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

  // Validate we have enough data for the fields we'll actually read.
  // V0 basic params need 56 bytes; V1 extended params need 144 bytes.
  const MIN_PARAMS_BYTES = paramsSize >= 144 ? 144 : 56;
  if (data.length < base + MIN_PARAMS_BYTES) {
    throw new Error(`Slab data too short for RiskParams: ${data.length} < ${base + MIN_PARAMS_BYTES}`);
  }

  // Detect V12_15 layout: paramsSize=192. In v12.15, warmup_period_slots is replaced by
  // h_min(u64@160) + h_max(u64@168). max_accounts moved to offset 24 (from 32).
  const isV12_15Params = paramsSize === V12_15_PARAMS_SIZE || paramsSize === 184; // 192=native, 184=SBF
  const isV12_19Params = layout !== null && layout !== undefined &&
    layout.engineOff === V12_19_ENGINE_OFF_SBF &&
    paramsSize === V12_19_SBF_ENGINE_PARAMS_SIZE;

  // Detect V12_1 SBF layout — deployed struct has different field order from legacy layouts.
  // V12_1 SBF: no riskReductionThreshold/liquidationBufferBps; adds minInitialDeposit/
  // minNonzeroMmReq/minNonzeroImReq/insuranceFloor at the end.
  const isV12_1Sbf = !isV12_15Params && layout !== null && layout !== undefined &&
    (layout.engineOff === V12_1_SBF_ENGINE_OFF) && paramsSize === 184;

  // Basic params present in all layouts (offsets 0-55 are identical)
  const result: RiskParams = {
    warmupPeriodSlots: isV12_19Params
      ? readU64LE(data, base + V12_19_PARAMS_H_MIN_OFF) // backwards compat: return hMin
      : isV12_15Params
      ? readU64LE(data, base + V12_15_PARAMS_H_MIN_OFF)   // backwards compat: return hMin
      : readU64LE(data, base + PARAMS_WARMUP_PERIOD_OFF),
    maintenanceMarginBps: isV12_19Params
      ? readU64LE(data, base + V12_19_PARAMS_MAINTENANCE_MARGIN_OFF)
      : isV12_15Params
      ? readU64LE(data, base + 0)   // v12.15: mm_bps is first field (offset 0)
      : readU64LE(data, base + PARAMS_MAINTENANCE_MARGIN_OFF),
    initialMarginBps: isV12_19Params
      ? readU64LE(data, base + V12_19_PARAMS_INITIAL_MARGIN_OFF)
      : isV12_15Params
      ? readU64LE(data, base + 8)
      : readU64LE(data, base + PARAMS_INITIAL_MARGIN_OFF),
    tradingFeeBps: isV12_19Params
      ? readU64LE(data, base + V12_19_PARAMS_TRADING_FEE_OFF)
      : isV12_15Params
      ? readU64LE(data, base + 16)
      : readU64LE(data, base + PARAMS_TRADING_FEE_OFF),
    maxAccounts: isV12_19Params
      ? readU64LE(data, base + V12_19_PARAMS_MAX_ACCOUNTS_OFF)
      : isV12_15Params
      ? readU64LE(data, base + V12_15_PARAMS_MAX_ACCOUNTS_OFF)  // offset 24 in v12.15
      : readU64LE(data, base + PARAMS_MAX_ACCOUNTS_OFF),
    newAccountFee: isV12_19Params
      ? 1n // v12.19 wrapper hardcodes a one-base-unit anti-spam fee at InitUser/InitLP.
      : isV12_15Params
      ? readU128LE(data, base + 32)  // offset 32 in v12.15
      : readU128LE(data, base + PARAMS_NEW_ACCOUNT_FEE_OFF),
    // Extended params: defaults; overwritten below if layout supports them
    riskReductionThreshold: 0n,
    maintenanceFeePerSlot: 0n,
    maxCrankStalenessSlots: 0n,
    liquidationFeeBps: 0n,
    liquidationFeeCap: 0n,
    liquidationBufferBps: 0n,
    minLiquidationAbs: 0n,
    minInitialDeposit: 0n,
    minNonzeroMmReq: 0n,
    minNonzeroImReq: 0n,
    insuranceFloor: 0n,
    hMin: 0n,
    hMax: 0n,
  };

  if (isV12_19Params) {
    // V12_19 engine RiskParams no longer stores wrapper policy fields such as
    // new_account_fee, min_initial_deposit, insurance_floor, or maintenance fee.
    result.hMin = readU64LE(data, base + V12_19_PARAMS_H_MIN_OFF);
    result.hMax = readU64LE(data, base + V12_19_PARAMS_H_MAX_OFF);
    result.riskReductionThreshold = 0n;
    result.maintenanceFeePerSlot = 0n;
    result.maxCrankStalenessSlots = readU64LE(data, base + V12_19_PARAMS_MAX_ACCRUAL_DT_OFF);
    result.liquidationFeeBps = readU64LE(data, base + V12_19_PARAMS_LIQ_FEE_BPS_OFF);
    result.liquidationFeeCap = readU128LE(data, base + V12_19_PARAMS_LIQ_FEE_CAP_OFF);
    result.liquidationBufferBps = readU64LE(data, base + V12_19_PARAMS_RESOLVE_PRICE_DEVIATION_OFF);
    result.minLiquidationAbs = readU128LE(data, base + V12_19_PARAMS_MIN_LIQ_OFF);
    result.minInitialDeposit = 0n;
    result.minNonzeroMmReq = readU128LE(data, base + V12_19_PARAMS_MIN_NZ_MM_OFF);
    result.minNonzeroImReq = readU128LE(data, base + V12_19_PARAMS_MIN_NZ_IM_OFF);
    result.insuranceFloor = 0n;
  } else if (isV12_15Params) {
    // V12_15 RiskParams: read hMin/hMax, insurance_floor occupies offset 144.
    result.hMin = readU64LE(data, base + V12_15_PARAMS_H_MIN_OFF);
    result.hMax = readU64LE(data, base + V12_15_PARAMS_H_MAX_OFF);
    result.insuranceFloor = readU128LE(data, base + V12_15_PARAMS_INSURANCE_FLOOR_OFF);
    // v12.15 RiskParams: no riskReductionThreshold, no maintenanceFeePerSlot.
    // All offsets shift -8 from legacy (warmupPeriodSlots removed from start).
    result.riskReductionThreshold = 0n; // removed in v12.15
    result.maintenanceFeePerSlot  = 0n; // removed in v12.15
    // v12.15 RiskParams offsets (same on native and SBF — no i128 fields in RiskParams)
    result.maxCrankStalenessSlots = readU64LE(data, base + 48);
    result.liquidationFeeBps      = readU64LE(data, base + 56);
    result.liquidationFeeCap      = readU128LE(data, base + 64);
    result.liquidationBufferBps   = 0n; // removed (wire slot reused as resolve_price_deviation_bps)
    result.minLiquidationAbs      = readU128LE(data, base + 80);
    result.minInitialDeposit      = readU128LE(data, base + 96);
    result.minNonzeroMmReq        = readU128LE(data, base + 112);
    result.minNonzeroImReq        = readU128LE(data, base + 128);
  } else if (isV12_1Sbf) {
    // V12_1 SBF deployed struct — no riskReductionThreshold/liquidationBufferBps
    result.maintenanceFeePerSlot = readU128LE(data, base + V12_1_PARAMS_MAINT_FEE_OFF);
    result.maxCrankStalenessSlots = readU64LE(data, base + V12_1_PARAMS_MAX_CRANK_OFF);
    result.liquidationFeeBps = readU64LE(data, base + V12_1_PARAMS_LIQ_FEE_BPS_OFF);
    result.liquidationFeeCap = readU128LE(data, base + V12_1_PARAMS_LIQ_FEE_CAP_OFF);
    result.minLiquidationAbs = readU128LE(data, base + V12_1_PARAMS_MIN_LIQ_OFF);
    result.minInitialDeposit = readU128LE(data, base + V12_1_PARAMS_MIN_INITIAL_DEP_OFF);
    result.minNonzeroMmReq = readU128LE(data, base + V12_1_PARAMS_MIN_NZ_MM_OFF);
    result.minNonzeroImReq = readU128LE(data, base + V12_1_PARAMS_MIN_NZ_IM_OFF);
    result.insuranceFloor = readU128LE(data, base + V12_1_PARAMS_INS_FLOOR_OFF);
    // hMin/hMax: backfill from warmupPeriodSlots for pre-v12.15 callers
    result.hMin = result.warmupPeriodSlots;
    result.hMax = result.warmupPeriodSlots;
  } else if (paramsSize >= 144) {
    // Legacy V0/V1/V1D layouts with riskReductionThreshold + liquidationBufferBps
    result.riskReductionThreshold = readU128LE(data, base + PARAMS_RISK_THRESHOLD_OFF);
    result.maintenanceFeePerSlot = readU128LE(data, base + PARAMS_MAINTENANCE_FEE_OFF);
    result.maxCrankStalenessSlots = readU64LE(data, base + PARAMS_MAX_CRANK_STALENESS_OFF);
    result.liquidationFeeBps = readU64LE(data, base + PARAMS_LIQUIDATION_FEE_BPS_OFF);
    result.liquidationFeeCap = readU128LE(data, base + PARAMS_LIQUIDATION_FEE_CAP_OFF);
    result.liquidationBufferBps = readU64LE(data, base + PARAMS_LIQUIDATION_BUFFER_OFF);
    result.minLiquidationAbs = readU128LE(data, base + PARAMS_MIN_LIQUIDATION_OFF);
    // hMin/hMax: backfill from warmupPeriodSlots for pre-v12.15 callers
    result.hMin = result.warmupPeriodSlots;
    result.hMax = result.warmupPeriodSlots;
  }

  return result;
}

/**
 * Parse RiskEngine state (excluding accounts array). Layout-version aware.
 */
export function parseEngine(data: Uint8Array): EngineState {
  if (data.length >= 8 && readU64LE(data, 0) !== MAGIC) {
    throw new Error('parseEngine: invalid slab magic');
  }
  const layout = detectSlabLayout(data.length, data);
  if (!layout) {
    throw new Error(`Unrecognized slab data length: ${data.length}. Cannot determine layout version.`);
  }
  if (data.length < layout.accountsOff) {
    throw new Error(`parseEngine: data too short for accountsOff (${data.length} < ${layout.accountsOff})`);
  }

  const base = layout.engineOff;

  // Detect layout versions
  const isV12_17 = layout.accountSize === V12_17_ACCOUNT_SIZE || layout.accountSize === V12_17_ACCOUNT_SIZE_SBF;
  const isV12_15 = !isV12_17 && (layout.accountSize === V12_15_ACCOUNT_SIZE || layout.accountSize === V12_15_ACCOUNT_SIZE_SMALL) && (layout.engineOff === V12_15_ENGINE_OFF || layout.engineOff === V12_15_ENGINE_OFF_SBF);

  // V12_17: completely new engine layout — per-side funding, no stored funding_rate_e9.
  // V12_19 SBF: probe-confirmed engineOff=616, ACCOUNT_SIZE=360, internal offsets
  // shifted from V12_17 SBF. Detect via accountSize=360 (V12_19) vs 352 (V12_17 SBF).
  const isV12_19 = layout.accountSize === V12_19_ACCOUNT_SIZE_SBF;
  if (isV12_17 || isV12_19) {
    const isSbf = layout.engineOff === V12_17_ENGINE_OFF_SBF || isV12_19;

    const currentSlotOff = isV12_19 ? V12_19_SBF_ENGINE_CURRENT_SLOT_OFF
                          : isSbf ? V12_17_SBF_ENGINE_CURRENT_SLOT_OFF : V12_17_ENGINE_CURRENT_SLOT_OFF;
    const marketModeOff = isV12_19 ? V12_19_SBF_ENGINE_MARKET_MODE_OFF
                          : isSbf ? V12_17_SBF_ENGINE_MARKET_MODE_OFF : V12_17_ENGINE_MARKET_MODE_OFF;
    const cTotOff = isV12_19 ? V12_19_SBF_ENGINE_C_TOT_OFF
                    : isSbf ? V12_17_SBF_ENGINE_C_TOT_OFF : V12_17_ENGINE_C_TOT_OFF;
    const pnlPosTotOff = isV12_19 ? V12_19_SBF_ENGINE_PNL_POS_TOT_OFF
                          : isSbf ? V12_17_SBF_ENGINE_PNL_POS_TOT_OFF : V12_17_ENGINE_PNL_POS_TOT_OFF;
    const pnlMaturedOff = isV12_19 ? V12_19_SBF_ENGINE_PNL_MATURED_POS_TOT_OFF
                          : isSbf ? V12_17_SBF_ENGINE_PNL_MATURED_POS_TOT_OFF : V12_17_ENGINE_PNL_MATURED_POS_TOT_OFF;
    const negPnlOff = isV12_19 ? V12_19_SBF_ENGINE_NEG_PNL_COUNT_OFF
                          : isSbf ? V12_17_SBF_ENGINE_NEG_PNL_COUNT_OFF : V12_17_ENGINE_NEG_PNL_COUNT_OFF;
    const oraclePriceOff = isV12_19 ? V12_19_SBF_ENGINE_LAST_ORACLE_PRICE_OFF
                          : isSbf ? V12_17_SBF_ENGINE_LAST_ORACLE_PRICE_OFF : V12_17_ENGINE_LAST_ORACLE_PRICE_OFF;
    const fundPxLastOff = isV12_19 ? V12_19_SBF_ENGINE_FUND_PX_LAST_OFF
                          : isSbf ? V12_17_SBF_ENGINE_FUND_PX_LAST_OFF : V12_17_ENGINE_FUND_PX_LAST_OFF;
    const fLongNumOff = isV12_19 ? V12_19_SBF_ENGINE_F_LONG_NUM_OFF
                          : isSbf ? V12_17_SBF_ENGINE_F_LONG_NUM_OFF : V12_17_ENGINE_F_LONG_NUM_OFF;
    const fShortNumOff = isV12_19 ? V12_19_SBF_ENGINE_F_SHORT_NUM_OFF
                          : isSbf ? V12_17_SBF_ENGINE_F_SHORT_NUM_OFF : V12_17_ENGINE_F_SHORT_NUM_OFF;
    // resolved_k offsets: native 304/320, SBF 288/304
    // V12_19 renamed resolved_k_long/short to *_terminal_delta but kept same offsets.
    const resolvedKLongOff = isV12_19 ? 288
                              : isSbf ? 288 : V12_17_ENGINE_RESOLVED_K_LONG_OFF;
    const resolvedKShortOff = isV12_19 ? 304
                              : isSbf ? 304 : V12_17_ENGINE_RESOLVED_K_SHORT_OFF;
    const resolvedLivePriceOff = isV12_19 ? V12_19_SBF_ENGINE_RESOLVED_LIVE_PRICE_OFF
                              : isSbf ? 320 : V12_17_ENGINE_RESOLVED_LIVE_PRICE_OFF;
    // V12_19 doesn't have last_crank_slot or gc_cursor; use last_market_slot and rr_cursor.
    const lastCrankSlotOff = isV12_19 ? V12_19_SBF_ENGINE_LAST_MARKET_SLOT_OFF
                              : isSbf ? V12_17_SBF_ENGINE_LAST_CRANK_SLOT_OFF : V12_17_ENGINE_LAST_CRANK_SLOT_OFF;
    const gcCursorOff = isV12_19 ? V12_19_SBF_ENGINE_RR_CURSOR_OFF
                              : isSbf ? V12_17_SBF_ENGINE_GC_CURSOR_OFF : V12_17_ENGINE_GC_CURSOR_OFF;
    const oiEffLongOff = isV12_19 ? V12_19_SBF_ENGINE_OI_EFF_LONG_OFF
                              : isSbf ? V12_17_SBF_ENGINE_OI_EFF_LONG_OFF : V12_17_ENGINE_OI_EFF_LONG_OFF;
    const oiEffShortOff = isV12_19 ? V12_19_SBF_ENGINE_OI_EFF_SHORT_OFF
                              : isSbf ? V12_17_SBF_ENGINE_OI_EFF_SHORT_OFF : V12_17_ENGINE_OI_EFF_SHORT_OFF;

    const longOi = readU128LE(data, base + oiEffLongOff);
    const shortOi = readU128LE(data, base + oiEffShortOff);

    // numUsedAccounts: at bitmap + bitmapBytes (postBitmap=4: num_used_accounts is first u16)
    const bitmapEnd = layout.engineBitmapOff + layout.bitmapWords * 8;

    return {
      vault: readU128LE(data, base),
      insuranceFund: {
        balance: readU128LE(data, base + 16),
        feeRevenue: 0n,
        isolatedBalance: 0n,
        isolationBps: 0,
      },
      currentSlot: readU64LE(data, base + currentSlotOff),
      fundingIndexQpbE6: 0n,          // replaced by per-side funding
      lastFundingSlot: 0n,
      fundingRateBpsPerSlotLast: 0n,   // no stored funding rate in v12.17
      fundingRateE9: 0n,               // no stored funding rate in v12.17
      marketMode: readU8(data, base + marketModeOff) === 1 ? 1 : 0,
      lastCrankSlot: readU64LE(data, base + lastCrankSlotOff),
      maxCrankStalenessSlots: 0n,
      totalOpenInterest: longOi + shortOi,
      longOi,
      shortOi,
      cTot: readU128LE(data, base + cTotOff),
      pnlPosTot: readU128LE(data, base + pnlPosTotOff),
      pnlMaturedPosTot: readU128LE(data, base + pnlMaturedOff),
      liqCursor: 0,
      gcCursor: readU16LE(data, base + gcCursorOff),
      lastSweepStartSlot: 0n,
      lastSweepCompleteSlot: 0n,
      crankCursor: 0,
      sweepStartIdx: 0,
      lifetimeLiquidations: 0n,
      lifetimeForceCloses: 0n,
      netLpPos: 0n,
      lpSumAbs: 0n,
      lpMaxAbs: 0n,
      lpMaxAbsSweep: 0n,
      emergencyOiMode: false,
      emergencyStartSlot: 0n,
      lastBreakerSlot: 0n,
      markPriceE6: 0n,
      oraclePriceE6: readU64LE(data, base + oraclePriceOff),
      numUsedAccounts: readU16LE(data, base + bitmapEnd),
      nextAccountId: 0n,               // removed in v12.17 (replaced by mat_counter in header)

      // V12_17 fields
      fLongNum: readI128LE(data, base + fLongNumOff),
      fShortNum: readI128LE(data, base + fShortNumOff),
      negPnlAccountCount: readU64LE(data, base + negPnlOff),
      fundPxLast: readU64LE(data, base + fundPxLastOff),
      resolvedKLongTerminalDelta: readI128LE(data, base + resolvedKLongOff),
      resolvedKShortTerminalDelta: readI128LE(data, base + resolvedKShortOff),
      resolvedLivePrice: readU64LE(data, base + resolvedLivePriceOff),
    };
  }

  // For v12.15: funding_rate_e9 is i128 at layout.engineFundingRateBpsOff (224 SBF, 240 native).
  // For pre-v12.15: i64 at engineFundingRateBpsOff.
  const fundingRateBpsPerSlotLast = isV12_15
    ? readI128LE(data, base + layout.engineFundingRateBpsOff)
    : readI64LE(data, base + layout.engineFundingRateBpsOff);

  return {
    vault: readU128LE(data, base),
    insuranceFund: {
      balance: readU128LE(data, base + layout.engineInsuranceOff),
      // feeRevenue: only exists in percolator-core (80-byte InsuranceFund), not deployed (16-byte)
      feeRevenue: layout.hasInsuranceIsolation
        ? readU128LE(data, base + layout.engineInsuranceOff + 16)
        : 0n,
      isolatedBalance: layout.hasInsuranceIsolation
        ? readU128LE(data, base + layout.engineInsuranceIsolatedOff)
        : 0n,
      isolationBps: layout.hasInsuranceIsolation
        ? readU16LE(data, base + layout.engineInsuranceIsolationBpsOff)
        : 0,
    },
    currentSlot: readU64LE(data, base + layout.engineCurrentSlotOff),
    fundingIndexQpbE6: layout.engineFundingIndexOff >= 0
      ? ((layout.engineLastFundingSlotOff >= 0 && layout.engineLastFundingSlotOff - layout.engineFundingIndexOff === 8)
          ? BigInt(readI64LE(data, base + layout.engineFundingIndexOff))
          : readI128LE(data, base + layout.engineFundingIndexOff))
      : 0n,
    lastFundingSlot: layout.engineLastFundingSlotOff >= 0
      ? readU64LE(data, base + layout.engineLastFundingSlotOff) : 0n,
    fundingRateBpsPerSlotLast,
    fundingRateE9: isV12_15
      ? readI128LE(data, base + layout.engineFundingRateBpsOff)
      : 0n,
    marketMode: isV12_15
      ? (readU8(data, base + layout.engineFundingRateBpsOff + 16) === 1 ? 1 : 0)
      : null,
    lastCrankSlot: layout.engineLastCrankSlotOff >= 0
      ? readU64LE(data, base + layout.engineLastCrankSlotOff) : 0n,
    maxCrankStalenessSlots: layout.engineMaxCrankStalenessOff >= 0
      ? readU64LE(data, base + layout.engineMaxCrankStalenessOff) : 0n,
    totalOpenInterest: layout.engineTotalOiOff >= 0
      ? readU128LE(data, base + layout.engineTotalOiOff) : 0n,
    longOi: layout.engineLongOiOff >= 0
      ? readU128LE(data, base + layout.engineLongOiOff) : 0n,
    shortOi: layout.engineShortOiOff >= 0
      ? readU128LE(data, base + layout.engineShortOiOff) : 0n,
    cTot: readU128LE(data, base + layout.engineCTotOff),
    pnlPosTot: readU128LE(data, base + layout.enginePnlPosTotOff),
    pnlMaturedPosTot: isV12_15
      ? readU128LE(data, base + V12_15_ENGINE_PNL_MATURED_POS_TOT_OFF)
      : 0n,
    liqCursor: layout.engineLiqCursorOff >= 0
      ? readU16LE(data, base + layout.engineLiqCursorOff) : 0,
    gcCursor: layout.engineGcCursorOff >= 0
      ? readU16LE(data, base + layout.engineGcCursorOff) : 0,
    lastSweepStartSlot: layout.engineLastSweepStartOff >= 0
      ? readU64LE(data, base + layout.engineLastSweepStartOff) : 0n,
    lastSweepCompleteSlot: layout.engineLastSweepCompleteOff >= 0
      ? readU64LE(data, base + layout.engineLastSweepCompleteOff) : 0n,
    crankCursor: layout.engineCrankCursorOff >= 0
      ? readU16LE(data, base + layout.engineCrankCursorOff) : 0,
    sweepStartIdx: layout.engineSweepStartIdxOff >= 0
      ? readU16LE(data, base + layout.engineSweepStartIdxOff) : 0,
    lifetimeLiquidations: layout.engineLifetimeLiquidationsOff >= 0
      ? readU64LE(data, base + layout.engineLifetimeLiquidationsOff) : 0n,
    lifetimeForceCloses: layout.engineLifetimeForceClosesOff >= 0
      ? readU64LE(data, base + layout.engineLifetimeForceClosesOff) : 0n,
    netLpPos: layout.engineNetLpPosOff >= 0
      ? readI128LE(data, base + layout.engineNetLpPosOff) : 0n,
    lpSumAbs: layout.engineLpSumAbsOff >= 0
      ? readU128LE(data, base + layout.engineLpSumAbsOff) : 0n,
    lpMaxAbs: layout.engineLpMaxAbsOff >= 0 ? readU128LE(data, base + layout.engineLpMaxAbsOff) : 0n,
    lpMaxAbsSweep: layout.engineLpMaxAbsSweepOff >= 0 ? readU128LE(data, base + layout.engineLpMaxAbsSweepOff) : 0n,
    emergencyOiMode: layout.engineEmergencyOiModeOff >= 0
      ? data[base + layout.engineEmergencyOiModeOff] !== 0
      : false,
    emergencyStartSlot: layout.engineEmergencyStartSlotOff >= 0
      ? readU64LE(data, base + layout.engineEmergencyStartSlotOff) : 0n,
    lastBreakerSlot: layout.engineLastBreakerSlotOff >= 0
      ? readU64LE(data, base + layout.engineLastBreakerSlotOff) : 0n,
    markPriceE6: layout.engineMarkPriceOff >= 0
      ? readU64LE(data, base + layout.engineMarkPriceOff) : 0n,
    // V12_15: last_oracle_price at engine+608 (SBF) / engine+... (native).
    // Located at bitmapOff - 40 on SBF (648-40=608, verified on-chain).
    oraclePriceE6: isV12_15
      ? readU64LE(data, base + layout.engineBitmapOff - 40)
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

    // V12_17 fields (not present in pre-v12.17)
    fLongNum: 0n,
    fShortNum: 0n,
    negPnlAccountCount: 0n,
    fundPxLast: 0n,
    resolvedKLongTerminalDelta: 0n,
    resolvedKShortTerminalDelta: 0n,
    resolvedLivePrice: 0n,
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
  // #370: the region after `accountsOff` is NOT solely the accounts array — on
  // the v12.19 layout it also carries RISK_BUF (160 B) and the per-account
  // generation table (N x 8 B). Dividing all of it by `accountSize` over-reports
  // by 6 slots on every tier, and `parseAccount()` then happily decodes trailing
  // non-account bytes as a phantom account (owner + capital included).
  //
  // Bound by the `maxAccounts` the SDK itself computed from those same layout
  // constants: whatever the constants are, this must never exceed them.
  return Math.min(
    Math.floor(accountsEnd / layout.accountSize),
    layout.maxAccounts,
  );
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
  // V12_15 (account_size=4400): completely new layout, reserve cohorts, warmup/lastFeeSlot removed.
  // V12_1 (account_size=320/280): new fields (position_basis_q, adl_a_basis, adl_k_snap, adl_epoch_snap)
  //   shift matcher/owner/fee offsets +16 from V_ADL, and move legacy fields to end.
  // V_ADL (account_size=312): reserved_pnl grew u64→u128 (PERC-8267), shifting from pre-ADL offsets.
  // Pre-ADL (account_size<312): original offsets.
  // V12_1: engineOff=648 + bitmapOff(rel)=368. Detect by engineOff (most reliable).
  // Account is 320 on aarch64, 280 on SBF — accountSize alone is ambiguous.
  // V12_1_EP: entry_price re-added, accountSize=288 on SBF. All offsets after entry_price shift +8.
  // V12_19 SBF Account is structurally identical to V12_17 SBF (same field offsets,
  // same SBF alignment correction d1=8/d2=16). Only difference: 8 bytes of trailing
  // padding (V12_17 SBF=352, V12_19 SBF=360). Routing V12_19 to the V12_17 fast path
  // here is correct — pending_created_slot at +352 in both versions. Probe-confirmed 2026-04-28.
  const isV12_17 = layout.accountSize === V12_17_ACCOUNT_SIZE
                || layout.accountSize === V12_17_ACCOUNT_SIZE_SBF
                || layout.accountSize === V12_19_ACCOUNT_SIZE_SBF;
  const isV12_15 = !isV12_17 && (layout.accountSize === V12_15_ACCOUNT_SIZE || layout.accountSize === V12_15_ACCOUNT_SIZE_SMALL);
  const isV12_1EP = !isV12_17 && !isV12_15 && layout.accountSize === V12_1_EP_SBF_ACCOUNT_SIZE && layout.engineOff === V12_1_SBF_ENGINE_OFF;
  const isV12_1 = !isV12_17 && !isV12_15 && !isV12_1EP && (layout.engineOff === V12_1_ENGINE_OFF || layout.engineOff === V12_1_SBF_ENGINE_OFF) && (layout.accountSize === V12_1_ACCOUNT_SIZE || layout.accountSize === V12_1_ACCOUNT_SIZE_SBF);
  const isAdl = !isV12_17 && !isV12_15 && (layout.accountSize >= 312 || isV12_1 || isV12_1EP);

  if (isV12_17) {
    // V12_17 fast path: two-bucket warmup, per-side funding, no account_id/entry_price/cohorts.
    //
    // SBF vs native alignment delta:
    //   After `kind: u8`, native i128 (align=16) inserts 15 bytes pad vs SBF (align=8) 7 bytes → d1=8.
    //   After `pending_present: u8`, the same happens again: native pads 15 vs SBF 7 → d2=16.
    //   The first gap (after sched_present) does NOT add extra delta because sched_present lands at
    //   native offset 248 where (249 % 16 = 9) needs only 7 bytes — same as SBF. But pending_present
    //   lands at native 320 where (321 % 16 = 1) needs 15 bytes vs SBF's 7.
    const isSbf = layout.accountSize === V12_17_ACCOUNT_SIZE_SBF
               || layout.accountSize === V12_19_ACCOUNT_SIZE_SBF;
    const d1 = isSbf ? 8 : 0;  // fields after kind through pending_present
    const d2 = isSbf ? 16 : 0; // fields after pending_present (pending_remaining_q onward)

    const kindByte = readU8(data, base + V12_17_ACCT_KIND_OFF);
    const kind = kindByte === 1 ? AccountKind.LP : AccountKind.User;

    return {
      kind,
      accountId: 0n,           // removed in v12.17
      capital: readU128LE(data, base + V12_17_ACCT_CAPITAL_OFF),
      pnl: readI128LE(data, base + V12_17_ACCT_PNL_OFF - d1),
      reservedPnl: readU128LE(data, base + V12_17_ACCT_RESERVED_PNL_OFF - d1),
      warmupStartedAtSlot: 0n, // removed
      warmupSlopePerStep: 0n,  // removed
      positionSize: readI128LE(data, base + V12_17_ACCT_POSITION_BASIS_Q_OFF - d1),
      entryPrice: 0n,          // removed — compute off-chain from position_basis_q / effective_pos_q
      fundingIndex: 0n,        // replaced by per-side f_long_num/f_short_num + per-account f_snap
      matcherProgram: new PublicKey(data.subarray(base + V12_17_ACCT_MATCHER_PROGRAM_OFF - d1, base + V12_17_ACCT_MATCHER_PROGRAM_OFF - d1 + 32)),
      matcherContext: new PublicKey(data.subarray(base + V12_17_ACCT_MATCHER_CONTEXT_OFF - d1, base + V12_17_ACCT_MATCHER_CONTEXT_OFF - d1 + 32)),
      owner: new PublicKey(data.subarray(base + V12_17_ACCT_OWNER_OFF - d1, base + V12_17_ACCT_OWNER_OFF - d1 + 32)),
      feeCredits: readI128LE(data, base + V12_17_ACCT_FEE_CREDITS_OFF - d1),
      lastFeeSlot: 0n,         // removed
      feesEarnedTotal: 0n,     // removed in v12.17
      exactReserveCohorts: null, // replaced by two-bucket warmup
      exactCohortCount: null,
      overflowOlder: null,
      overflowOlderPresent: null,
      overflowNewest: null,
      overflowNewestPresent: null,

      // V12_17 fields
      fSnap: readI128LE(data, base + V12_17_ACCT_F_SNAP_OFF - d1),
      adlABasis: readU128LE(data, base + V12_17_ACCT_ADL_A_BASIS_OFF - d1),
      adlKSnap: readI128LE(data, base + V12_17_ACCT_ADL_K_SNAP_OFF - d1),
      adlEpochSnap: readU64LE(data, base + V12_17_ACCT_ADL_EPOCH_SNAP_OFF - d1),
      schedPresent: readU8(data, base + V12_17_ACCT_SCHED_PRESENT_OFF - d1) !== 0,
      schedRemainingQ: readU128LE(data, base + V12_17_ACCT_SCHED_REMAINING_Q_OFF - d1),
      schedAnchorQ: readU128LE(data, base + V12_17_ACCT_SCHED_ANCHOR_Q_OFF - d1),
      schedStartSlot: readU64LE(data, base + V12_17_ACCT_SCHED_START_SLOT_OFF - d1),
      schedHorizon: readU64LE(data, base + V12_17_ACCT_SCHED_HORIZON_OFF - d1),
      schedReleaseQ: readU128LE(data, base + V12_17_ACCT_SCHED_RELEASE_Q_OFF - d1),
      pendingPresent: readU8(data, base + V12_17_ACCT_PENDING_PRESENT_OFF - d1) !== 0,
      pendingRemainingQ: readU128LE(data, base + V12_17_ACCT_PENDING_REMAINING_Q_OFF - d2),
      pendingHorizon: readU64LE(data, base + V12_17_ACCT_PENDING_HORIZON_OFF - d2),
      pendingCreatedSlot: readU64LE(data, base + V12_17_ACCT_PENDING_CREATED_SLOT_OFF - d2),
    };
  }

  if (isV12_15) {
    // V12_15 fast path: fixed offsets, all fields explicit.
    const kindByte = readU8(data, base + V12_15_ACCT_KIND_OFF);
    const kind = kindByte === 1 ? AccountKind.LP : AccountKind.User;

    // Parse the 62 reserve cohorts
    const cohortCount = readU8(data, base + V12_15_ACCT_EXACT_COHORT_COUNT_OFF);
    const exactReserveCohorts: ReserveCohortBytes[] = [];
    for (let i = 0; i < 62; i++) {
      const cohortOff = base + V12_15_ACCT_EXACT_RESERVE_COHORTS_OFF + i * 64;
      exactReserveCohorts.push(data.slice(cohortOff, cohortOff + 64));
    }

    const overflowOlderPresent = readU8(data, base + V12_15_ACCT_OVERFLOW_OLDER_PRESENT_OFF) !== 0;
    const overflowNewestPresent = readU8(data, base + V12_15_ACCT_OVERFLOW_NEWEST_PRESENT_OFF) !== 0;

    return {
      kind,
      accountId: readU64LE(data, base + V12_15_ACCT_ACCOUNT_ID_OFF),
      capital: readU128LE(data, base + V12_15_ACCT_CAPITAL_OFF),
      pnl: readI128LE(data, base + V12_15_ACCT_PNL_OFF),
      reservedPnl: readU128LE(data, base + V12_15_ACCT_RESERVED_PNL_OFF),
      warmupStartedAtSlot: 0n,  // removed in v12.15
      warmupSlopePerStep: 0n,   // removed in v12.15
      positionSize: readI128LE(data, base + V12_15_ACCT_POSITION_BASIS_Q_OFF),
      entryPrice: readU64LE(data, base + V12_15_ACCT_ENTRY_PRICE_OFF),
      fundingIndex: 0n,          // not present in v12.15 account struct
      matcherProgram: new PublicKey(data.subarray(base + V12_15_ACCT_MATCHER_PROGRAM_OFF, base + V12_15_ACCT_MATCHER_PROGRAM_OFF + 32)),
      matcherContext: new PublicKey(data.subarray(base + V12_15_ACCT_MATCHER_CONTEXT_OFF, base + V12_15_ACCT_MATCHER_CONTEXT_OFF + 32)),
      owner: new PublicKey(data.subarray(base + V12_15_ACCT_OWNER_OFF, base + V12_15_ACCT_OWNER_OFF + 32)),
      feeCredits: readI128LE(data, base + V12_15_ACCT_FEE_CREDITS_OFF),
      lastFeeSlot: 0n,           // removed in v12.15
      feesEarnedTotal: readU128LE(data, base + V12_15_ACCT_FEES_EARNED_TOTAL_OFF),
      exactReserveCohorts,
      exactCohortCount: cohortCount,
      overflowOlder: data.slice(base + V12_15_ACCT_OVERFLOW_OLDER_OFF, base + V12_15_ACCT_OVERFLOW_OLDER_OFF + 64),
      overflowOlderPresent,
      overflowNewest: data.slice(base + V12_15_ACCT_OVERFLOW_NEWEST_OFF, base + V12_15_ACCT_OVERFLOW_NEWEST_OFF + 64),
      overflowNewestPresent,

      // v12.17 fields (not present in v12.15)
      fSnap: 0n, adlABasis: 0n, adlKSnap: 0n, adlEpochSnap: 0n,
      schedPresent: null, schedRemainingQ: null, schedAnchorQ: null,
      schedStartSlot: null, schedHorizon: null, schedReleaseQ: null,
      pendingPresent: null, pendingRemainingQ: null, pendingHorizon: null, pendingCreatedSlot: null,
    };
  }

  // Pre-v12.15 path
  const warmupStartedOff = isAdl ? V_ADL_ACCT_WARMUP_STARTED_OFF : ACCT_WARMUP_STARTED_OFF;
  const warmupSlopeOff   = isAdl ? V_ADL_ACCT_WARMUP_SLOPE_OFF   : ACCT_WARMUP_SLOPE_OFF;
  const positionSizeOff  = (isV12_1 || isV12_1EP) ? V12_1_ACCT_POSITION_SIZE_OFF : (isAdl ? V_ADL_ACCT_POSITION_SIZE_OFF : ACCT_POSITION_SIZE_OFF);
  const entryPriceOff    = isV12_1EP ? V12_1_EP_ACCT_ENTRY_PRICE_OFF : (isV12_1 ? V12_1_ACCT_ENTRY_PRICE_OFF : (isAdl ? V_ADL_ACCT_ENTRY_PRICE_OFF : ACCT_ENTRY_PRICE_OFF));
  const fundingIndexOff  = (isV12_1 || isV12_1EP) ? -1 : (isAdl ? V_ADL_ACCT_FUNDING_INDEX_OFF : ACCT_FUNDING_INDEX_OFF);
  const matcherProgOff   = isV12_1EP ? V12_1_EP_ACCT_MATCHER_PROGRAM_OFF : (isV12_1 ? V12_1_ACCT_MATCHER_PROGRAM_OFF : (isAdl ? V_ADL_ACCT_MATCHER_PROGRAM_OFF : ACCT_MATCHER_PROGRAM_OFF));
  const matcherCtxOff    = isV12_1EP ? V12_1_EP_ACCT_MATCHER_CONTEXT_OFF : (isV12_1 ? V12_1_ACCT_MATCHER_CONTEXT_OFF : (isAdl ? V_ADL_ACCT_MATCHER_CONTEXT_OFF : ACCT_MATCHER_CONTEXT_OFF));
  const feeCreditsOff    = isV12_1EP ? V12_1_EP_ACCT_FEE_CREDITS_OFF : (isV12_1 ? V12_1_ACCT_FEE_CREDITS_OFF : (isAdl ? V_ADL_ACCT_FEE_CREDITS_OFF : ACCT_FEE_CREDITS_OFF));
  const lastFeeSlotOff   = isV12_1EP ? V12_1_EP_ACCT_LAST_FEE_SLOT_OFF : (isV12_1 ? V12_1_ACCT_LAST_FEE_SLOT_OFF : (isAdl ? V_ADL_ACCT_LAST_FEE_SLOT_OFF : ACCT_LAST_FEE_SLOT_OFF));

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
    entryPrice: entryPriceOff >= 0 ? readU64LE(data, base + entryPriceOff) : 0n,
    // V12_1/V12_1_EP: funding_index not present in SBF layout
    fundingIndex: (isV12_1 || isV12_1EP) ? (fundingIndexOff >= 0 ? BigInt(readI64LE(data, base + fundingIndexOff)) : 0n) : readI128LE(data, base + fundingIndexOff),
    matcherProgram: new PublicKey(data.subarray(base + matcherProgOff, base + matcherProgOff + 32)),
    matcherContext: new PublicKey(data.subarray(base + matcherCtxOff, base + matcherCtxOff + 32)),
    owner: new PublicKey(data.subarray(base + layout.acctOwnerOff, base + layout.acctOwnerOff + 32)),
    feeCredits: readI128LE(data, base + feeCreditsOff),
    lastFeeSlot: readU64LE(data, base + lastFeeSlotOff),
    feesEarnedTotal: 0n,              // not present in pre-v12.15 layouts
    exactReserveCohorts: null,        // not present in pre-v12.15 layouts
    exactCohortCount: null,
    overflowOlder: null,
    overflowOlderPresent: null,
    overflowNewest: null,
    overflowNewestPresent: null,

    // v12.17 fields (not present in pre-v12.17)
    fSnap: 0n, adlABasis: 0n, adlKSnap: 0n, adlEpochSnap: 0n,
    schedPresent: null, schedRemainingQ: null, schedAnchorQ: null,
    schedStartSlot: null, schedHorizon: null, schedReleaseQ: null,
    pendingPresent: null, pendingRemainingQ: null, pendingHorizon: null, pendingCreatedSlot: null,
  };
}

// =============================================================================
// v17 (WrapperConfigV16) — 496-byte config block in the market group account
//
// Protocol-fee program change (feat/protocol-fee-taker-only, wrapper HEAD
// 626fb617): WrapperConfigV16 grew 432 -> 496 bytes (three new tail fields,
// see WrapperConfigV17 below) and the account VERSION bumped 16 -> 17. This
// is a full account-layout break — every v16-version market account is
// abandoned; only VERSION=17 accounts carry the 496-byte config block.
// =============================================================================

/**
 * v17 account magic ("PERCV16\0" as little-endian u64).
 * Stored at bytes [0..8] of every v17 percolator-owned account.
 * bytes[0..8] = [0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]
 */
export const V17_MAGIC = 0x5045_5243_5631_3600n;

/**
 * v18 account version (u16 at offset 8).
 *
 * Bumped 17 -> 18 by the v16-migration integration (percolator-prog
 * `sync/integration-v16`@a9318945, `v16_program.rs:72` `pub const VERSION:
 * u16 = 18`) — the identity-binding overhaul (market_id/intent_id/
 * authority_epoch CAS binding), PortfolioAccountV16's +24B identity trailer
 * (9539 -> 9563), and the AssetOracleProfileV16/AssetControlSequencesV16
 * per-asset slot growth (512 -> 1024) are all account-layout/wire-breaking.
 * Fails closed on any pre-migration (VERSION=17) account — those must be
 * re-seeded (F-01), not read with this parser. The constant keeps its
 * `V17_`-prefixed name for source-compat with existing callers; only the
 * value changed.
 */
export const V17_EXPECTED_VERSION = 18;

/**
 * v17 account-kind byte (offset 10 of the 16-byte header).
 *
 * The program's `check_header()` discriminates EVERY v17 percolator-owned
 * account SOLELY by this byte (percolator-prog `v16_program.rs` KIND_*):
 *   1 = MARKET, 2 = PORTFOLIO, 3 = BACKING_DOMAIN_LEDGER, 4 = INSURANCE_LEDGER,
 *   5 = LP_VAULT_REGISTRY, 6 = LP_REDEMPTION, 7 = NFT_REGISTRY.
 * Only KIND_MARKET (1) carries the WrapperConfigV16 block parsed during market
 * discovery — every other kind shares the same magic+version and would falsely
 * pass the looser {@link isV17Account} check (#264).
 */
export const V17_KIND_MARKET = 1;

/** Byte offset of the v17 account-kind discriminator within the header. */
export const V17_KIND_OFF = 10;

/**
 * v17 wrapper config block length (WrapperConfigV16 = 576 bytes).
 *
 * Growth history, each stage purely additive at the tail with all earlier
 * offsets UNCHANGED:
 *   432 -> 496  protocol-fee program change: `protocol_fee_authority` [32]
 *               @432, `protocol_fee_accrued_atoms` u128 @464,
 *               `protocol_fee_withdrawn_atoms` u128 @480.
 *   496 -> 576  fee-collection split (percolator-prog
 *               feat/protocol-fee-taker-only@2b3a6a65): four u128 counters
 *               @496/512/528/544, three u16 shares @560/562/564, then
 *               `_padding_split` [u8;10] @566.
 *
 * ⚠ FIELD ORDER IN THE 496->576 BLOCK IS LOAD-BEARING. The struct derives
 * `bytemuck::Pod`, which forbids IMPLICIT padding. 496 is a multiple of 16, so
 * it is u128-aligned; placing the u16 shares first would push the u128s to
 * offset 502 and force the compiler to insert implicit padding, failing the
 * Pod derive. Counters therefore come first, then the shares, then EXPLICIT
 * padding out to the 16-byte alignment boundary.
 *
 * Verified against `percolator-prog/src/v16_program.rs` — `WRAPPER_CONFIG_LEN:
 * usize = 576` at line 58, struct `WrapperConfigV16` at line 1057, with a
 * compile-time `assert!(size_of::<WrapperConfigV16>() == WRAPPER_CONFIG_LEN)`
 * at line 1159.
 *
 * ⚠ NOT YET DEPLOYED. The devnet wrapper DhSkE7uTb8HBUYYWF1xkxMYBGtLYJEoDq1tfBD7SnHcj
 * still carries the 496-byte layout. Reading a market created by that build
 * with this decoder will throw "data too short"; a 576-byte read against a
 * 496-byte account is a length error, not a silent misparse.
 */
export const V17_WRAPPER_CONFIG_LEN = 576;

/**
 * Byte offset of `creator_fee_claimable_atoms` (u64 LE) RELATIVE TO THE START
 * OF THE WrapperConfigV16 BLOCK. Absolute offset in a market-group account is
 * `V17_HEADER_LEN + V17_CREATOR_FEE_CLAIMABLE_OFF` = 16 + 568 = 584.
 *
 * ADDITIVE AND IN-PLACE: the field was carved out of the existing 10-byte
 * `_padding_split` tail at the only 8-aligned slot inside it, so
 * {@link V17_WRAPPER_CONFIG_LEN} stays 576, {@link V17_MARKET_GROUP_OFF} stays
 * 592, and NO pre-existing offset moves. Growing the config instead would have
 * shifted every asset-profile offset and bricked the already-deployed 576-byte
 * markets — a repeat of the 496→576 incident. If you ever find yourself
 * changing V17_WRAPPER_CONFIG_LEN because of this field, something is wrong.
 *
 * Source of truth: percolator-prog `src/v16_program.rs` struct
 * `WrapperConfigV16` (`creator_fee_claimable_atoms: u64` after
 * `_padding_split: [u8; 2]`), guarded on the Rust side by
 * `const _: () = assert!(size_of::<WrapperConfigV16>() == WRAPPER_CONFIG_LEN)`.
 */
export const V17_CREATOR_FEE_CLAIMABLE_OFF = 568;

/**
 * v18 AssetOracleProfileV16 length (integration `a9318945`, `sync/integration-v16`).
 *
 * Grew 400 -> 512 across several PURELY ADDITIVE tail-append merges, none of
 * which moved any pre-existing offset (all confirmed by the wrapper's own
 * `const _: () = assert!(size_of::<AssetOracleProfileV16>() == ASSET_ORACLE_PROFILE_LEN)`
 * compile-time guard):
 *   400 -> 408  GH#420 `creator_fee_claimable_atoms: u64` (per-asset creator
 *               fee counter — see {@link AssetOracleProfileV17.creatorFeeClaimableAtoms}).
 *   408 -> 432  GH#444 `maintenance_fee_checkpoint_slot: u64` +
 *               `maintenance_fee_previous_rate: u128`.
 *   432 -> 464  zero-move-funding accrual: `funding_mark_e6`/
 *               `funding_mark_pending_e6`/`funding_mark_pending_slot` (3×u64)
 *               + `price_move_remainder_bps_num`(u16) carved from padding +
 *               explicit `_padding1`.
 *   464 -> 480  `terminal_slab_scan_progress: u128` (CloseSlab windowed scan cursor).
 *   480 -> 496  TB-1a `next_portfolio_id: u64` + explicit `_padding2`.
 *   496 -> 512  TB-3 `insurance_top_up: u64` + `backing_top_up: u64` (one-shot
 *               top-up replay nonces).
 * The fixed per-asset wrapper slot ({@link V17_ASSET_ORACLE_WRAPPER_LEN})
 * separately grew 512 -> 1024 (TB-2a, to fit `AssetControlSequencesV16` +
 * W4-AE-84's `protocol_fee_authority_epoch`) — see that constant's own doc
 * comment. `ASSET_ORACLE_PROFILE_LEN` itself (this constant) stops at 512;
 * [512, 1024) is the control-sequences region + spare headroom, not part of
 * the profile struct.
 */
export const V17_ASSET_ORACLE_PROFILE_LEN = 512;

/**
 * v18 fixed per-asset wrapper slot size (integration `a9318945`). Grew
 * 512 -> 1024 (TB-2a, "asset control-sequences infra") to fit
 * `AssetControlSequencesV16` (88B, {@link V17_ASSET_CONTROL_SEQUENCES_LEN})
 * immediately after the profile, plus W4-AE-84's market-wide
 * `protocol_fee_authority_epoch` counter (8B,
 * {@link V17_PROTOCOL_FEE_AUTHORITY_EPOCH_OFF}) — 1024 was the smallest
 * engine-precedented `MarketWrapperPod` array length above 512 (the engine's
 * `impl_market_wrapper_pod_for_byte_arrays!` macro only covers a fixed list:
 * 0..=32, 64, 128, 256, 512, 1024).
 *
 * Layout inside this 1024-byte slot:
 *   [   0,  512) AssetOracleProfileV16 ({@link V17_ASSET_ORACLE_PROFILE_LEN})
 *   [ 512,  600) AssetControlSequencesV16 (88B, {@link V17_ASSET_CONTROL_SEQUENCES_OFF})
 *   [ 600,  608) protocol_fee_authority_epoch (8B, asset-0 slot only, {@link V17_PROTOCOL_FEE_AUTHORITY_EPOCH_OFF})
 *   [ 608, 1024) spare headroom (416B)
 */
export const V17_ASSET_ORACLE_WRAPPER_LEN = 1024;

/**
 * v18 NEW: byte offset of `AssetControlSequencesV16` within each asset's
 * {@link V17_ASSET_ORACLE_WRAPPER_LEN}-byte wrapper slot. Collapses to
 * `= V17_ASSET_ORACLE_PROFILE_LEN` (TB-2a, matching upstream `ef3b1a55`'s own definition).
 */
export const V17_ASSET_CONTROL_SEQUENCES_OFF = V17_ASSET_ORACLE_PROFILE_LEN; // 512

/**
 * v18 NEW: `size_of::<AssetControlSequencesV16>()` — 9 strictly-increasing
 * replay-nonce lanes (oracle_observation, backing_fee_long, backing_fee_short,
 * trade_fee, liquidation_fee, maintenance_fee, fee_redirect, market_init_fee,
 * permissionless_resolve) + TB-2b's `authority_epoch` CAS lane + an 8B
 * reserved tail, matching upstream `ef3b1a55`'s struct size exactly (88B total).
 */
export const V17_ASSET_CONTROL_SEQUENCES_LEN = 88;

/**
 * v18 NEW (W4-AE-84): byte offset of the market-wide
 * `protocol_fee_authority_epoch` CAS counter, gating `WithdrawProtocolFee`
 * (tag 84) against a replayed signed withdrawal surviving an intervening
 * `SetProtocolFeeAuthority` (tag 85) A->B->A cycle. Market-wide, not
 * per-asset — only asset 0's copy is ever read or written (same precedent as
 * `AssetOracleProfileV16::maintenance_fee_checkpoint_slot`/
 * `terminal_slab_scan_progress`).
 */
export const V17_PROTOCOL_FEE_AUTHORITY_EPOCH_OFF =
  V17_ASSET_CONTROL_SEQUENCES_OFF + V17_ASSET_CONTROL_SEQUENCES_LEN; // 600
/** A single u64 counter — no struct needed. */
export const V17_PROTOCOL_FEE_AUTHORITY_EPOCH_LEN = 8;

/** Field offsets (relative to the control-sequences region start) within `AssetControlSequencesV16`. */
const ACS_ORACLE_OBSERVATION_OFF     = 0;
const ACS_BACKING_FEE_LONG_OFF       = 8;
const ACS_BACKING_FEE_SHORT_OFF      = 16;
const ACS_TRADE_FEE_OFF              = 24;
const ACS_LIQUIDATION_FEE_OFF        = 32;
const ACS_MAINTENANCE_FEE_OFF        = 40;
const ACS_FEE_REDIRECT_OFF           = 48;
const ACS_MARKET_INIT_FEE_OFF        = 56;
const ACS_PERMISSIONLESS_RESOLVE_OFF = 64;
const ACS_AUTHORITY_EPOCH_OFF        = 72;
// bytes [80, 88) are `_reserved: [u8; 8]`, always zero, not decoded.

/** Decoded `AssetControlSequencesV16` — per-asset replay-nonce/CAS watermarks (v18 NEW, TB-2a/TB-2b). */
export interface AssetControlSequencesV17 {
  /** Strictly-increasing replay nonce for ConfigureHybridOracle/ConfigureEwmaMark/PushEwmaMark/ConfigureAuthMark/PushAuthMark/RestartAssetOracle's `observation_sequence`. */
  oracleObservation: bigint;
  /** Strictly-increasing replay nonce for UpdateBackingFeePolicy's long-domain `policy_sequence`. */
  backingFeeLong: bigint;
  /** Strictly-increasing replay nonce for UpdateBackingFeePolicy's short-domain `policy_sequence`. */
  backingFeeShort: bigint;
  /** Strictly-increasing replay nonce for UpdateTradeFeePolicy's `policy_sequence`. */
  tradeFee: bigint;
  /** Strictly-increasing replay nonce for UpdateLiquidationFeePolicy's `policy_sequence`. */
  liquidationFee: bigint;
  /** Strictly-increasing replay nonce for UpdateMaintenanceFeePolicy's `policy_sequence`. */
  maintenanceFee: bigint;
  /** Strictly-increasing replay nonce for UpdateFeeRedirectPolicy's `policy_sequence`. */
  feeRedirect: bigint;
  /** Strictly-increasing replay nonce for UpdateMarketInitFeePolicy's `policy_sequence`. */
  marketInitFee: bigint;
  /** Strictly-increasing replay nonce for ConfigurePermissionlessResolve's `policy_sequence`. */
  permissionlessResolve: bigint;
  /**
   * CAS (compare-and-swap) counter for `UpdateAssetAuthority` (tag 65) and
   * every other tag CAS-bound to THIS asset's `authority_epoch` lane
   * (WithdrawBackingBucket-50, WithdrawBackingBucketEarnings-52,
   * WithdrawInsuranceAsset-57, UpdateFeeSplit-86, WithdrawCreatorFee-90,
   * UpdateInsuranceWithdrawPolicy-92 where applicable). Pass the value read
   * here as the LIVE current epoch — NOT current+1 — to every such
   * instruction's `authorityEpoch` argument.
   */
  authorityEpoch: bigint;
}

/**
 * Parse `AssetControlSequencesV16` for one asset within a v18 market account
 * (v18 NEW, TB-2a/TB-2b).
 *
 * @param data       Raw market-group account bytes.
 * @param assetSlotOff  Absolute byte offset where this asset's
 *   {@link V17_ASSET_ORACLE_WRAPPER_LEN}-byte wrapper slot starts (i.e. the
 *   SAME offset passed as `profileOff` to {@link parseAssetOracleProfileV17}).
 * @returns Decoded control-sequences state.
 * @throws If `data` is too short to hold the control-sequences region.
 */
export function parseAssetControlSequencesV17(
  data: Uint8Array,
  assetSlotOff: number,
): AssetControlSequencesV17 {
  const base = assetSlotOff + V17_ASSET_CONTROL_SEQUENCES_OFF;
  const MIN_LEN = base + V17_ASSET_CONTROL_SEQUENCES_LEN;
  if (data.length < MIN_LEN) {
    throw new Error(
      `parseAssetControlSequencesV17: data too short — need ${MIN_LEN} bytes, got ${data.length}`,
    );
  }
  return {
    oracleObservation: readU64LE(data, base + ACS_ORACLE_OBSERVATION_OFF),
    backingFeeLong: readU64LE(data, base + ACS_BACKING_FEE_LONG_OFF),
    backingFeeShort: readU64LE(data, base + ACS_BACKING_FEE_SHORT_OFF),
    tradeFee: readU64LE(data, base + ACS_TRADE_FEE_OFF),
    liquidationFee: readU64LE(data, base + ACS_LIQUIDATION_FEE_OFF),
    maintenanceFee: readU64LE(data, base + ACS_MAINTENANCE_FEE_OFF),
    feeRedirect: readU64LE(data, base + ACS_FEE_REDIRECT_OFF),
    marketInitFee: readU64LE(data, base + ACS_MARKET_INIT_FEE_OFF),
    permissionlessResolve: readU64LE(data, base + ACS_PERMISSIONLESS_RESOLVE_OFF),
    authorityEpoch: readU64LE(data, base + ACS_AUTHORITY_EPOCH_OFF),
  };
}

/**
 * Parse the market-wide `protocol_fee_authority_epoch` counter (v18 NEW,
 * W4-AE-84). Lives at a fixed offset inside ASSET 0's wrapper slot only —
 * pass asset 0's slot offset (the SAME value used for asset index 0's
 * {@link parseAssetOracleProfileV17}/{@link parseAssetControlSequencesV17} calls).
 *
 * @param data          Raw market-group account bytes.
 * @param asset0SlotOff Absolute byte offset where ASSET 0's wrapper slot starts.
 * @returns The live `protocol_fee_authority_epoch` value — pass this as
 *   `authorityEpoch` to {@link encodeWithdrawProtocolFee} (CAS, expected-current).
 */
export function parseProtocolFeeAuthorityEpoch(data: Uint8Array, asset0SlotOff: number): bigint {
  const off = asset0SlotOff + V17_PROTOCOL_FEE_AUTHORITY_EPOCH_OFF;
  const MIN_LEN = off + V17_PROTOCOL_FEE_AUTHORITY_EPOCH_LEN;
  if (data.length < MIN_LEN) {
    throw new Error(
      `parseProtocolFeeAuthorityEpoch: data too short — need ${MIN_LEN} bytes, got ${data.length}`,
    );
  }
  return readU64LE(data, off);
}

/** v17 header length (16 bytes: magic[8] + version[2] + kind[1] + pad[1] + reserved[4]). */
export const V17_HEADER_LEN = 16;

/**
 * v17 market group config offset = HEADER_LEN + WRAPPER_CONFIG_LEN = 592
 * (was 512 pre-fee-split when WRAPPER_CONFIG_LEN was 496, and 448 before the
 * protocol-fee change when it was 432). DERIVED, never hardcoded — every
 * downstream offset in this file chains off it.
 */
export const V17_MARKET_GROUP_OFF = V17_HEADER_LEN + V17_WRAPPER_CONFIG_LEN; // 592

/**
 * v18 MarketGroupV16HeaderAccount size (758 bytes, UNCHANGED by the
 * v16-migration) and per-asset slot stride, verified against percolator-prog
 * `cargo run --example dump_layout` on integration branch
 * `sync/integration-v16`@a9318945.
 *
 * Per-asset slot stride grew 1797 -> 2325 (+528): `MARKET_ASSET_SLOT_LEN =
 * size_of::<Market<[u8; ASSET_ORACLE_WRAPPER_LEN]>>()` and
 * `ASSET_ORACLE_WRAPPER_LEN` itself grew 512 -> 1024 (+512, TB-2a's
 * `AssetControlSequencesV16` + W4-AE-84's `protocol_fee_authority_epoch` —
 * see {@link V17_ASSET_ORACLE_PROFILE_LEN}), and the engine-owned
 * `EngineAssetSlotV16Account` (the part of the slot AFTER the wrapper
 * prefix) independently grew 1285 -> 1301 (+16, one extra `u64` field inside
 * `AssetStateV16Account` — see {@link V17_ASSET_STATE_OI_LONG_REL}). Ground
 * truth: `cargo run --example dump_layout` printed `market slot stride=2325`
 * directly (not hand-derived from the two deltas above).
 */
export const V17_MARKET_GROUP_LEN = 758;
export const V17_MARKET_ASSET_SLOT_LEN = 2325;

/**
 * Exact byte length of a v17 market (slab) account for a given asset-slot capacity, matching the
 * program's state::market_account_len_for_capacity. v17 markets are DYNAMICALLY sized — the wrapper's
 * InitMarket validates that (len - V17_MARKET_GROUP_OFF - V17_MARKET_GROUP_LEN) is an exact multiple of
 * V17_MARKET_ASSET_SLOT_LEN, so a v12 SLAB_TIERS byte count (e.g. 992_568) makes InitMarket REVERT.
 * Size the account with this for maxPortfolioAssets (cap-1 = 3003, cap-14 = 26_364).
 */
export function v17MarketAccountLen(maxPortfolioAssets: number): number {
  if (!Number.isInteger(maxPortfolioAssets) || maxPortfolioAssets < 1) {
    throw new Error(`v17MarketAccountLen: maxPortfolioAssets must be a positive integer, got ${maxPortfolioAssets}`);
  }
  return V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN + maxPortfolioAssets * V17_MARKET_ASSET_SLOT_LEN;
}

/**
 * v18 portfolio account total length (integration `a9318945`,
 * `sync/integration-v16`) = HEADER_LEN(16) + PortfolioAccountV16Account(9419)
 * + PORTFOLIO_MATCHER_CONFIG_LEN(104) + PORTFOLIO_IDENTITY_TRAILER_LEN(24) =
 * 9563. Single source of truth for the System.createAccount size/rent: the
 * program's InitPortfolio reallocs UP to this and adds no lamports, so an
 * undersized createAccount (e.g. 2048) leaves the account below rent-exempt
 * -> InitPortfolio fails with InsufficientFundsForRent. (Matches the
 * keeper's getProgramAccounts dataSize filter.)
 *
 * FLAGGED DISCREPANCY vs the wrapper_scope spec summary (WRAPPER_SYNC_LOCKED_WIRE.md
 * says "was 9539", i.e. the v18 total minus ONLY TB-1a's +24B identity
 * trailer): this SDK's prior VERSION-17 value was 9347, not 9539. The full
 * 9347 -> 9563 delta (+216B) is NOT purely the wrapper's +24B trailer —
 * ground-truthed via `cargo run --example dump_layout` (offset_of! against
 * the pinned engine, `~/percolator` @ c141d47f) against BOTH the deployed
 * wrapper's engine snapshot and the integration branch's:
 *   - PortfolioAccountV16Account itself (engine-owned, percolator-core, NOT
 *     a wrapper-source change) grew 9227 -> 9419 (+192B): FOUR new
 *     `V16PodU128` fields (`funding_long_paid_atoms_total`,
 *     `funding_long_received_atoms_total`, `funding_short_paid_atoms_total`,
 *     `funding_short_received_atoms_total`, 64B) were inserted between
 *     `residual_received_atoms_total` and `fee_credits`, AND
 *     `PortfolioLegV16Account` gained a `kf_epoch_snap: V16PodU64` field
 *     (inserted between `f_snap` and `epoch_snap`), growing each of the 16
 *     legs 144 -> 152 bytes (128B across all legs). 64 + 128 = 192B,
 *     confirmed against the engine's own
 *     `assert!(size_of::<PortfolioAccountV16Account>() == 9419)` compile-time
 *     guard (`~/percolator/src/v16.rs`).
 *   - The wrapper's own +24B identity trailer (TB-1a: portfolio_id,
 *     matcher_sequence/expected_sequence, matcher_expiry_slot) accounts for
 *     the remaining 24B, confirmed against `PORTFOLIO_ACCOUNT_LEN == 9563`
 *     (`percolator-prog/src/v16_program.rs`, compile-time-asserted).
 * This is a real engine-crate delta this migration's own doc summary did not
 * enumerate — see {@link PortfolioV17} / {@link parsePortfolioV17} for how
 * the new fields are decoded.
 */
export const V17_PORTFOLIO_ACCOUNT_LEN = 9563;

/** `PortfolioLegV16Account` grew 144 -> 152 bytes: see {@link V17_PORTFOLIO_ACCOUNT_LEN}'s doc comment. */
export const V17_PORTFOLIO_LEG_SIZE = 152;

/**
 * The wrapper-owned identity trailer appended AFTER `PortfolioMatcherConfigV16`
 * (TB-1a): `portfolio_id: u64` + `matcher_sequence(expected_sequence): u64` +
 * `matcher_expiry_slot: u64` = 24 bytes total.
 */
export const V17_PORTFOLIO_IDENTITY_TRAILER_LEN = 24;

/**
 * Parsed WrapperConfigV16 — the 496-byte v17 market config block.
 *
 * Field offsets follow SBF alignment (u128 align=8, not 16).
 * Full offset table (verified against v17 wrapper source v16_program.rs,
 * protocol-fee branch feat/protocol-fee-taker-only@626fb617):
 *   0   marketauth [32]
 *   32  collateral_mint [32]
 *   64  secondary_collateral_mint [32]
 *   96  maintenance_fee_per_slot u128
 *  112  permissionless_market_init_fee u128
 *  128  trade_fee_base_bps u64
 *  136  permissionless_resolve_stale_slots u64
 *  144  force_close_delay_slots u64
 *  152  last_good_oracle_slot u64
 *  160  insurance_withdraw_deposit_remaining u128
 *  176  insurance_withdraw_max_bps u16
 *  178  liquidation_cranker_fee_share_bps u16
 *  180  maintenance_cranker_fee_share_bps u16
 *  182  backing_trade_fee_bps_long u16
 *  184  unit_scale u32
 *  188  conf_filter_bps u16
 *  190  backing_trade_fee_bps_short u16
 *  192  insurance_withdraw_deposits_only u8
 *  193  oracle_mode u8
 *  194  oracle_leg_count u8
 *  195  oracle_leg_flags u8
 *  196  invert u8
 *  197  _padding0 u8
 *  198  free_market_slot_count u16
 *  200  insurance_withdraw_cooldown_slots u64
 *  208  last_insurance_withdraw_slot u64
 *  216  max_staleness_secs u64
 *  224  hybrid_soft_stale_slots u64
 *  232  mark_ewma_e6 u64
 *  240  mark_ewma_last_slot u64
 *  248  mark_ewma_halflife_slots u64
 *  256  mark_min_fee u64
 *  264  oracle_target_price_e6 u64
 *  272  oracle_target_publish_time i64
 *  280  oracle_leg_feeds [[u8;32];3] (96B)
 *  376  oracle_leg_prices_e6 [u64;3] (24B)
 *  400  oracle_leg_publish_times [i64;3] (24B)
 *  424  backing_trade_fee_policy_count u16
 *  426  backing_trade_fee_insurance_share_bps_long u16
 *  428  backing_trade_fee_insurance_share_bps_short u16
 *  430  fee_redirect_to_market_0_bps u16
 *  --- protocol-fee program change (additive tail, offsets 0..431 unchanged) ---
 *  432  protocol_fee_authority [32]
 *  464  protocol_fee_accrued_atoms u128
 *  480  protocol_fee_withdrawn_atoms u128
 *  --- fee-collection split (additive tail, offsets 0..495 unchanged) ---
 *  --- ORDER IS LOAD-BEARING: u128 counters MUST precede the u16 shares ---
 *  496  lp_fee_accrued_atoms u128
 *  512  lp_fee_withdrawn_atoms u128
 *  528  insurance_reserve_accrued_atoms u128
 *  544  insurance_reserve_withdrawn_atoms u128
 *  560  creator_share_bps u16
 *  562  lp_share_bps u16
 *  564  insurance_share_bps u16
 *  566  _padding_split [u8;2]              (was [u8;10] pre-creator-fee-claim)
 *  --- creator fee claim (2026-07-23) — IN-PLACE, consumes the pad tail ---
 *  568  creator_fee_claimable_atoms u64    (NEW; WRAPPER_CONFIG_LEN still 576)
 *  Total: 576
 */
export interface WrapperConfigV17 {
  marketauth: PublicKey;
  collateralMint: PublicKey;
  secondaryCollateralMint: PublicKey;
  maintenanceFeePerSlot: bigint;
  permissionlessMarketInitFee: bigint;
  tradeFeeBps: bigint;
  permissionlessResolveStaleSlots: bigint;
  forceCloseDelaySlots: bigint;
  lastGoodOracleSlot: bigint;
  insuranceWithdrawDepositRemaining: bigint;
  insuranceWithdrawMaxBps: number;
  liquidationCrankerFeeShareBps: number;
  maintenanceCrankerFeeShareBps: number;
  backingTradeFeeBpsLong: number;
  unitScale: number;
  confFilterBps: number;
  backingTradeFeeBpsShort: number;
  insuranceWithdrawDepositsOnly: number;
  oracleMode: number;
  oracleLegCount: number;
  oracleLegFlags: number;
  invert: number;
  freeMarketSlotCount: number;
  insuranceWithdrawCooldownSlots: bigint;
  lastInsuranceWithdrawSlot: bigint;
  maxStalenessSecs: bigint;
  hybridSoftStaleSlots: bigint;
  markEwmaE6: bigint;
  markEwmaLastSlot: bigint;
  markEwmaHalflifeSlots: bigint;
  markMinFee: bigint;
  oracleTargetPriceE6: bigint;
  oracleTargetPublishTime: bigint;
  oracleLegFeeds: PublicKey[];
  oracleLegPricesE6: bigint[];
  oracleLegPublishTimes: bigint[];
  backingTradeFeePolicyCount: number;
  backingTradeFeeInsuranceShareBpsLong: number;
  backingTradeFeeInsuranceShareBpsShort: number;
  feeRedirectToMarket0Bps: number;
  /**
   * Destination pubkey for the protocol's accrued fee share. Set to a
   * hardcoded program-level constant at InitMarket; rotatable only via
   * SetProtocolFeeAuthority (tag 85, upgrade-authority-gated). NOT settable
   * by marketauth/insurance_authority/any creator-facing gate.
   */
  protocolFeeAuthority: PublicKey;
  /**
   * Cumulative atoms ever accrued to the protocol's claim (monotonic). Never
   * itself credited into any domain's insurance budget — tracks an
   * unbudgeted slice of header.insurance no insurance_operator can reach.
   */
  protocolFeeAccruedAtoms: bigint;
  /**
   * Cumulative atoms ever paid out via WithdrawProtocolFee (tag 84).
   * Monotonic, always <= protocolFeeAccruedAtoms. Claim capacity =
   * protocolFeeAccruedAtoms - protocolFeeWithdrawnAtoms.
   */
  protocolFeeWithdrawnAtoms: bigint;
  /**
   * Cumulative atoms accrued to the LP vault's claim (monotonic). Claimed via
   * LpVaultCrankFees (tag 78), which reclassifies them into LP backing
   * principal.
   *
   * ⚠ LP yield is JUNIOR at-risk backing capital, not a senior earnings claim:
   * it can be impaired by backing losses between crank and redemption.
   *
   * ⚠ Tag 78 is Live-only, so LP fees accrued on a market that later Resolves
   * can never be cranked. Outstanding = accrued - withdrawn.
   */
  lpFeeAccruedAtoms: bigint;
  /** Cumulative atoms already credited to the LP vault. <= lpFeeAccruedAtoms. */
  lpFeeWithdrawnAtoms: bigint;
  /**
   * Cumulative atoms accrued to the insurance/staker leg (monotonic). Claimed
   * via WithdrawInsuranceReserveToStake (tag 87), which transfers them to the
   * bound stake pool's vault.
   *
   * ⚠ Tag 87 is Live-only and ResolveMarket is one-way, so any
   * accrued-but-unwithdrawn amount is PERMANENTLY FORFEITED once the market
   * resolves — WithdrawInsuranceAsset cannot recover it, because this leg is
   * unbudgeted by construction. Keepers should crank before resolution.
   */
  insuranceReserveAccruedAtoms: bigint;
  /** Cumulative atoms already pushed to the stake vault. <= insuranceReserveAccruedAtoms. */
  insuranceReserveWithdrawnAtoms: bigint;
  /**
   * Creator's share of T in bps. Default 1600, ceiling MAX_CREATOR_SHARE_BPS
   * (3600). Lands in insurance_domain_budget; claimed via
   * WithdrawInsuranceAsset (tag 57).
   */
  creatorShareBps: number;
  /** LP vault's share of T in bps. Default 4800, floor MIN_LP_SHARE_BPS (3200). */
  lpShareBps: number;
  /**
   * Insurance/staker share of T in bps. Default 1600, floor
   * MIN_INSURANCE_SHARE_BPS (1200). Also absorbs all sub-atom rounding, since
   * split_trade_fee computes this leg as the remainder.
   */
  insuranceShareBps: number;
  /**
   * Creator's UNCLAIMED trade-fee revenue, in collateral atoms (u64 at
   * {@link V17_CREATOR_FEE_CLAIMABLE_OFF} = 568).
   *
   * This is the honest claimable balance a creator-claim UI should display.
   * Before the creator-fee-claim change the creator leg was credited into the
   * asset's insurance DOMAIN BUDGET — the loss backstop — so "creator earned X"
   * had no on-chain representation at all and a claim button was really a
   * backstop withdrawal. The leg now lands here instead and leaves the backstop
   * alone.
   *
   * ⚠ NOT MONOTONIC and NOT an accrued/withdrawn pair. Unlike the protocol / LP
   * / insurance legs above, this is a single live balance: trades add to it and
   * WithdrawCreatorFee (tag 90) is the only thing that subtracts from it. It
   * therefore CANNOT be used to derive lifetime creator revenue — only what is
   * claimable right now. (Forced by the 10-byte pad budget; see
   * V17_CREATOR_FEE_CLAIMABLE_OFF.)
   *
   * ⚠ Markets created by a pre-upgrade build read `0n` here: bytes 568..576
   * were explicit padding, so the value is well-defined rather than garbage,
   * and the counter simply accrues fresh after an in-place upgrade.
   */
  creatorFeeClaimableAtoms: bigint;
}

/**
 * Parse a v17 WrapperConfigV16 block from raw account data.
 *
 * The config block starts at offset `configOff` (default: V17_HEADER_LEN = 16).
 *
 * IMPORTANT: v17 uses a completely different account structure from v12.x slabs.
 * This function reads the 496-byte wrapper config block directly. It does NOT
 * validate the account header magic or version — callers must do that separately.
 *
 * @param data      Raw bytes of the market group account.
 * @param configOff Byte offset where the WrapperConfigV16 block starts (default 16).
 * @returns Parsed WrapperConfigV17 object.
 *
 * @example
 * ```ts
 * const accountInfo = await connection.getAccountInfo(marketGroupPubkey);
 * if (!accountInfo) throw new Error("account not found");
 * const magic = readU64FromBytes(accountInfo.data, 0);
 * if (magic !== V17_MAGIC) throw new Error("not a v17 account");
 * const config = parseWrapperConfigV17(accountInfo.data);
 * console.log(config.collateralMint.toBase58());
 * ```
 */
export function parseWrapperConfigV17(data: Uint8Array, configOff: number = V17_HEADER_LEN): WrapperConfigV17 {
  const MIN_LEN = configOff + V17_WRAPPER_CONFIG_LEN;
  if (data.length < MIN_LEN) {
    throw new Error(
      `parseWrapperConfigV17: data too short — need ${MIN_LEN} bytes, got ${data.length}`,
    );
  }

  const b = configOff;

  // Offsets from the WrapperConfigV16 offset table above
  const marketauth = new PublicKey(data.subarray(b + 0, b + 32));
  const collateralMint = new PublicKey(data.subarray(b + 32, b + 64));
  const secondaryCollateralMint = new PublicKey(data.subarray(b + 64, b + 96));
  const maintenanceFeePerSlot = readU128LE(data, b + 96);
  const permissionlessMarketInitFee = readU128LE(data, b + 112);
  const tradeFeeBps = readU64LE(data, b + 128);
  const permissionlessResolveStaleSlots = readU64LE(data, b + 136);
  const forceCloseDelaySlots = readU64LE(data, b + 144);
  const lastGoodOracleSlot = readU64LE(data, b + 152);
  const insuranceWithdrawDepositRemaining = readU128LE(data, b + 160);
  const insuranceWithdrawMaxBps = readU16LE(data, b + 176);
  const liquidationCrankerFeeShareBps = readU16LE(data, b + 178);
  const maintenanceCrankerFeeShareBps = readU16LE(data, b + 180);
  const backingTradeFeeBpsLong = readU16LE(data, b + 182);
  const unitScale = readU32LE(data, b + 184);
  const confFilterBps = readU16LE(data, b + 188);
  const backingTradeFeeBpsShort = readU16LE(data, b + 190);
  const insuranceWithdrawDepositsOnly = readU8(data, b + 192);
  const oracleMode = readU8(data, b + 193);
  const oracleLegCount = readU8(data, b + 194);
  const oracleLegFlags = readU8(data, b + 195);
  const invert = readU8(data, b + 196);
  // _padding0 at b+197
  const freeMarketSlotCount = readU16LE(data, b + 198);
  const insuranceWithdrawCooldownSlots = readU64LE(data, b + 200);
  const lastInsuranceWithdrawSlot = readU64LE(data, b + 208);
  const maxStalenessSecs = readU64LE(data, b + 216);
  const hybridSoftStaleSlots = readU64LE(data, b + 224);
  const markEwmaE6 = readU64LE(data, b + 232);
  const markEwmaLastSlot = readU64LE(data, b + 240);
  const markEwmaHalflifeSlots = readU64LE(data, b + 248);
  const markMinFee = readU64LE(data, b + 256);
  const oracleTargetPriceE6 = readU64LE(data, b + 264);
  const oracleTargetPublishTime = readI64LE(data, b + 272); // i64 in WrapperConfigV16 (matches parseAssetOracleProfileV17)

  // oracle_leg_feeds: [[u8;32];3] at b+280, 96 bytes total
  const ORACLE_LEG_CAP = 3;
  const oracleLegFeeds: PublicKey[] = [];
  for (let i = 0; i < ORACLE_LEG_CAP; i++) {
    oracleLegFeeds.push(new PublicKey(data.subarray(b + 280 + i * 32, b + 280 + (i + 1) * 32)));
  }

  // oracle_leg_prices_e6: [u64;3] at b+376
  const oracleLegPricesE6: bigint[] = [];
  for (let i = 0; i < ORACLE_LEG_CAP; i++) {
    oracleLegPricesE6.push(readU64LE(data, b + 376 + i * 8));
  }

  // oracle_leg_publish_times: [i64;3] at b+400
  const oracleLegPublishTimes: bigint[] = [];
  for (let i = 0; i < ORACLE_LEG_CAP; i++) {
    oracleLegPublishTimes.push(readI64LE(data, b + 400 + i * 8));
  }

  // Tail policy fields at b+424
  const backingTradeFeePolicyCount = readU16LE(data, b + 424);
  const backingTradeFeeInsuranceShareBpsLong = readU16LE(data, b + 426);
  const backingTradeFeeInsuranceShareBpsShort = readU16LE(data, b + 428);
  const feeRedirectToMarket0Bps = readU16LE(data, b + 430);

  // Protocol-fee program change (additive tail at b+432, WRAPPER_CONFIG_LEN 432 -> 496).
  const protocolFeeAuthority = new PublicKey(data.subarray(b + 432, b + 464));
  const protocolFeeAccruedAtoms = readU128LE(data, b + 464);
  const protocolFeeWithdrawnAtoms = readU128LE(data, b + 480);

  // Fee-collection split (additive tail at b+496, WRAPPER_CONFIG_LEN 496 -> 576).
  // ORDER IS LOAD-BEARING: the four u128 counters precede the three u16 shares
  // because bytemuck::Pod forbids implicit padding — see V17_WRAPPER_CONFIG_LEN.
  const lpFeeAccruedAtoms = readU128LE(data, b + 496);
  const lpFeeWithdrawnAtoms = readU128LE(data, b + 512);
  const insuranceReserveAccruedAtoms = readU128LE(data, b + 528);
  const insuranceReserveWithdrawnAtoms = readU128LE(data, b + 544);
  const creatorShareBps = readU16LE(data, b + 560);
  const lpShareBps = readU16LE(data, b + 562);
  const insuranceShareBps = readU16LE(data, b + 564);
  // _padding_split [u8;2] at b+566 .. b+568 — explicit, not read.

  // Creator fee claim (2026-07-23): carved out of the old 10-byte pad IN PLACE.
  // WRAPPER_CONFIG_LEN is STILL 576 — nothing above this line moved.
  const creatorFeeClaimableAtoms = readU64LE(data, b + V17_CREATOR_FEE_CLAIMABLE_OFF);

  return {
    marketauth,
    collateralMint,
    secondaryCollateralMint,
    maintenanceFeePerSlot,
    permissionlessMarketInitFee,
    tradeFeeBps,
    permissionlessResolveStaleSlots,
    forceCloseDelaySlots,
    lastGoodOracleSlot,
    insuranceWithdrawDepositRemaining,
    insuranceWithdrawMaxBps,
    liquidationCrankerFeeShareBps,
    maintenanceCrankerFeeShareBps,
    backingTradeFeeBpsLong,
    unitScale,
    confFilterBps,
    backingTradeFeeBpsShort,
    insuranceWithdrawDepositsOnly,
    oracleMode,
    oracleLegCount,
    oracleLegFlags,
    invert,
    freeMarketSlotCount,
    insuranceWithdrawCooldownSlots,
    lastInsuranceWithdrawSlot,
    maxStalenessSecs,
    hybridSoftStaleSlots,
    markEwmaE6,
    markEwmaLastSlot,
    markEwmaHalflifeSlots,
    markMinFee,
    oracleTargetPriceE6,
    oracleTargetPublishTime,
    oracleLegFeeds,
    oracleLegPricesE6,
    oracleLegPublishTimes,
    backingTradeFeePolicyCount,
    backingTradeFeeInsuranceShareBpsLong,
    backingTradeFeeInsuranceShareBpsShort,
    feeRedirectToMarket0Bps,
    protocolFeeAuthority,
    protocolFeeAccruedAtoms,
    protocolFeeWithdrawnAtoms,
    lpFeeAccruedAtoms,
    lpFeeWithdrawnAtoms,
    insuranceReserveAccruedAtoms,
    insuranceReserveWithdrawnAtoms,
    creatorShareBps,
    lpShareBps,
    insuranceShareBps,
    creatorFeeClaimableAtoms,
  };
}

/**
 * Parsed AssetOracleProfileV16 — the 400-byte per-asset profile in a v17 asset slot.
 *
 * Field offsets (SBF alignment, verified against v16_program.rs AssetOracleProfileV16):
 *   0   oracle_mode u8
 *   1   oracle_leg_count u8
 *   2   oracle_leg_flags u8
 *   3   invert u8
 *   4   unit_scale u32
 *   8   conf_filter_bps u16
 *  10   backing_trade_fee_bps_long u16
 *  12   backing_trade_fee_bps_short u16
 *  14   backing_trade_fee_insurance_share_bps_long u16
 *  16   backing_trade_fee_insurance_share_bps_short u16
 *  18   _padding0 [u8;6]
 *  24   insurance_authority [32]
 *  56   insurance_operator [32]
 *  88   backing_bucket_authority [32]
 * 120   oracle_authority [32]
 * 152   max_staleness_secs u64
 * 160   hybrid_soft_stale_slots u64
 * 168   mark_ewma_e6 u64
 * 176   mark_ewma_last_slot u64
 * 184   mark_ewma_halflife_slots u64
 * 192   mark_min_fee u64
 * 200   oracle_target_price_e6 u64
 * 208   oracle_target_publish_time i64
 * 216   last_good_oracle_slot u64
 * 224   oracle_leg_feeds [[u8;32];3] (96B)
 * 320   oracle_leg_prices_e6 [u64;3] (24B)
 * 344   oracle_leg_publish_times [i64;3] (24B)
 * 368   asset_admin [32]  ← v17 NEW
 * Total: 400
 */
export interface AssetOracleProfileV17 {
  oracleMode: number;
  oracleLegCount: number;
  oracleLegFlags: number;
  invert: number;
  unitScale: number;
  confFilterBps: number;
  backingTradeFeeBpsLong: number;
  backingTradeFeeBpsShort: number;
  backingTradeFeeInsuranceShareBpsLong: number;
  backingTradeFeeInsuranceShareBpsShort: number;
  insuranceAuthority: PublicKey;
  insuranceOperator: PublicKey;
  backingBucketAuthority: PublicKey;
  oracleAuthority: PublicKey;
  maxStalenessSecs: bigint;
  hybridSoftStaleSlots: bigint;
  markEwmaE6: bigint;
  markEwmaLastSlot: bigint;
  markEwmaHalflifeSlots: bigint;
  markMinFee: bigint;
  oracleTargetPriceE6: bigint;
  oracleTargetPublishTime: bigint;
  lastGoodOracleSlot: bigint;
  oracleLegFeeds: PublicKey[];
  oracleLegPricesE6: bigint[];
  oracleLegPublishTimes: bigint[];
  /** v17 NEW: asset_admin pubkey at offset 368. */
  assetAdmin: PublicKey;
  /** v18 NEW (GH#420, offset 400): this asset's unclaimed creator share of trade fees. Claim via {@link encodeWithdrawCreatorFee}. */
  creatorFeeClaimableAtoms: bigint;
  /** v18 NEW (GH#444, offset 408): slot at which `maintenance_fee_per_slot` last changed (asset-0 only; market-wide). */
  maintenanceFeeCheckpointSlot: bigint;
  /** v18 NEW (GH#444, offset 416): the maintenance fee rate in force before the last change (asset-0 only; market-wide). */
  maintenanceFeePreviousRate: bigint;
  /** v18 NEW (zero-move-funding, offset 432): mark whose premium applies at the engine asset's current slot. Zero = not-yet-initialized. */
  fundingMarkE6: bigint;
  /** v18 NEW (offset 440): first prospective mark that must not affect funding before its slot. */
  fundingMarkPendingE6: bigint;
  /** v18 NEW (offset 448): slot at which `fundingMarkPendingE6` takes effect. */
  fundingMarkPendingSlot: bigint;
  /** v18 NEW (offset 456): canonical price-move-cap numerator remainder carried across accrual calls. */
  priceMoveRemainderBpsNum: number;
  /** v18 NEW (offset 464): CloseSlab windowed terminal-slab-scan continuation cursor (asset-0 only; market-wide). 0 = start of scan. */
  terminalSlabScanProgress: bigint;
  /** v18 NEW (TB-1a, offset 480): market-scoped monotonic counter allocating each `InitPortfolio`'s `portfolio_id` (asset-0 only; market-wide). */
  nextPortfolioId: bigint;
  /** v18 NEW (TB-3, offset 496): one-shot replay nonce for TopUpInsurance(9)/TopUpInsuranceDomain(56) — asset-0 only, market-wide, shared by both entrypoints. */
  insuranceTopUp: bigint;
  /** v18 NEW (TB-3, offset 504): one-shot replay nonce for TopUpBackingBucket(24), keyed per-asset (`domain / 2`). */
  backingTopUp: bigint;
}

/**
 * Parse a v18 AssetOracleProfileV16 block from raw account data (integration
 * `a9318945`). See {@link V17_ASSET_ORACLE_PROFILE_LEN}'s doc comment for the
 * full 400 -> 512 tail-append history.
 *
 * @param data      Raw bytes containing the profile block.
 * @param profileOff Byte offset where the AssetOracleProfileV16 starts.
 * @returns Parsed AssetOracleProfileV17 object.
 */
export function parseAssetOracleProfileV17(data: Uint8Array, profileOff: number): AssetOracleProfileV17 {
  const MIN_LEN = profileOff + V17_ASSET_ORACLE_PROFILE_LEN;
  if (data.length < MIN_LEN) {
    throw new Error(
      `parseAssetOracleProfileV17: data too short — need ${MIN_LEN} bytes, got ${data.length}`,
    );
  }

  const b = profileOff;
  const ORACLE_LEG_CAP = 3;

  const oracleLegFeeds: PublicKey[] = [];
  for (let i = 0; i < ORACLE_LEG_CAP; i++) {
    oracleLegFeeds.push(new PublicKey(data.subarray(b + 224 + i * 32, b + 224 + (i + 1) * 32)));
  }

  const oracleLegPricesE6: bigint[] = [];
  for (let i = 0; i < ORACLE_LEG_CAP; i++) {
    oracleLegPricesE6.push(readU64LE(data, b + 320 + i * 8));
  }

  const oracleLegPublishTimes: bigint[] = [];
  for (let i = 0; i < ORACLE_LEG_CAP; i++) {
    oracleLegPublishTimes.push(readI64LE(data, b + 344 + i * 8));
  }

  return {
    oracleMode: readU8(data, b + 0),
    oracleLegCount: readU8(data, b + 1),
    oracleLegFlags: readU8(data, b + 2),
    invert: readU8(data, b + 3),
    unitScale: readU32LE(data, b + 4),
    confFilterBps: readU16LE(data, b + 8),
    backingTradeFeeBpsLong: readU16LE(data, b + 10),
    backingTradeFeeBpsShort: readU16LE(data, b + 12),
    backingTradeFeeInsuranceShareBpsLong: readU16LE(data, b + 14),
    backingTradeFeeInsuranceShareBpsShort: readU16LE(data, b + 16),
    insuranceAuthority: new PublicKey(data.subarray(b + 24, b + 56)),
    insuranceOperator: new PublicKey(data.subarray(b + 56, b + 88)),
    backingBucketAuthority: new PublicKey(data.subarray(b + 88, b + 120)),
    oracleAuthority: new PublicKey(data.subarray(b + 120, b + 152)),
    maxStalenessSecs: readU64LE(data, b + 152),
    hybridSoftStaleSlots: readU64LE(data, b + 160),
    markEwmaE6: readU64LE(data, b + 168),
    markEwmaLastSlot: readU64LE(data, b + 176),
    markEwmaHalflifeSlots: readU64LE(data, b + 184),
    markMinFee: readU64LE(data, b + 192),
    oracleTargetPriceE6: readU64LE(data, b + 200),
    oracleTargetPublishTime: readI64LE(data, b + 208),
    lastGoodOracleSlot: readU64LE(data, b + 216),
    oracleLegFeeds,
    oracleLegPricesE6,
    oracleLegPublishTimes,
    assetAdmin: new PublicKey(data.subarray(b + 368, b + 400)),
    creatorFeeClaimableAtoms: readU64LE(data, b + 400),
    maintenanceFeeCheckpointSlot: readU64LE(data, b + 408),
    maintenanceFeePreviousRate: readU128LE(data, b + 416),
    fundingMarkE6: readU64LE(data, b + 432),
    fundingMarkPendingE6: readU64LE(data, b + 440),
    fundingMarkPendingSlot: readU64LE(data, b + 448),
    priceMoveRemainderBpsNum: readU16LE(data, b + 456),
    // bytes [458, 464) are `_padding1: [u8; 6]`, always zero, not decoded.
    terminalSlabScanProgress: readU128LE(data, b + 464),
    nextPortfolioId: readU64LE(data, b + 480),
    // bytes [488, 496) are `_padding2: [u8; 8]`, always zero, not decoded.
    insuranceTopUp: readU64LE(data, b + 496),
    backingTopUp: readU64LE(data, b + 504),
  };
}

/**
 * Check if a raw account buffer contains a v17 percolator account.
 *
 * @param data Raw account bytes.
 * @returns true if magic == V17_MAGIC and version == V17_EXPECTED_VERSION.
 */
export function isV17Account(data: Uint8Array): boolean {
  if (data.length < 10) return false;
  const magic = readU64LE(data, 0);
  const version = readU16LE(data, 8);
  return magic === V17_MAGIC && version === V17_EXPECTED_VERSION;
}

/**
 * Check if a raw account buffer is a v17 percolator MARKET account.
 *
 * Stricter than {@link isV17Account}: requires both that the account is a valid
 * v17 account (magic + version) AND that the kind byte at offset 10 is
 * {@link V17_KIND_MARKET}. Portfolio / ledger / registry accounts share the same
 * magic+version and so pass `isV17Account`, but they are NOT markets and do not
 * carry a WrapperConfigV16 block — market discovery must gate on this (#264).
 *
 * @param data Raw account bytes.
 * @returns true if the account is a v17 account whose kind == KIND_MARKET (1).
 */
export function isV17MarketAccount(data: Uint8Array): boolean {
  if (data.length < V17_KIND_OFF + 1) return false;
  if (!isV17Account(data)) return false;
  return data[V17_KIND_OFF] === V17_KIND_MARKET;
}

// =============================================================================
// V17 OI parser
// =============================================================================

/**
 * Relative offset of insurance within MarketGroupV16HeaderAccount:
 *   market_group_id[32] + V16ConfigAccount[249] + asset_slot_capacity(V16PodU32)[4] + vault(V16PodU128)[16] = 301
 */
const V17_HEADER_INSURANCE_OFF = 301;

/**
 * Wrapper T size preceding EngineAssetSlotV16Account in each Market<T> slot.
 * v18 (integration `a9318945`): Wrapper T = {@link V17_ASSET_ORACLE_WRAPPER_LEN} = 1024
 * bytes (was 512 pre-migration) — see that constant's own doc comment.
 * Kept as a separate local alias (rather than importing the shared constant
 * directly into this arithmetic) to preserve this section's existing
 * structure; value MUST match {@link V17_ASSET_ORACLE_WRAPPER_LEN}.
 */
const V17_ASSET_SLOT_WRAPPER_SIZE = V17_ASSET_ORACLE_WRAPPER_LEN;

/**
 * Offsets of oi_eff_long_q and oi_eff_short_q within AssetStateV16Account
 * (the first sub-struct of EngineAssetSlotV16Account, at slot offset = wrapper size).
 *
 * v18 (integration `a9318945`): ground-truthed via `cargo run --example
 * dump_layout` (offset_of!) directly, then confirmed against source —
 * `AssetStateV16Account` gained two new fields (engine-owned, percolator-core,
 * not called out anywhere in the migration's own spec summary):
 * `kf_epoch_long: V16PodU64` + `kf_epoch_short: V16PodU64` (8B each, 16B
 * total), inserted between `f_short_num` and `k_epoch_start_long`
 * (`~/percolator/src/v16.rs:7385-7386`). That shifts both OI offsets +16 vs
 * the pre-migration values (273 -> 289, 289 -> 305). Ground truth:
 * `oi_eff_long_q` @289, `oi_eff_short_q` @305.
 */
const V17_ASSET_STATE_OI_LONG_REL = 289;
const V17_ASSET_STATE_OI_SHORT_REL = 305;

/**
 * Aggregated open-interest parsed from a v17 market group account.
 *
 * The v17 engine stores OI per-asset (per Market<T> slot) as oi_eff_long_q and
 * oi_eff_short_q in AssetStateV16Account. This parser sums across all capacity
 * slots in the account and also returns per-asset breakdown.
 *
 * All quantities are in token micro-units (raw, not scaled by decimals).
 */
export interface V17MarketGroupOI {
  /** Group-level insurance reserve (u128, micro-units) */
  insuranceBalance: bigint;
  /** Sum of oi_eff_long_q across all asset slots */
  totalLongOiQ: bigint;
  /** Sum of oi_eff_short_q across all asset slots */
  totalShortOiQ: bigint;
  /** Per-slot breakdown (only slots where at least one side is non-zero) */
  assets: Array<{
    assetIndex: number;
    oiEffLongQ: bigint;
    oiEffShortQ: bigint;
  }>;
}

/**
 * Parse open-interest fields from a v17 market group account.
 *
 * Reads the group-level insurance balance from MarketGroupV16HeaderAccount and
 * iterates every asset-slot capacity to accumulate oi_eff_long_q / oi_eff_short_q
 * from AssetStateV16Account (the first sub-struct of EngineAssetSlotV16Account
 * which follows the 512-byte wrapper T at the start of each slot).
 *
 * Relative offsets verified with `offset_of!` against the engine's own `#[repr(C)]`
 * structs (`percolator/src/v16.rs`): `MarketGroupV16HeaderAccount::insurance` @ 301,
 * `AssetStateV16Account::oi_eff_long_q` @ 273, `oi_eff_short_q` @ 289. Every
 * `V16Pod*` field is an align-1 `[u8; N]` and the structs derive `bytemuck::Pod`
 * (which forbids implicit padding), so these are exact byte offsets.
 *
 * The absolute offsets below follow from the CURRENT wrapper layout —
 * WRAPPER_CONFIG_LEN = 576 and V17_MARKET_GROUP_OFF = 16 + 576 = 592
 * (`v16_program.rs` HEADER_LEN/WRAPPER_CONFIG_LEN, with a compile-time
 * `assert!(size_of::<WrapperConfigV16>() == WRAPPER_CONFIG_LEN)`):
 * - slots base:        V17_MARKET_GROUP_OFF(592) + V17_MARKET_GROUP_LEN(758) = 1350
 * - insurance:         592 + 301 = 893
 * - oi_eff_long_q(i):  1350 + i×1797 + 512 + 273 = 2135 + i×1797
 * - oi_eff_short_q(i): 1350 + i×1797 + 512 + 289 = 2151 + i×1797
 *
 * (This block previously quoted 432/496 and 448/512 from a pre-fee-split layout,
 * giving insurance @ 813. The CODE was always correct — it composes the named
 * constants — but the stated numbers were stale. Verified against the first real
 * v17 market on the new devnet deployment.)
 *
 * @param data  Raw bytes of the v17 market group account.
 * @returns Parsed V17MarketGroupOI — zero OI when no active positions exist.
 * @throws Error if the buffer is not a valid v17 market account or is too short.
 *
 * @example
 * ```ts
 * const info = await connection.getAccountInfo(marketGroupPk);
 * if (!isV17MarketAccount(new Uint8Array(info.data))) throw new Error("not v17");
 * const oi = parseMarketGroupV17OI(new Uint8Array(info.data));
 * console.log(`long OI: ${oi.totalLongOiQ}, short OI: ${oi.totalShortOiQ}`);
 * ```
 */
export function parseMarketGroupV17OI(data: Uint8Array): V17MarketGroupOI {
  // VERSION-keyed geometry (never inferred from the length): v2.1 and v2.2 have different group / slot sizes.
  const g = resolveMarketGeometry(data, { parser: "parseMarketGroupV17OI", strictLength: false });
  const L = g.layout;

  const insuranceBalance = readU128LE(data, g.groupOff + L.group.insurance);

  let totalLongOiQ = 0n;
  let totalShortOiQ = 0n;
  const assets: V17MarketGroupOI["assets"] = [];

  for (let i = 0; i < g.slotCount; i++) {
    // EngineAssetSlotV16Account starts after the wrapper prefix; AssetStateV16Account is its first field.
    const longOff = g.engineOff(i) + L.assetState.oiEffLongQ;
    const shortOff = g.engineOff(i) + L.assetState.oiEffShortQ;

    // Guard against a truncated buffer (should not happen on well-formed accounts).
    if (shortOff + 16 > data.length) break;

    const oiEffLongQ = readU128LE(data, longOff);
    const oiEffShortQ = readU128LE(data, shortOff);

    totalLongOiQ += oiEffLongQ;
    totalShortOiQ += oiEffShortQ;

    if (oiEffLongQ !== 0n || oiEffShortQ !== 0n) {
      assets.push({ assetIndex: i, oiEffLongQ, oiEffShortQ });
    }
  }

  return { insuranceBalance, totalLongOiQ, totalShortOiQ, assets };
}

// =============================================================================
// V17 account decoders (DESYNC fixes — new standalone account types)
// =============================================================================

/** Header length for all v17 standalone accounts (magic:u64 + version:u16 + kind:u8 + reserved:5 = 16). */
const V17_ACCOUNT_HEADER_LEN = 16;
const V17_KIND_PORTFOLIO = 2;
const V17_KIND_LP_VAULT_REGISTRY = 5;
const V17_KIND_LP_REDEMPTION = 6;

function assertV17StandaloneHeader(
  data: Uint8Array,
  parserName: string,
  expectedKind: number,
): LayoutTable {
  // VERSION guard (typed UnknownLayoutError): magic, a KNOWN wrapper VERSION (18 = v2.1, 19 = v2.2) and the
  // kind. Standalone accounts whose body is identical in both layouts (registry, redemption) accept either.
  return resolveLayout(data, { parser: parserName, kind: expectedKind });
}

// PortfolioAccountV16Account field layout (relative to HEADER_LEN=16).
// Ground-truthed via `cargo run --example dump_layout` (offset_of!) against
// percolator-prog `sync/integration-v16`@a9318945 + its pinned engine
// (`~/percolator` @ c141d47f) — see {@link V17_PORTFOLIO_ACCOUNT_LEN}'s doc
// comment for the discrepancy this uncovered vs the migration's own spec
// summary.
// ProvenanceHeaderV16Account: market_group_id[32]+portfolio_account_id[32]+owner[32]+version[2]+layout_discriminator[2] = 100 bytes.
const PF_PROVENANCE_OFF              = V17_ACCOUNT_HEADER_LEN;       // 16
const PF_PROVENANCE_MARKET_GROUP_OFF = PF_PROVENANCE_OFF;            // 16..48
const PF_PROVENANCE_ACCOUNT_ID_OFF   = PF_PROVENANCE_OFF + 32;       // 48..80
const PF_PROVENANCE_OWNER_OFF        = PF_PROVENANCE_OFF + 64;       // 80..112
const PF_PROVENANCE_VERSION_OFF      = PF_PROVENANCE_OFF + 96;       // 112..114
const PF_PROVENANCE_DISC_OFF         = PF_PROVENANCE_OFF + 98;       // 114..116
const PF_BODY_OFF                    = PF_PROVENANCE_OFF + 100;      // 116 — after provenance header
const PF_OWNER_OFF                   = PF_BODY_OFF;                  // [u8;32]
const PF_CAPITAL_OFF                 = PF_BODY_OFF + 32;             // V16PodU128
const PF_PNL_OFF                     = PF_BODY_OFF + 48;             // V16PodI128
const PF_RESERVED_PNL_OFF            = PF_BODY_OFF + 64;             // V16PodU128
const PF_RESIDUAL_LOSS_OFF           = PF_BODY_OFF + 80;             // V16PodU128
const PF_RESIDUAL_PRINCIPAL_OFF      = PF_BODY_OFF + 96;             // V16PodU128
const PF_RESIDUAL_RECEIVED_OFF       = PF_BODY_OFF + 112;            // V16PodU128
// NEW (engine-owned, percolator-core, NOT a wrapper-source change): four
// V16PodU128 funding accounting counters inserted between
// `residual_received_atoms_total` and `fee_credits` — see
// {@link V17_PORTFOLIO_ACCOUNT_LEN}'s doc comment. This is the +192B/2 half
// (64B) of the flagged discrepancy; ground-truthed via `offset_of!`
// (`residual_received_atoms_total`@212, `fee_credits`@292 in the raw
// account, i.e. BODY_OFF+96 and BODY_OFF+176 respectively).
const PF_FUNDING_LONG_PAID_OFF       = PF_BODY_OFF + 128;            // V16PodU128
const PF_FUNDING_LONG_RECEIVED_OFF   = PF_BODY_OFF + 144;            // V16PodU128
const PF_FUNDING_SHORT_PAID_OFF      = PF_BODY_OFF + 160;            // V16PodU128
const PF_FUNDING_SHORT_RECEIVED_OFF  = PF_BODY_OFF + 176;            // V16PodU128
const PF_FEE_CREDITS_OFF             = PF_BODY_OFF + 192;            // V16PodI128 (was +128 pre-migration)
const PF_CANCEL_ESCROW_OFF           = PF_BODY_OFF + 208;            // V16PodU128 (was +144)
const PF_LAST_FEE_SLOT_OFF           = PF_BODY_OFF + 224;            // V16PodU64 (was +160)
const PF_ACTIVE_BITMAP_OFF           = PF_BODY_OFF + 232;            // [V16PodU64; 1] (was +168)
// PortfolioLegV16Account (152 bytes each, was 144 pre-migration): a NEW
// `kf_epoch_snap: V16PodU64` field (engine-owned) was inserted between
// `f_snap` and `epoch_snap` — the other half (128B across 16 legs) of the
// {@link V17_PORTFOLIO_ACCOUNT_LEN} discrepancy.
//   active(1)+asset_index(4)+market_id(8)+side(1)+basis_pos_q(16)+a_basis(16)+k_snap(16)+
//   f_snap(16)+kf_epoch_snap(8)+epoch_snap(8)+loss_weight(16)+b_snap(16)+b_rem(16)+
//   b_epoch_snap(8)+b_stale(1)+stale(1) = 152
const PF_LEG_SIZE                    = V17_PORTFOLIO_LEG_SIZE;       // 152
const PF_LEGS_OFF                    = PF_BODY_OFF + 240;            // [PortfolioLegV16Account; 16] (was +176)
const PF_LEGS_COUNT                  = 16;
// PortfolioSourceDomainV16Account (196 bytes each, UNCHANGED by this migration):
//   domain(4)+market_id(8)+13×u128(16 each)=208? Let me recount:
//   domain(4)+source_claim_market_id(8)+source_claim_bound_num(16)+source_claim_liened_num(16)+
//   source_claim_counterparty_liened_num(16)+source_claim_insurance_liened_num(16)+
//   source_lien_effective_reserved(16)+source_lien_counterparty_backing_num(16)+
//   source_lien_insurance_backing_num(16)+source_lien_fee_last_slot(8)+
//   source_claim_impaired_num(16)+source_lien_impaired_effective_reserved(16)+
//   source_lien_capital_at_risk_fee_revenue(16)+source_lien_impaired_capital_at_risk_fee_revenue(16)
//   = 4+8+16+16+16+16+16+16+16+8+16+16+16+16 = 196 bytes
const PF_SOURCE_DOMAIN_SIZE          = 196;
const PF_SOURCE_DOMAINS_OFF          = PF_LEGS_OFF + PF_LEGS_COUNT * PF_LEG_SIZE; // 240+16*152=2672 (rel to header)
const PF_SOURCE_DOMAINS_CAP          = 32; // PORTFOLIO_SOURCE_DOMAIN_CAP = 2 * V16_MAX_PORTFOLIO_ASSETS_N = 32
// HealthCertV16Account (121 bytes, unchanged):
const PF_HEALTH_CERT_OFF             = PF_SOURCE_DOMAINS_OFF + PF_SOURCE_DOMAINS_CAP * PF_SOURCE_DOMAIN_SIZE;
// stale_state(1)+b_stale_state(1)+rebalance_lock(1)+liquidation_lock(1) = 4 bytes after HealthCert
// CloseProgressLedgerV16Account (184 bytes, unchanged):
//   active(1)+finalized(1)+canceled(1)+close_id(8)+asset_index(4)+market_id(8)+domain_side(1)+
//   gross_loss(16)+drift_ref_slot(8)+max_close_slot(8)+support(16)+junior(16)+insurance(16)+
//   b_loss(16)+explicit(16)+adl(16)+drift_consumed(16)+residual_remaining(16) = 184
// ResolvedPayoutReceiptV16Account (66 bytes, unchanged):
//   prior_bound(16)+live_released(16)+terminal(16)+paid(16)+present(1)+finalized(1) = 66

// PortfolioMatcherConfigV16 (104 bytes, UNCHANGED total): matcher_program(32)+
// matcher_context(32)+matcher_delegate(32)+control(8). The last field was
// RENAMED `enabled` -> `control` and is now bit-packed (TB-1a, ADOPT upstream
// b594bc21/6b627b43): bit0 = enabled, bits1..49 = position_epoch, bits50..63
// = trade_fee_cap_bps — same offset/width, see {@link decodePortfolioMatcherControl}.
// This is a separate trailing region after PortfolioAccountV16Account, not
// part of it (see v16_program.rs PORTFOLIO_MATCHER_CONFIG_OFF = HEADER_LEN +
// PORTFOLIO_STATE_LEN). Computed from the END of the account
// (V17_PORTFOLIO_ACCOUNT_LEN - 104 - identityTrailerLen) rather than chaining
// through HealthCert/locks/CloseProgress/ResolvedPayoutReceipt above — none
// of those intermediate regions are actually decoded by parsePortfolioV17.
//
// v18 NEW: a +24B identity trailer (TB-1a) now follows PortfolioMatcherConfigV16
// — portfolio_id:u64, matcher_sequence(expected_sequence):u64,
// matcher_expiry_slot:u64 — so the matcher-config region no longer ends at
// the account's true end; it's offset back by V17_PORTFOLIO_IDENTITY_TRAILER_LEN.
const PF_MATCHER_CONFIG_LEN    = 104;
const PF_MATCHER_PROGRAM_OFF   = V17_PORTFOLIO_ACCOUNT_LEN - PF_MATCHER_CONFIG_LEN - V17_PORTFOLIO_IDENTITY_TRAILER_LEN; // 9435
const PF_MATCHER_CONTEXT_OFF   = PF_MATCHER_PROGRAM_OFF + 32;                       // 9467
const PF_MATCHER_DELEGATE_OFF  = PF_MATCHER_CONTEXT_OFF + 32;                       // 9499
const PF_MATCHER_CONTROL_OFF   = PF_MATCHER_DELEGATE_OFF + 32;                      // 9531
/** @deprecated Renamed to {@link PF_MATCHER_CONTROL_OFF} — same offset, now bit-packed. */
const PF_MATCHER_ENABLED_OFF   = PF_MATCHER_CONTROL_OFF;
// v18 identity trailer (TB-1a), immediately after PortfolioMatcherConfigV16:
const PF_PORTFOLIO_ID_OFF      = PF_MATCHER_PROGRAM_OFF + PF_MATCHER_CONFIG_LEN;    // 9539
const PF_MATCHER_SEQUENCE_OFF  = PF_PORTFOLIO_ID_OFF + 8;                           // 9547
const PF_MATCHER_EXPIRY_OFF    = PF_MATCHER_SEQUENCE_OFF + 8;                       // 9555

/**
 * Decode `PortfolioMatcherConfigV16.control` (u64) into its three bit-packed
 * fields (TB-1a, ADOPT upstream b594bc21/6b627b43):
 *   bit 0        = enabled
 *   bits 1..49   = position_epoch (49 bits)
 *   bits 50..63  = trade_fee_cap_bps (14 bits, 0..=10000)
 *
 * A legacy pre-migration account only ever wrote 0 or 1 into this word (the
 * plain `enabled: u64` it used to be), which decodes correctly under this
 * scheme too — bit0 is unchanged, and the higher bits are naturally zero.
 *
 * @param control Raw u64 value of `PortfolioMatcherConfigV16.control`.
 */
export function decodePortfolioMatcherControl(control: bigint): {
  enabled: boolean;
  positionEpoch: bigint;
  tradeFeeCapBps: number;
} {
  const ENABLED_MASK = 1n;
  const POSITION_EPOCH_BITS = 49n;
  const POSITION_EPOCH_SHIFT = 1n;
  const POSITION_EPOCH_MASK = ((1n << POSITION_EPOCH_BITS) - 1n) << POSITION_EPOCH_SHIFT;
  const TRADE_FEE_CAP_SHIFT = 50n;
  const TRADE_FEE_CAP_MASK = 0x3fffn << TRADE_FEE_CAP_SHIFT;
  return {
    enabled: (control & ENABLED_MASK) === 1n,
    positionEpoch: (control & POSITION_EPOCH_MASK) >> POSITION_EPOCH_SHIFT,
    tradeFeeCapBps: Number((control & TRADE_FEE_CAP_MASK) >> TRADE_FEE_CAP_SHIFT),
  };
}

/** Per-leg decoded data returned by parsePortfolioV17. */
export interface PortfolioLegV17 {
  active: boolean;
  assetIndex: number;
  marketId: bigint;
  /** 0 = long, 1 = short */
  side: number;
  basisPosQ: bigint;
  aBasis: bigint;
  kSnap: bigint;
  fSnap: bigint;
  /**
   * NEW (engine-owned, not in the migration's own spec summary — see
   * {@link V17_PORTFOLIO_ACCOUNT_LEN}'s doc comment): funding accrual epoch
   * snapshot, inserted between `fSnap` and `epochSnap`.
   */
  kfEpochSnap: bigint;
  epochSnap: bigint;
  lossWeight: bigint;
  bSnap: bigint;
  bRem: bigint;
  bEpochSnap: bigint;
  bStale: boolean;
  stale: boolean;
  /** v2.2 only (wrapper VERSION 19): band certification epoch snapshot. */
  bandEpochSnap?: bigint;
  /** v2.2 only: the leg is queued for liquidation under the band. */
  bandLiqPending?: boolean;
  /** v2.2 only: holding-rent index snapshot. */
  rentSnap?: bigint;
  /** v2.2 only: rent remainder carried across settlements. */
  rentCarry?: bigint;
}

/** Per source-domain slot returned by parsePortfolioV17. */
export interface PortfolioSourceDomainV17 {
  domain: number;
  sourceClaimMarketId: bigint;
  sourceClaimBoundNum: bigint;
  sourceClaimLienedNum: bigint;
  sourceClaimCounterpartyLienedNum: bigint;
  sourceClaimInsuranceLienedNum: bigint;
  sourceLienEffectiveReserved: bigint;
  sourceLienCounterpartyBackingNum: bigint;
  sourceLienInsuranceBackingNum: bigint;
  sourceLienFeeLastSlot: bigint;
  sourceClaimImpairedNum: bigint;
  sourceLienImpairedEffectiveReserved: bigint;
  sourceLienCapitalAtRiskFeeRevenue: bigint;
  sourceLienImpairedCapitalAtRiskFeeRevenue: bigint;
}

/** Decoded v17 PortfolioAccountV16Account. */
export interface PortfolioV17 {
  /** Market group this portfolio belongs to. */
  marketGroupId: PublicKey;
  /** Portfolio account identity pubkey (immutable PDA). */
  portfolioAccountId: PublicKey;
  /** Owner wallet pubkey from the provenance header. */
  provenanceOwner: PublicKey;
  /** Portfolio owner (matches provenanceOwner for valid accounts). */
  owner: PublicKey;
  /** Collateral capital in atoms (u128). */
  capital: bigint;
  /** Unrealised P&L in atoms (i128). */
  pnl: bigint;
  /** Capital reserved for pending payout (u128). */
  reservedPnl: bigint;
  /** Genesis farming: cumulative crystallized loss atoms (u128). */
  residualCrystallizedLossAtomsTotal: bigint;
  /** Genesis farming: cumulative spent principal atoms (u128). */
  residualSpentPrincipalAtomsTotal: bigint;
  /** Genesis farming: cumulative received atoms (u128). */
  residualReceivedAtomsTotal: bigint;
  /**
   * NEW (engine-owned, not in the migration's own spec summary — see
   * {@link V17_PORTFOLIO_ACCOUNT_LEN}'s doc comment): cumulative funding
   * paid on long positions (u128).
   */
  fundingLongPaidAtomsTotal: bigint;
  /** NEW: cumulative funding received on long positions (u128). */
  fundingLongReceivedAtomsTotal: bigint;
  /** NEW: cumulative funding paid on short positions (u128). */
  fundingShortPaidAtomsTotal: bigint;
  /** NEW: cumulative funding received on short positions (u128). */
  fundingShortReceivedAtomsTotal: bigint;
  /** Fee credits (i128, can be negative). */
  feeCredits: bigint;
  /** Cancel-deposit escrow holding (u128). */
  cancelDepositEscrow: bigint;
  /** Slot when fees were last accrued. */
  lastFeeSlot: bigint;
  /** Bitmap of active leg slots (one u64 word for 16-asset portfolios). */
  activeBitmap: bigint;
  /** All 16 position leg slots (active or empty). */
  legs: PortfolioLegV17[];
  /** Up to 32 source-domain entries (sparse; unoccupied slots have domain=0 and all-zero fields). */
  sourceDomains: PortfolioSourceDomainV17[];
  /** External matcher program this portfolio routes trades through (PublicKey.default if unset). */
  matcherProgram: PublicKey;
  /** Matcher context account for matcherProgram (PublicKey.default if unset). */
  matcherContext: PublicKey;
  /** PDA the wrapper signs CPI calls to matcherProgram with (PublicKey.default if unset). */
  matcherDelegate: PublicKey;
  /** Whether the external matcher is enabled for this portfolio (SetMatcherConfig). Decoded from `control` bit 0. */
  matcherEnabled: boolean;
  /** v18 NEW: position-episode counter decoded from `control` bits 1..49 (TB-1a). */
  matcherPositionEpoch: bigint;
  /** v18 NEW: LP's maximum accepted market base fee in bps, decoded from `control` bits 50..63 (TB-1a). */
  matcherTradeFeeCapBps: number;
  /**
   * v18 NEW identity trailer (TB-1a, +24B after PortfolioMatcherConfigV16):
   * program-assigned, permanent, never-reused portfolio incarnation ID. Zero
   * on a not-yet-decoded/short buffer.
   */
  portfolioId: bigint;
  /**
   * v18 NEW: the portfolio's current matcher-sequence / replay-ordering
   * watermark (`expected_sequence` on the wire) — pass this LIVE value as
   * `expectedSequence` to every CAS-bound instruction that asks for it
   * (Deposit, Withdraw, ClosePortfolio, ConvertReleasedPnl,
   * CureAndCancelClose, ForfeitRecoveryLeg, RebalanceReduce,
   * SetMatcherConfig, and the trade tags).
   */
  matcherSequence: bigint;
  /** v18 NEW: slot at which the current matcher grant (SetMatcherConfig) stops being live; 0 = disabled/never granted. */
  matcherExpirySlot: bigint;
}

/**
 * Parse a v17 PortfolioAccountV16Account from raw account data.
 * Total account size: HEADER_LEN(16) + sizeof(PortfolioAccountV16Account).
 *
 * @param data - Raw account bytes from `connection.getAccountInfo`.
 * @returns Decoded portfolio state.
 * @throws If data is too short or magic does not match.
 *
 * @example
 * ```typescript
 * const info = await connection.getAccountInfo(portfolioPubkey);
 * const portfolio = parsePortfolioV17(new Uint8Array(info!.data));
 * console.log('capital:', portfolio.capital);
 * ```
 */
export function parsePortfolioV17(data: Uint8Array): PortfolioV17 {
  // Minimum size check: header(16) + provenance(100) + owner/capital/pnl/reserved_pnl.
  const MIN_PORTFOLIO_BYTES = PF_RESERVED_PNL_OFF + 16;
  if (data.length < MIN_PORTFOLIO_BYTES) {
    throw new Error(`parsePortfolioV17: data too short (${data.length} < ${MIN_PORTFOLIO_BYTES})`);
  }
  // VERSION + engine-discriminator guard (typed UnknownLayoutError); the leg stride and every offset after the
  // legs come from the table of the account's VERSION, never from its length.
  const L = resolvePortfolioLayout(data, { parser: "parsePortfolioV17" });
  const G = L.portfolio;

  // Provenance header
  const marketGroupId = new PublicKey(data.subarray(PF_PROVENANCE_MARKET_GROUP_OFF, PF_PROVENANCE_MARKET_GROUP_OFF + 32));
  const portfolioAccountId = new PublicKey(data.subarray(PF_PROVENANCE_ACCOUNT_ID_OFF, PF_PROVENANCE_ACCOUNT_ID_OFF + 32));
  const provenanceOwner = new PublicKey(data.subarray(PF_PROVENANCE_OWNER_OFF, PF_PROVENANCE_OWNER_OFF + 32));

  // Body fields
  const owner = new PublicKey(data.subarray(PF_OWNER_OFF, PF_OWNER_OFF + 32));
  const capital = readU128LE(data, PF_CAPITAL_OFF);
  const pnl = readI128LE(data, PF_PNL_OFF);
  const reservedPnl = readU128LE(data, PF_RESERVED_PNL_OFF);

  const residualCrystallizedLossAtomsTotal = data.length >= PF_RESIDUAL_LOSS_OFF + 16
    ? readU128LE(data, PF_RESIDUAL_LOSS_OFF) : 0n;
  const residualSpentPrincipalAtomsTotal = data.length >= PF_RESIDUAL_PRINCIPAL_OFF + 16
    ? readU128LE(data, PF_RESIDUAL_PRINCIPAL_OFF) : 0n;
  const residualReceivedAtomsTotal = data.length >= PF_RESIDUAL_RECEIVED_OFF + 16
    ? readU128LE(data, PF_RESIDUAL_RECEIVED_OFF) : 0n;
  const fundingLongPaidAtomsTotal = data.length >= PF_FUNDING_LONG_PAID_OFF + 16
    ? readU128LE(data, PF_FUNDING_LONG_PAID_OFF) : 0n;
  const fundingLongReceivedAtomsTotal = data.length >= PF_FUNDING_LONG_RECEIVED_OFF + 16
    ? readU128LE(data, PF_FUNDING_LONG_RECEIVED_OFF) : 0n;
  const fundingShortPaidAtomsTotal = data.length >= PF_FUNDING_SHORT_PAID_OFF + 16
    ? readU128LE(data, PF_FUNDING_SHORT_PAID_OFF) : 0n;
  const fundingShortReceivedAtomsTotal = data.length >= PF_FUNDING_SHORT_RECEIVED_OFF + 16
    ? readU128LE(data, PF_FUNDING_SHORT_RECEIVED_OFF) : 0n;
  const feeCredits = data.length >= PF_FEE_CREDITS_OFF + 16
    ? readI128LE(data, PF_FEE_CREDITS_OFF) : 0n;
  const cancelDepositEscrow = data.length >= PF_CANCEL_ESCROW_OFF + 16
    ? readU128LE(data, PF_CANCEL_ESCROW_OFF) : 0n;
  const lastFeeSlot = data.length >= PF_LAST_FEE_SLOT_OFF + 8
    ? readU64LE(data, PF_LAST_FEE_SLOT_OFF) : 0n;
  const activeBitmap = data.length >= PF_ACTIVE_BITMAP_OFF + 8
    ? readU64LE(data, PF_ACTIVE_BITMAP_OFF) : 0n;

  // Legs
  const legs: PortfolioLegV17[] = [];
  for (let i = 0; i < G.legCount; i++) {
    const b = G.legsOff + i * G.legStride;
    if (data.length < b + G.legStride) break;
    const o = G.leg;
    const leg: PortfolioLegV17 = {
      active: data[b + o.active] !== 0,
      assetIndex: readU32LE(data, b + o.assetIndex),
      marketId: readU64LE(data, b + o.marketId),
      side: data[b + o.side],
      basisPosQ: readI128LE(data, b + o.basisPosQ),
      aBasis: readU128LE(data, b + o.aBasis),
      kSnap: readI128LE(data, b + o.kSnap),
      fSnap: readI128LE(data, b + o.fSnap),
      kfEpochSnap: readU64LE(data, b + o.kfEpochSnap),
      epochSnap: readU64LE(data, b + o.epochSnap),
      lossWeight: readU128LE(data, b + o.lossWeight),
      bSnap: readU128LE(data, b + o.bSnap),
      bRem: readU128LE(data, b + o.bRem),
      bEpochSnap: readU64LE(data, b + o.bEpochSnap),
      bStale: data[b + o.bStale] !== 0,
      stale: data[b + o.stale] !== 0,
    };
    if (o.bandEpochSnap !== null && o.bandLiqPending !== null && o.rentSnap !== null && o.rentCarry !== null) {
      leg.bandEpochSnap = readU64LE(data, b + o.bandEpochSnap);
      leg.bandLiqPending = data[b + o.bandLiqPending] !== 0;
      leg.rentSnap = readU128LE(data, b + o.rentSnap);
      leg.rentCarry = readU64LE(data, b + o.rentCarry);
    }
    legs.push(leg);
  }

  // Source domains
  const sourceDomains: PortfolioSourceDomainV17[] = [];
  for (let i = 0; i < G.sourceDomainCap; i++) {
    const b = G.sourceDomainsOff + i * G.sourceDomainStride;
    if (data.length < b + G.sourceDomainStride) break;
    sourceDomains.push({
      domain: readU32LE(data, b + 0),
      sourceClaimMarketId: readU64LE(data, b + 4),
      sourceClaimBoundNum: readU128LE(data, b + 12),
      sourceClaimLienedNum: readU128LE(data, b + 28),
      sourceClaimCounterpartyLienedNum: readU128LE(data, b + 44),
      sourceClaimInsuranceLienedNum: readU128LE(data, b + 60),
      sourceLienEffectiveReserved: readU128LE(data, b + 76),
      sourceLienCounterpartyBackingNum: readU128LE(data, b + 92),
      sourceLienInsuranceBackingNum: readU128LE(data, b + 108),
      sourceLienFeeLastSlot: readU64LE(data, b + 124),
      sourceClaimImpairedNum: readU128LE(data, b + 132),
      sourceLienImpairedEffectiveReserved: readU128LE(data, b + 148),
      sourceLienCapitalAtRiskFeeRevenue: readU128LE(data, b + 164),
      sourceLienImpairedCapitalAtRiskFeeRevenue: readU128LE(data, b + 180),
    });
  }

  const PF_MATCHER_PROGRAM_OFF = G.matcherConfigOff;
  const PF_MATCHER_CONTEXT_OFF = PF_MATCHER_PROGRAM_OFF + 32;
  const PF_MATCHER_DELEGATE_OFF = PF_MATCHER_CONTEXT_OFF + 32;
  const PF_MATCHER_CONTROL_OFF = PF_MATCHER_DELEGATE_OFF + 32;
  const PF_PORTFOLIO_ID_OFF = PF_MATCHER_PROGRAM_OFF + PF_MATCHER_CONFIG_LEN;
  const PF_MATCHER_SEQUENCE_OFF = PF_PORTFOLIO_ID_OFF + 8;
  const PF_MATCHER_EXPIRY_OFF = PF_MATCHER_SEQUENCE_OFF + 8;
  const matcherProgram = data.length >= PF_MATCHER_PROGRAM_OFF + 32
    ? new PublicKey(data.subarray(PF_MATCHER_PROGRAM_OFF, PF_MATCHER_PROGRAM_OFF + 32))
    : PublicKey.default;
  const matcherContext = data.length >= PF_MATCHER_CONTEXT_OFF + 32
    ? new PublicKey(data.subarray(PF_MATCHER_CONTEXT_OFF, PF_MATCHER_CONTEXT_OFF + 32))
    : PublicKey.default;
  const matcherDelegate = data.length >= PF_MATCHER_DELEGATE_OFF + 32
    ? new PublicKey(data.subarray(PF_MATCHER_DELEGATE_OFF, PF_MATCHER_DELEGATE_OFF + 32))
    : PublicKey.default;
  // v18: the trailing u64 was RENAMED `enabled` -> `control` and is now
  // bit-packed (see {@link decodePortfolioMatcherControl}). A legacy
  // pre-migration account only ever wrote 0 or 1 here, which still decodes
  // correctly (bit0 unchanged, higher bits naturally zero) — so there is no
  // longer a ">1 is corrupt" invariant to enforce; any value is a legal
  // `control` word.
  let matcherEnabled = false;
  let matcherPositionEpoch = 0n;
  let matcherTradeFeeCapBps = 0;
  if (data.length >= PF_MATCHER_CONTROL_OFF + 8) {
    const control = readU64LE(data, PF_MATCHER_CONTROL_OFF);
    const decoded = decodePortfolioMatcherControl(control);
    matcherEnabled = decoded.enabled;
    matcherPositionEpoch = decoded.positionEpoch;
    matcherTradeFeeCapBps = decoded.tradeFeeCapBps;
  }

  // v18 NEW identity trailer (TB-1a), immediately after PortfolioMatcherConfigV16.
  const portfolioId = data.length >= PF_PORTFOLIO_ID_OFF + 8
    ? readU64LE(data, PF_PORTFOLIO_ID_OFF) : 0n;
  const matcherSequence = data.length >= PF_MATCHER_SEQUENCE_OFF + 8
    ? readU64LE(data, PF_MATCHER_SEQUENCE_OFF) : 0n;
  const matcherExpirySlot = data.length >= PF_MATCHER_EXPIRY_OFF + 8
    ? readU64LE(data, PF_MATCHER_EXPIRY_OFF) : 0n;

  return {
    marketGroupId,
    portfolioAccountId,
    provenanceOwner,
    owner,
    capital,
    pnl,
    reservedPnl,
    residualCrystallizedLossAtomsTotal,
    residualSpentPrincipalAtomsTotal,
    residualReceivedAtomsTotal,
    fundingLongPaidAtomsTotal,
    fundingLongReceivedAtomsTotal,
    fundingShortPaidAtomsTotal,
    fundingShortReceivedAtomsTotal,
    feeCredits,
    cancelDepositEscrow,
    lastFeeSlot,
    activeBitmap,
    legs,
    sourceDomains,
    matcherProgram,
    matcherContext,
    matcherDelegate,
    matcherEnabled,
    matcherPositionEpoch,
    matcherTradeFeeCapBps,
    portfolioId,
    matcherSequence,
    matcherExpirySlot,
  };
}

// =============================================================================
// LpVaultRegistryV16 decoder
// =============================================================================
// Account layout: HEADER_LEN(16) + LpVaultRegistryV16(160) = 176 bytes total.
// Struct layout (probe-confirmed in ~/v17/percolator-prog/src/v16_program.rs:2927):
//   market_group[32]+lp_mint[32]+total_lp_shares_outstanding(u128)+insurance_fee_snapshot(u128)+
//   fee_distribution_total(u128)+epoch(u64)+redemption_cooldown_slots(u64)+fee_share_bps(u16)+
//   oi_reservation_threshold_bps(u16)+domain(u16)+paused(u8)+version(u8)+bump(u8)+mint_bump(u8)+
//   _padding[6]+_reserved[16] = 160 bytes.
const LP_VAULT_REGISTRY_TOTAL = 176; // HEADER_LEN(16) + sizeof(LpVaultRegistryV16)(160)

/** Decoded v17 LpVaultRegistryV16 account. */
export interface LpVaultRegistryV17 {
  marketGroup: PublicKey;
  lpMint: PublicKey;
  totalLpSharesOutstanding: bigint;
  insuranceFeeSnapshotAtoms: bigint;
  feeDistributionTotalAtoms: bigint;
  epoch: bigint;
  redemptionCooldownSlots: bigint;
  feeShareBps: number;
  oiReservationThresholdBps: number;
  domain: number;
  paused: boolean;
  version: number;
  bump: number;
  mintBump: number;
}

/**
 * Parse a v17 LpVaultRegistryV16 account from raw bytes.
 * Total account size: 176 bytes (HEADER_LEN=16 + struct=160).
 *
 * @param data - Raw account bytes.
 * @returns Decoded LP vault registry state.
 * @throws If data is shorter than 176 bytes.
 *
 * @example
 * ```typescript
 * const info = await connection.getAccountInfo(registryPubkey);
 * const registry = parseLpVaultRegistry(new Uint8Array(info!.data));
 * console.log('totalShares:', registry.totalLpSharesOutstanding);
 * ```
 */
export function parseLpVaultRegistry(data: Uint8Array): LpVaultRegistryV17 {
  if (data.length < LP_VAULT_REGISTRY_TOTAL) {
    throw new Error(
      `parseLpVaultRegistry: data too short (${data.length} < ${LP_VAULT_REGISTRY_TOTAL})`
    );
  }
  assertV17StandaloneHeader(data, "parseLpVaultRegistry", V17_KIND_LP_VAULT_REGISTRY);
  const b = V17_ACCOUNT_HEADER_LEN; // skip 16-byte header
  return {
    marketGroup: new PublicKey(data.subarray(b + 0, b + 32)),
    lpMint: new PublicKey(data.subarray(b + 32, b + 64)),
    totalLpSharesOutstanding: readU128LE(data, b + 64),
    insuranceFeeSnapshotAtoms: readU128LE(data, b + 80),
    feeDistributionTotalAtoms: readU128LE(data, b + 96),
    epoch: readU64LE(data, b + 112),
    redemptionCooldownSlots: readU64LE(data, b + 120),
    feeShareBps: readU16LE(data, b + 128),
    oiReservationThresholdBps: readU16LE(data, b + 130),
    domain: readU16LE(data, b + 132),
    paused: data[b + 134] !== 0,
    version: data[b + 135],
    bump: data[b + 136],
    mintBump: data[b + 137],
  };
}

// =============================================================================
// LpRedemptionV16 decoder
// =============================================================================
// Account layout: HEADER_LEN(16) + LpRedemptionV16(96) = 112 bytes total.
// Struct layout (probe-confirmed in ~/v17/percolator-prog/src/v16_program.rs:3023):
//   registry[32]+redeemer[32]+shares(u128)+request_slot(u64)+version(u8)+bump(u8)+_padding[6] = 96.
const LP_REDEMPTION_TOTAL = 112; // HEADER_LEN(16) + sizeof(LpRedemptionV16)(96)

/** Decoded v17 LpRedemptionV16 account. */
export interface LpRedemptionV17 {
  registry: PublicKey;
  redeemer: PublicKey;
  /** LP shares requested for redemption (u128). */
  shares: bigint;
  /** Slot when RequestRedeemLpShares was called. */
  requestSlot: bigint;
  version: number;
  bump: number;
}

/**
 * Parse a v17 LpRedemptionV16 account from raw bytes.
 * Total account size: 112 bytes (HEADER_LEN=16 + struct=96).
 *
 * @param data - Raw account bytes.
 * @returns Decoded LP redemption request state.
 * @throws If data is shorter than 112 bytes.
 *
 * @example
 * ```typescript
 * const info = await connection.getAccountInfo(redemptionPubkey);
 * const redemption = parseLpRedemption(new Uint8Array(info!.data));
 * console.log('shares:', redemption.shares, 'slot:', redemption.requestSlot);
 * ```
 */
export function parseLpRedemption(data: Uint8Array): LpRedemptionV17 {
  if (data.length < LP_REDEMPTION_TOTAL) {
    throw new Error(
      `parseLpRedemption: data too short (${data.length} < ${LP_REDEMPTION_TOTAL})`
    );
  }
  assertV17StandaloneHeader(data, "parseLpRedemption", V17_KIND_LP_REDEMPTION);
  const b = V17_ACCOUNT_HEADER_LEN; // skip 16-byte header
  return {
    registry: new PublicKey(data.subarray(b + 0, b + 32)),
    redeemer: new PublicKey(data.subarray(b + 32, b + 64)),
    shares: readU128LE(data, b + 64),
    requestSlot: readU64LE(data, b + 80),
    version: data[b + 88],
    bump: data[b + 89],
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
