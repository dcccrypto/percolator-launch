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

// =============================================================================
// Helper: read signed/unsigned i128 from buffer
// =============================================================================
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
  version: 0 | 1;
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

// ---- V1 layout constants (future program upgrade) ----
const V1_HEADER_LEN = 104;
const V1_CONFIG_LEN = 536;
const V1_ENGINE_OFF = 640;   // align_up(104 + 536, 8) = 640
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

// For backward compatibility, export ENGINE_OFF and ENGINE_MARK_PRICE_OFF
// (used by reinit-slab and other scripts). These refer to V1 layout.
export const ENGINE_OFF = V1_ENGINE_OFF;
export const ENGINE_MARK_PRICE_OFF = V1_ENGINE_MARK_PRICE_OFF;

// ---- Known slab sizes per version and tier ----

function computeSlabSize(
  engineOff: number,
  bitmapOff: number,
  accountSize: number,
  maxAccounts: number,
): number {
  const bitmapWords = Math.ceil(maxAccounts / 64);
  const bitmapBytes = bitmapWords * 8;
  const postBitmap = 18; // num_used(u16,2) + pad(6) + next_account_id(u64,8) + free_head(u16,2)
  const nextFreeBytes = maxAccounts * 2;
  const preAccountsLen = bitmapOff + bitmapBytes + postBitmap + nextFreeBytes;
  const accountsOff = Math.ceil(preAccountsLen / 8) * 8;
  return engineOff + accountsOff + maxAccounts * accountSize;
}

const TIERS = [64, 256, 1024, 4096] as const;

// Pre-compute known slab sizes for fast lookup
const V0_SIZES = new Map<number, number>();
const V1_SIZES = new Map<number, number>();
for (const n of TIERS) {
  V0_SIZES.set(computeSlabSize(V0_ENGINE_OFF, V0_ENGINE_BITMAP_OFF, V0_ACCOUNT_SIZE, n), n);
  V1_SIZES.set(computeSlabSize(V1_ENGINE_OFF, V1_ENGINE_BITMAP_OFF, V1_ACCOUNT_SIZE, n), n);
}

function buildLayout(version: 0 | 1, maxAccounts: number): SlabLayout {
  const isV0 = version === 0;
  const engineOff = isV0 ? V0_ENGINE_OFF : V1_ENGINE_OFF;
  const bitmapOff = isV0 ? V0_ENGINE_BITMAP_OFF : V1_ENGINE_BITMAP_OFF;
  const accountSize = isV0 ? V0_ACCOUNT_SIZE : V1_ACCOUNT_SIZE;
  const bitmapWords = Math.ceil(maxAccounts / 64);
  const bitmapBytes = bitmapWords * 8;
  const postBitmap = 18;
  const nextFreeBytes = maxAccounts * 2;
  const preAccountsLen = bitmapOff + bitmapBytes + postBitmap + nextFreeBytes;
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
    engineBitmapOff: isV0 ? V0_ENGINE_BITMAP_OFF : V1_ENGINE_BITMAP_OFF,

    hasInsuranceIsolation: !isV0,
    engineInsuranceIsolatedOff: isV0 ? -1 : 48,
    engineInsuranceIsolationBpsOff: isV0 ? -1 : 64,
  };
}

/**
 * Detect slab layout version from data length.
 * Returns a full SlabLayout descriptor or null if unrecognized.
 */
export function detectSlabLayout(dataLen: number): SlabLayout | null {
  // Check V0 sizes first (deployed devnet program)
  const v0n = V0_SIZES.get(dataLen);
  if (v0n !== undefined) return buildLayout(0, v0n);

  // Check V1 sizes (future upgraded program)
  const v1n = V1_SIZES.get(dataLen);
  if (v1n !== undefined) return buildLayout(1, v1n);

  return null;
}

/**
 * Legacy detectLayout for backward compat.
 * Returns { bitmapWords, accountsOff, maxAccounts } or null.
 */
export function detectLayout(dataLen: number) {
  const layout = detectSlabLayout(dataLen);
  if (!layout) return null;
  const bitmapBytes = layout.bitmapWords * 8;
  const postBitmap = 18;
  const nextFreeBytes = layout.maxAccounts * 2;
  const preAccountsLen = layout.engineBitmapOff + bitmapBytes + postBitmap + nextFreeBytes;
  const accountsOff = Math.ceil(preAccountsLen / 8) * 8;
  return { bitmapWords: layout.bitmapWords, accountsOff, maxAccounts: layout.maxAccounts };
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
  fundingPremiumWeightBps: bigint;
  fundingSettlementIntervalSlots: bigint;
  fundingPremiumDampeningE6: bigint;
  fundingPremiumMaxBpsPerSlot: bigint;
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
  const layout = detectSlabLayout(data.length);
  const roff = layout ? layout.reservedOff : V0_RESERVED_OFF;
  if (data.length < roff + 8) throw new Error("Slab data too short for nonce");
  return readU64LE(data, roff);
}

export function readLastThrUpdateSlot(data: Uint8Array): bigint {
  const layout = detectSlabLayout(data.length);
  const roff = layout ? layout.reservedOff : V0_RESERVED_OFF;
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
  const layout = detectSlabLayout(data.length);
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
 */
export function parseConfig(data: Uint8Array): MarketConfig {
  const layout = detectSlabLayout(data.length);
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

  // Extended funding fields
  const fundingPremiumWeightBps = readU64LE(data, off);
  off += 8;

  const fundingSettlementIntervalSlots = readU64LE(data, off);
  off += 8;

  const fundingPremiumDampeningE6 = readU64LE(data, off);
  off += 8;

  const fundingPremiumMaxBpsPerSlot = readU64LE(data, off);
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

  if (remaining >= 40) {
    // V1 extended fields (adaptive funding, maturity ramp, auto-unresolve)
    adaptiveFundingEnabled = readU8(data, off) !== 0;
    off += 1;
    off += 1; // _adaptive_pad
    adaptiveScaleBps = readU16LE(data, off);
    off += 2;
    off += 4; // _adaptive_pad2
    adaptiveMaxFundingBps = readU64LE(data, off);
    off += 8;

    marketCreatedSlot = readU64LE(data, off);
    off += 8;

    oiRampSlots = readU64LE(data, off);
    off += 8;

    resolvedSlot = readU64LE(data, off);
    off += 8;
    off += 8; // _perc301_reserved
    if (remaining >= 42) {
      insuranceIsolationBps = readU16LE(data, off);
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
    fundingPremiumWeightBps,
    fundingSettlementIntervalSlots,
    fundingPremiumDampeningE6,
    fundingPremiumMaxBpsPerSlot,
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
  };
}

/**
 * Parse RiskParams from engine data. Layout-version aware.
 * For V0 slabs, extended params (risk_threshold, maintenance_fee, etc.) are
 * not present on-chain, so defaults (0) are returned.
 */
export function parseParams(data: Uint8Array): RiskParams {
  const layout = detectSlabLayout(data.length);
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
  const layout = detectSlabLayout(data.length);
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
    lpMaxAbs: readU128LE(data, base + layout.engineLpMaxAbsOff),
    lpMaxAbsSweep: readU128LE(data, base + layout.engineLpMaxAbsSweepOff),
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
      const bw = layout.bitmapWords;
      return readU16LE(data, base + layout.engineBitmapOff + bw * 8);
    })(),
    nextAccountId: (() => {
      const bw = layout.bitmapWords;
      const numUsedOff = layout.engineBitmapOff + bw * 8;
      return readU64LE(data, base + Math.ceil((numUsedOff + 2) / 8) * 8);
    })(),
  };
}

/**
 * Read bitmap to get list of used account indices.
 */
export function parseUsedIndices(data: Uint8Array): number[] {
  const layout = detectSlabLayout(data.length);
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
  const layout = detectSlabLayout(data.length);
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
  const layout = detectSlabLayout(data.length);
  if (!layout) throw new Error(`Unrecognized slab data length: ${data.length}`);

  const maxIdx = maxAccountIndex(data.length);
  if (!Number.isInteger(idx) || idx < 0 || idx >= maxIdx) {
    throw new Error(`Account index out of range: ${idx} (max: ${maxIdx - 1})`);
  }

  const base = layout.accountsOff + idx * layout.accountSize;
  if (data.length < base + layout.accountSize) {
    throw new Error("Slab data too short for account");
  }

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

