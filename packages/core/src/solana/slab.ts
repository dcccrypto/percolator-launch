import { Connection, PublicKey } from "@solana/web3.js";

// =============================================================================
// Browser-compatible read helpers using DataView
// (the npm 'buffer' polyfill lacks readBigUInt64LE / readBigInt64LE)
// =============================================================================
function dv(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}
function readU8(data: Uint8Array, off: number): number {
  return data[off];
}
function readU16LE(data: Uint8Array, off: number): number {
  return dv(data).getUint16(off, true);
}
function readU32LE(data: Uint8Array, off: number): number {
  return dv(data).getUint32(off, true);
}
function readU64LE(data: Uint8Array, off: number): bigint {
  return dv(data).getBigUint64(off, true);
}
function readI64LE(data: Uint8Array, off: number): bigint {
  return dv(data).getBigInt64(off, true);
}

// Constants from Rust (updated for funding/threshold params 2026-01)
const MAGIC: bigint = 0x504552434f4c4154n; // "PERCOLAT"
const HEADER_LEN = 72;    // SlabHeader: magic(8) + version(4) + bump(1) + _padding(3) + admin(32) + _reserved(24)
const CONFIG_OFFSET = HEADER_LEN;  // MarketConfig starts right after header
// MarketConfig: collateral_mint(32) + vault_pubkey(32) + index_feed_id(32) + max_staleness_secs(8) +
//               conf_filter_bps(2) + bump(1) + invert(1) + unit_scale(4) +
//               funding_horizon_slots(8) + funding_k_bps(8) + funding_inv_scale_notional_e6(16) +
//               funding_max_premium_bps(8) + funding_max_bps_per_slot(8) +
//               thresh_floor(16) + thresh_risk_bps(8) + thresh_update_interval_slots(8) +
//               thresh_step_bps(8) + thresh_alpha_bps(8) + thresh_min(16) + thresh_max(16) + thresh_min_step(16) +
//               oracle_authority(32) + authority_price_e6(8) + authority_timestamp(8) +
//               oracle_price_cap_e2bps(8) + last_effective_price_e6(8)
const CONFIG_LEN = 320;
const RESERVED_OFF = 48;  // Offset of _reserved field within SlabHeader

// Flag bits in header._padding[0] at offset 13
const FLAG_RESOLVED = 1 << 0;

/**
 * Slab header (72 bytes)
 */
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

/**
 * Market config (starts at offset 72)
 * Layout: collateral_mint(32) + vault_pubkey(32) + index_feed_id(32)
 *         + max_staleness_secs(8) + conf_filter_bps(2) + vault_authority_bump(1) + invert(1) + unit_scale(4)
 */
export interface MarketConfig {
  collateralMint: PublicKey;
  vaultPubkey: PublicKey;
  indexFeedId: PublicKey;       // index_feed_id (Pyth feed ID stored as 32 bytes)
  maxStalenessSlots: bigint;    // max_staleness_secs
  confFilterBps: number;
  vaultAuthorityBump: number;
  invert: number;               // 0 = no inversion, 1 = invert oracle price
  unitScale: number;            // Lamports per unit (0 = no scaling)
  // Funding rate parameters
  fundingHorizonSlots: bigint;
  fundingKBps: bigint;
  fundingInvScaleNotionalE6: bigint;
  fundingMaxPremiumBps: bigint;
  fundingMaxBpsPerSlot: bigint;
  // Threshold parameters
  threshFloor: bigint;
  threshRiskBps: bigint;
  threshUpdateIntervalSlots: bigint;
  threshStepBps: bigint;
  threshAlphaBps: bigint;
  threshMin: bigint;
  threshMax: bigint;
  threshMinStep: bigint;
  // Oracle authority
  oracleAuthority: PublicKey;
  authorityPriceE6: bigint;
  authorityTimestamp: bigint;
  // Oracle price circuit breaker
  oraclePriceCapE2bps: bigint;
  lastEffectivePriceE6: bigint;
}

/**
 * Fetch raw slab account data.
 */
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

/**
 * Parse slab header (first 64 bytes).
 */
export function parseHeader(data: Uint8Array): SlabHeader {
  if (data.length < HEADER_LEN) {
    throw new Error(`Slab data too short for header: ${data.length} < ${HEADER_LEN}`);
  }

  const magic = readU64LE(data, 0);
  if (magic !== MAGIC) {
    throw new Error(`Invalid slab magic: expected ${MAGIC.toString(16)}, got ${magic.toString(16)}`);
  }

  const version = readU32LE(data, 8);
  const bump = readU8(data, 12);
  const flags = readU8(data, 13);  // _padding[0] contains flags
  const admin = new PublicKey(data.subarray(16, 48));

  // Reserved field: nonce at [0..8], lastThrUpdateSlot at [8..16]
  const nonce = readU64LE(data, RESERVED_OFF);
  const lastThrUpdateSlot = readU64LE(data, RESERVED_OFF + 8);

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
 * Parse market config (starts at byte 72).
 * Layout: collateral_mint(32) + vault_pubkey(32) + index_feed_id(32)
 *         + max_staleness_secs(8) + conf_filter_bps(2) + vault_authority_bump(1) + invert(1) + unit_scale(4)
 */
export function parseConfig(data: Uint8Array): MarketConfig {
  const minLen = CONFIG_OFFSET + CONFIG_LEN;
  if (data.length < minLen) {
    throw new Error(`Slab data too short for config: ${data.length} < ${minLen}`);
  }

  let off = CONFIG_OFFSET;

  const collateralMint = new PublicKey(data.subarray(off, off + 32));
  off += 32;

  const vaultPubkey = new PublicKey(data.subarray(off, off + 32));
  off += 32;

  // index_feed_id (32 bytes) - Pyth feed ID, stored as 32 bytes
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

  const fundingInvScaleNotionalE6 = readU128LE(data, off); // Rust: u128
  off += 16;

  const fundingMaxPremiumBps = readI64LE(data, off); // Rust: i64
  off += 8;

  const fundingMaxBpsPerSlot = readI64LE(data, off); // Rust: i64
  off += 8;

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
  };
}

/**
 * Read nonce from slab header reserved field.
 */
export function readNonce(data: Uint8Array): bigint {
  if (data.length < RESERVED_OFF + 8) {
    throw new Error("Slab data too short for nonce");
  }
  return readU64LE(data, RESERVED_OFF);
}

/**
 * Read last threshold update slot from slab header reserved field.
 */
export function readLastThrUpdateSlot(data: Uint8Array): bigint {
  if (data.length < RESERVED_OFF + 16) {
    throw new Error("Slab data too short for lastThrUpdateSlot");
  }
  return readU64LE(data, RESERVED_OFF + 8);
}

// =============================================================================
// RiskEngine Layout Constants (updated for haircut-ratio refactor 2026-02)
// ENGINE_OFF = HEADER_LEN + CONFIG_LEN = 72 + 320 = 392
//
// The ADL/socialization system was replaced with O(1) haircut ratio.
// Removed: loss_accum, risk_reduction_only, warmup_paused, warmed totals,
//          adl_*_scratch arrays, pending_* deferred socialization fields.
// Added: c_tot, pnl_pos_tot (O(1) aggregates for haircut calculation).
// =============================================================================
const ENGINE_OFF = 392;
// RiskEngine struct layout (repr(C), SBF uses 8-byte alignment for u128):
// - vault: u128 (16 bytes) at offset 0
// - insurance_fund: InsuranceFund { balance: u128, fee_revenue: u128 } (32 bytes) at offset 16
// - params: RiskParams (144 bytes) at offset 48
const ENGINE_VAULT_OFF = 0;
const ENGINE_INSURANCE_OFF = 16;
const ENGINE_PARAMS_OFF = 48;         // RiskParams starts here (after vault+insurance_fund)
// After RiskParams (at engine offset 48 + 144 = 192):
const ENGINE_CURRENT_SLOT_OFF = 192;
const ENGINE_FUNDING_INDEX_OFF = 200;   // I128 (16 bytes)
const ENGINE_LAST_FUNDING_SLOT_OFF = 216;
const ENGINE_FUNDING_RATE_BPS_OFF = 224;// i64: funding_rate_bps_per_slot_last (8 bytes) - was missing!
const ENGINE_LAST_CRANK_SLOT_OFF = 232;
const ENGINE_MAX_CRANK_STALENESS_OFF = 240;
const ENGINE_TOTAL_OI_OFF = 248;        // U128 (16 bytes)
const ENGINE_C_TOT_OFF = 264;           // U128: sum of all account capital
const ENGINE_PNL_POS_TOT_OFF = 280;     // U128: sum of all positive PnL
const ENGINE_LIQ_CURSOR_OFF = 296;      // u16
const ENGINE_GC_CURSOR_OFF = 298;       // u16
// 4 bytes padding for u64 alignment
const ENGINE_LAST_SWEEP_START_OFF = 304;
const ENGINE_LAST_SWEEP_COMPLETE_OFF = 312;
const ENGINE_CRANK_CURSOR_OFF = 320;    // u16
const ENGINE_SWEEP_START_IDX_OFF = 322; // u16
// 4 bytes padding for u64 alignment
const ENGINE_LIFETIME_LIQUIDATIONS_OFF = 328;
const ENGINE_LIFETIME_FORCE_CLOSES_OFF = 336;
// LP Aggregates for funding rate calculation
const ENGINE_NET_LP_POS_OFF = 344;      // I128
const ENGINE_LP_SUM_ABS_OFF = 360;      // U128
const ENGINE_LP_MAX_ABS_OFF = 376;      // U128
const ENGINE_LP_MAX_ABS_SWEEP_OFF = 392;// U128
// Bitmap: 64 u64 words = 512 bytes
const ENGINE_BITMAP_OFF = 408;
// After bitmap (408 + 512 = 920):
const ENGINE_NUM_USED_OFF_LARGE = 920;  // u16 — for 4096-slot variant only
// 6 bytes padding for u64 alignment
const ENGINE_NEXT_ACCOUNT_ID_OFF = 928; // u64
const ENGINE_FREE_HEAD_OFF = 936;       // u16
// _padding_accounts: [u8; 6] at 938-943 for next_free alignment
// next_free: [u16; 4096] at 944-9135
// Dynamic layout helpers — bitmap/accounts offsets depend on maxAccounts
const DEFAULT_MAX_ACCOUNTS = 4096;
const DEFAULT_BITMAP_WORDS = 64;  // ceil(4096/64)
const ACCOUNT_SIZE = 240;  // Account._padding removed (was 248)

// For backward compat, keep large default
const ENGINE_ACCOUNTS_OFF = 9136;       // accounts offset for 4096 variant

/**
 * Compute bitmap words and accounts offset for a given maxAccounts.
 * Layout: engine_fixed(408) + bitmap(words*8) + post_bitmap(24) + next_free(N*2) + padding + accounts(N*240)
 */
function slabLayout(maxAccounts: number) {
  const bitmapWords = Math.ceil(maxAccounts / 64);
  const bitmapBytes = bitmapWords * 8;
  const postBitmap = 24; // num_used(u16,2) + pad(6) + next_account_id(u64,8) + free_head(u16,2) + pad(6)
  const nextFreeBytes = maxAccounts * 2;
  // Align to 16 bytes for Account (u128 fields)
  const preAccountsLen = 408 + bitmapBytes + postBitmap + nextFreeBytes;
  const accountsOff = Math.ceil(preAccountsLen / 16) * 16;
  return { bitmapWords, accountsOff, maxAccounts };
}

// Detect maxAccounts from slab data length
export function detectLayout(dataLen: number) {
  // Try each known tier with aligned offsets
  for (const n of [64, 256, 1024, 4096]) {
    const layout = slabLayout(n);
    const expectedLen = ENGINE_OFF + layout.accountsOff + n * ACCOUNT_SIZE;
    if (dataLen === expectedLen) return layout;
  }
  // Try unaligned variant (some program builds don't pad accountsOff to 16)
  for (const n of [64, 256, 1024, 4096]) {
    const bitmapWords = Math.ceil(n / 64);
    const bitmapBytes = bitmapWords * 8;
    const postBitmap = 24;
    const nextFreeBytes = n * 2;
    const accountsOff = 408 + bitmapBytes + postBitmap + nextFreeBytes; // no alignment
    const expectedLen = ENGINE_OFF + accountsOff + n * ACCOUNT_SIZE;
    if (dataLen === expectedLen) return { bitmapWords, accountsOff, maxAccounts: n };
  }
  // Fallback: compute from params (will read maxAccounts from data)
  return null;
}

// =============================================================================
// RiskParams Layout (144 bytes, repr(C) with 8-byte alignment on SBF)
// Note: SBF target uses 8-byte alignment for u128, not 16-byte
// Verified via verify-layout.cjs against devnet 2024-01
// =============================================================================
const PARAMS_WARMUP_PERIOD_OFF = 0;        // u64
const PARAMS_MAINTENANCE_MARGIN_OFF = 8;   // u64
const PARAMS_INITIAL_MARGIN_OFF = 16;      // u64
const PARAMS_TRADING_FEE_OFF = 24;         // u64
const PARAMS_MAX_ACCOUNTS_OFF = 32;        // u64
const PARAMS_NEW_ACCOUNT_FEE_OFF = 40;     // u128 (no padding, 8-byte aligned)
const PARAMS_RISK_THRESHOLD_OFF = 56;      // u128
const PARAMS_MAINTENANCE_FEE_OFF = 72;     // u128
const PARAMS_MAX_CRANK_STALENESS_OFF = 88; // u64
const PARAMS_LIQUIDATION_FEE_BPS_OFF = 96; // u64
const PARAMS_LIQUIDATION_FEE_CAP_OFF = 104;// u128
const PARAMS_LIQUIDATION_BUFFER_OFF = 120; // u64
const PARAMS_MIN_LIQUIDATION_OFF = 128;    // u128 (total = 144 bytes)

// =============================================================================
// Account Layout (248 bytes, repr(C))
// NOTE: Despite U128/I128 wrapper types in Rust, on-chain layout remains unchanged
// Field order: account_id, capital, kind, pnl, reserved_pnl, warmup_started,
//              warmup_slope, position_size, entry_price, funding_index,
//              matcher_program, matcher_context, owner, fee_credits, last_fee_slot
// =============================================================================
const ACCT_ACCOUNT_ID_OFF = 0;        // accountId (u64, 8 bytes), ends at 8
const ACCT_CAPITAL_OFF = 8;           // capital (U128, 16 bytes), ends at 24
const ACCT_KIND_OFF = 24;             // kind (u8, 1 byte + 7 padding), ends at 32
const ACCT_PNL_OFF = 32;              // pnl (I128, 16 bytes), ends at 48
const ACCT_RESERVED_PNL_OFF = 48;     // reserved_pnl (u64, 8 bytes), ends at 56
const ACCT_WARMUP_STARTED_OFF = 56;   // warmup_started (u64, 8 bytes), ends at 64
const ACCT_WARMUP_SLOPE_OFF = 64;     // warmup_slope (U128, 16 bytes), ends at 80
const ACCT_POSITION_SIZE_OFF = 80;    // position_size (I128, 16 bytes), ends at 96
const ACCT_ENTRY_PRICE_OFF = 96;      // entry_price (u64, 8 bytes), ends at 104
const ACCT_FUNDING_INDEX_OFF = 104;   // funding_index (I128, 16 bytes), ends at 120
const ACCT_MATCHER_PROGRAM_OFF = 120; // matcher_program (Pubkey, 32 bytes), ends at 152
const ACCT_MATCHER_CONTEXT_OFF = 152; // matcher_context (Pubkey, 32 bytes), ends at 184
const ACCT_OWNER_OFF = 184;           // owner (Pubkey, 32 bytes), ends at 216
const ACCT_FEE_CREDITS_OFF = 216;     // fee_credits (I128, 16 bytes), ends at 232
const ACCT_LAST_FEE_SLOT_OFF = 232;   // last_fee_slot (u64, 8 bytes), ends at 240

// =============================================================================
// Interfaces
// =============================================================================

export interface InsuranceFund {
  balance: bigint;
  feeRevenue: bigint;
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
  fundingRateBpsPerSlotLast: bigint;  // Added: was missing from layout
  lastCrankSlot: bigint;
  maxCrankStalenessSlots: bigint;
  totalOpenInterest: bigint;
  cTot: bigint;              // Sum of all account capital (O(1) aggregate)
  pnlPosTot: bigint;         // Sum of all positive PnL (O(1) aggregate)
  liqCursor: number;
  gcCursor: number;
  lastSweepStartSlot: bigint;
  lastSweepCompleteSlot: bigint;
  crankCursor: number;
  sweepStartIdx: number;
  lifetimeLiquidations: bigint;
  lifetimeForceCloses: bigint;
  // LP Aggregates for funding
  netLpPos: bigint;          // Net LP position (sum of all LP positions)
  lpSumAbs: bigint;          // Sum of abs(LP positions)
  lpMaxAbs: bigint;          // Max abs(LP position) monotone upper bound
  lpMaxAbsSweep: bigint;     // In-progress max abs for current sweep
  numUsedAccounts: number;
  nextAccountId: bigint;
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
  matcherContext: PublicKey;  // Pubkey (32 bytes)
  owner: PublicKey;
  feeCredits: bigint;
  lastFeeSlot: bigint;
}

// =============================================================================
// Helper: read signed i128 from buffer
// Match Rust's I128 wrapper: read both halves as unsigned, then interpret as signed
// =============================================================================
function readI128LE(buf: Uint8Array, offset: number): bigint {
  const lo = readU64LE(buf, offset);
  const hi = readU64LE(buf, offset + 8);
  const unsigned = (hi << 64n) | lo;
  // If high bit is set, convert to negative (two's complement)
  const SIGN_BIT = 1n << 127n;
  if (unsigned >= SIGN_BIT) {
    return unsigned - (1n << 128n);
  }
  return unsigned;
}

function readU128LE(buf: Uint8Array, offset: number): bigint {
  const lo = readU64LE(buf, offset);
  const hi = readU64LE(buf, offset + 8);
  return (hi << 64n) | lo;
}

// =============================================================================
// Parsing Functions
// =============================================================================

/**
 * Parse RiskParams from engine data.
 * Note: invert/unitScale are in MarketConfig, not RiskParams.
 */
export function parseParams(data: Uint8Array): RiskParams {
  const base = ENGINE_OFF + ENGINE_PARAMS_OFF;
  if (data.length < base + 144) {  // RiskParams is 144 bytes (5×u64 + 4×u128 + 3×u64 + 1×u128)
    throw new Error("Slab data too short for RiskParams");
  }

  return {
    warmupPeriodSlots: readU64LE(data, base + PARAMS_WARMUP_PERIOD_OFF),
    maintenanceMarginBps: readU64LE(data, base + PARAMS_MAINTENANCE_MARGIN_OFF),
    initialMarginBps: readU64LE(data, base + PARAMS_INITIAL_MARGIN_OFF),
    tradingFeeBps: readU64LE(data, base + PARAMS_TRADING_FEE_OFF),
    maxAccounts: readU64LE(data, base + PARAMS_MAX_ACCOUNTS_OFF),
    newAccountFee: readU128LE(data, base + PARAMS_NEW_ACCOUNT_FEE_OFF),
    riskReductionThreshold: readU128LE(data, base + PARAMS_RISK_THRESHOLD_OFF),
    maintenanceFeePerSlot: readU128LE(data, base + PARAMS_MAINTENANCE_FEE_OFF),
    maxCrankStalenessSlots: readU64LE(data, base + PARAMS_MAX_CRANK_STALENESS_OFF),
    liquidationFeeBps: readU64LE(data, base + PARAMS_LIQUIDATION_FEE_BPS_OFF),
    liquidationFeeCap: readU128LE(data, base + PARAMS_LIQUIDATION_FEE_CAP_OFF),
    liquidationBufferBps: readU64LE(data, base + PARAMS_LIQUIDATION_BUFFER_OFF),
    minLiquidationAbs: readU128LE(data, base + PARAMS_MIN_LIQUIDATION_OFF),
  };
}

/**
 * Parse RiskEngine state (excluding accounts array).
 */
export function parseEngine(data: Uint8Array): EngineState {
  const base = ENGINE_OFF;
  const layout = detectLayout(data.length);
  const minLen = layout ? layout.accountsOff : ENGINE_ACCOUNTS_OFF;
  if (data.length < base + minLen) {
    throw new Error("Slab data too short for RiskEngine");
  }

  return {
    vault: readU128LE(data, base + ENGINE_VAULT_OFF),
    insuranceFund: {
      balance: readU128LE(data, base + ENGINE_INSURANCE_OFF),
      feeRevenue: readU128LE(data, base + ENGINE_INSURANCE_OFF + 16),
    },
    currentSlot: readU64LE(data, base + ENGINE_CURRENT_SLOT_OFF),
    fundingIndexQpbE6: readI128LE(data, base + ENGINE_FUNDING_INDEX_OFF),
    lastFundingSlot: readU64LE(data, base + ENGINE_LAST_FUNDING_SLOT_OFF),
    fundingRateBpsPerSlotLast: readI64LE(data, base + ENGINE_FUNDING_RATE_BPS_OFF),
    lastCrankSlot: readU64LE(data, base + ENGINE_LAST_CRANK_SLOT_OFF),
    maxCrankStalenessSlots: readU64LE(data, base + ENGINE_MAX_CRANK_STALENESS_OFF),
    totalOpenInterest: readU128LE(data, base + ENGINE_TOTAL_OI_OFF),
    cTot: readU128LE(data, base + ENGINE_C_TOT_OFF),
    pnlPosTot: readU128LE(data, base + ENGINE_PNL_POS_TOT_OFF),
    liqCursor: readU16LE(data, base + ENGINE_LIQ_CURSOR_OFF),
    gcCursor: readU16LE(data, base + ENGINE_GC_CURSOR_OFF),
    lastSweepStartSlot: readU64LE(data, base + ENGINE_LAST_SWEEP_START_OFF),
    lastSweepCompleteSlot: readU64LE(data, base + ENGINE_LAST_SWEEP_COMPLETE_OFF),
    crankCursor: readU16LE(data, base + ENGINE_CRANK_CURSOR_OFF),
    sweepStartIdx: readU16LE(data, base + ENGINE_SWEEP_START_IDX_OFF),
    lifetimeLiquidations: readU64LE(data, base + ENGINE_LIFETIME_LIQUIDATIONS_OFF),
    lifetimeForceCloses: readU64LE(data, base + ENGINE_LIFETIME_FORCE_CLOSES_OFF),
    // LP Aggregates for funding rate calculation
    netLpPos: readI128LE(data, base + ENGINE_NET_LP_POS_OFF),
    lpSumAbs: readU128LE(data, base + ENGINE_LP_SUM_ABS_OFF),
    lpMaxAbs: readU128LE(data, base + ENGINE_LP_MAX_ABS_OFF),
    lpMaxAbsSweep: readU128LE(data, base + ENGINE_LP_MAX_ABS_SWEEP_OFF),
    numUsedAccounts: (() => {
      const bw = layout ? layout.bitmapWords : DEFAULT_BITMAP_WORDS;
      return readU16LE(data, base + ENGINE_BITMAP_OFF + bw * 8);
    })(),
    nextAccountId: (() => {
      const bw = layout ? layout.bitmapWords : DEFAULT_BITMAP_WORDS;
      const numUsedOff = ENGINE_BITMAP_OFF + bw * 8;
      // next_account_id is u64 (8-byte aligned) after num_used(u16)
      return readU64LE(data, base + Math.ceil((numUsedOff + 2) / 8) * 8);
    })(),
  };
}

/**
 * Read bitmap to get list of used account indices.
 */
export function parseUsedIndices(data: Uint8Array): number[] {
  const layout = detectLayout(data.length);
  const bitmapWords = layout ? layout.bitmapWords : DEFAULT_BITMAP_WORDS;
  const base = ENGINE_OFF + ENGINE_BITMAP_OFF;
  if (data.length < base + bitmapWords * 8) {
    throw new Error("Slab data too short for bitmap");
  }

  const used: number[] = [];
  for (let word = 0; word < bitmapWords; word++) {
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
  const layout = detectLayout(data.length);
  const maxAcc = layout ? layout.maxAccounts : DEFAULT_MAX_ACCOUNTS;
  if (idx < 0 || idx >= maxAcc) return false;
  const base = ENGINE_OFF + ENGINE_BITMAP_OFF;
  const word = Math.floor(idx / 64);
  const bit = idx % 64;
  const bits = readU64LE(data, base + word * 8);
  return ((bits >> BigInt(bit)) & 1n) !== 0n;
}

/**
 * Calculate the maximum valid account index for a given slab size.
 */
export function maxAccountIndex(dataLen: number): number {
  const layout = detectLayout(dataLen);
  const accOff = layout ? layout.accountsOff : ENGINE_ACCOUNTS_OFF;
  const accountsEnd = dataLen - ENGINE_OFF - accOff;
  if (accountsEnd <= 0) return 0;
  return Math.floor(accountsEnd / ACCOUNT_SIZE);
}

/**
 * Parse a single account by index.
 */
export function parseAccount(data: Uint8Array, idx: number): Account {
  const maxIdx = maxAccountIndex(data.length);
  if (idx < 0 || idx >= maxIdx) {
    throw new Error(`Account index out of range: ${idx} (max: ${maxIdx - 1})`);
  }

  const layout = detectLayout(data.length);
  const accOff = layout ? layout.accountsOff : ENGINE_ACCOUNTS_OFF;
  const base = ENGINE_OFF + accOff + idx * ACCOUNT_SIZE;
  if (data.length < base + ACCOUNT_SIZE) {
    throw new Error("Slab data too short for account");
  }

  // Read the kind field directly from offset 24 (u8 with 7 bytes padding)
  const kindByte = readU8(data, base + ACCT_KIND_OFF);
  const kind = kindByte === 1 ? AccountKind.LP : AccountKind.User;

  return {
    kind,
    accountId: readU64LE(data, base + ACCT_ACCOUNT_ID_OFF),
    capital: readU128LE(data, base + ACCT_CAPITAL_OFF),
    pnl: readI128LE(data, base + ACCT_PNL_OFF),
    reservedPnl: readU64LE(data, base + ACCT_RESERVED_PNL_OFF),
    warmupStartedAtSlot: readU64LE(data, base + ACCT_WARMUP_STARTED_OFF),
    warmupSlopePerStep: readU128LE(data, base + ACCT_WARMUP_SLOPE_OFF),
    positionSize: readI128LE(data, base + ACCT_POSITION_SIZE_OFF),
    entryPrice: readU64LE(data, base + ACCT_ENTRY_PRICE_OFF),
    fundingIndex: readI128LE(data, base + ACCT_FUNDING_INDEX_OFF),
    matcherProgram: new PublicKey(data.subarray(base + ACCT_MATCHER_PROGRAM_OFF, base + ACCT_MATCHER_PROGRAM_OFF + 32)),
    matcherContext: new PublicKey(data.subarray(base + ACCT_MATCHER_CONTEXT_OFF, base + ACCT_MATCHER_CONTEXT_OFF + 32)),
    owner: new PublicKey(data.subarray(base + ACCT_OWNER_OFF, base + ACCT_OWNER_OFF + 32)),
    feeCredits: readI128LE(data, base + ACCT_FEE_CREDITS_OFF),
    lastFeeSlot: readU64LE(data, base + ACCT_LAST_FEE_SLOT_OFF),
  };
}

/**
 * Parse all used accounts.
 * Filters out indices that would be beyond the slab's account storage capacity.
 */
export function parseAllAccounts(data: Uint8Array): { idx: number; account: Account }[] {
  const indices = parseUsedIndices(data);
  const maxIdx = maxAccountIndex(data.length);
  const validIndices = indices.filter(idx => idx < maxIdx);
  return validIndices.map(idx => ({
    idx,
    account: parseAccount(data, idx),
  }));
}
