import { Connection, PublicKey } from "@solana/web3.js";
import {
  parseHeader,
  parseConfig,
  parseParams,
  detectSlabLayout,
  SLAB_TIERS_V1M,
  SLAB_TIERS_V2,
  type SlabHeader,
  type MarketConfig,
  type EngineState,
  type RiskParams,
  type SlabLayout,
} from "./slab.js";

/** V1 bitmap offset within engine struct (updated for PERC-120/121/122 struct changes) */
const ENGINE_BITMAP_OFF = 656; // Updated for PERC-299 (608 + 24 emergency OI fields)
/** V0 bitmap offset within engine struct (deployed devnet program) */
const ENGINE_BITMAP_OFF_V0 = 320;

/**
 * A discovered Percolator market from on-chain program accounts.
 */
export interface DiscoveredMarket {
  slabAddress: PublicKey;
  /** The program that owns this slab account */
  programId: PublicKey;
  header: SlabHeader;
  config: MarketConfig;
  engine: EngineState;
  params: RiskParams;
}

/** PERCOLAT magic bytes — stored little-endian on-chain as TALOCREP */
const MAGIC_BYTES = new Uint8Array([0x54, 0x41, 0x4c, 0x4f, 0x43, 0x52, 0x45, 0x50]);

/**
 * Slab tier definitions — V1 layout (all tiers upgraded as of 2026-03-13).
 * IMPORTANT: dataSize must match the compiled program's SLAB_LEN for that MAX_ACCOUNTS.
 * The on-chain program has a hardcoded SLAB_LEN — slab account data.len() must equal it exactly.
 *
 * Layout: HEADER(104) + CONFIG(536) + RiskEngine(variable by tier)
 *   ENGINE_OFF = 640  (HEADER=104 + CONFIG=536, padded to 8-byte align on SBF)
 *   RiskEngine = fixed(656) + bitmap(BW*8) + post_bitmap(18) + next_free(N*2) + pad + accounts(N*248)
 *
 * Values are empirically verified against on-chain initialized accounts (GH #1109):
 *   small  = 65,352  (256-acct program, verified on-chain post-V1 upgrade)
 *   medium = 257,448 (1024-acct program g9msRSV3, verified on-chain)
 *   large  = 1,025,832 (4096-acct program FxfD37s1, pre-PERC-118, matches slabDataSizeV1(4096) formula)
 *
 * NOTE: small program (FwfBKZXb) redeployed with --features small,devnet (2026-03-13).
 *       Large program FxfD37s1 is pre-PERC-118 — SLAB_LEN=1,025,832, matching formula.
 *       See GH #1109, GH #1112.
 *
 * History: Small was V0 (62_808) until 2026-03-13 program upgrade. V0 values preserved
 *          in SLAB_TIERS_V0 for discovery of legacy on-chain accounts.
 */
export const SLAB_TIERS = {
  small:  { maxAccounts: 256,  dataSize: 65_352,    label: "Small",  description: "256 slots · ~0.45 SOL" },
  medium: { maxAccounts: 1024, dataSize: 257_448,   label: "Medium", description: "1,024 slots · ~1.79 SOL" },
  large:  { maxAccounts: 4096, dataSize: 1_025_832, label: "Large",  description: "4,096 slots · ~7.14 SOL" },
} as const;

/** @deprecated V0 slab sizes — kept for backward compatibility with old on-chain slabs */
export const SLAB_TIERS_V0 = {
  small:  { maxAccounts: 256,  dataSize: 62_808,    label: "Small",  description: "256 slots · ~0.44 SOL" },
  medium: { maxAccounts: 1024, dataSize: 248_760,   label: "Medium", description: "1,024 slots · ~1.73 SOL" },
  large:  { maxAccounts: 4096, dataSize: 992_568,   label: "Large",  description: "4,096 slots · ~6.90 SOL" },
} as const;

/**
 * V1D slab sizes — actually-deployed devnet V1 program (ENGINE_OFF=424, BITMAP_OFF=624).
 * PR #1200 added V1D layout detection in slab.ts but discovery.ts ALL_TIERS was missing
 * these sizes, causing V1D slabs to fall through to the memcmp fallback with wrong dataSize
 * hints → detectSlabLayout returning null → parse failure (GH#1205).
 *
 * Sizes computed via computeSlabSize(ENGINE_OFF=424, BITMAP_OFF=624, ACCOUNT_SIZE=248, N, postBitmap=2):
 *   The V1D deployed program uses postBitmap=2 (free_head u16 only — no num_used/pad/next_account_id).
 *   This is 16 bytes smaller per tier than the SDK default (postBitmap=18). GH#1234.
 *   micro  =  17,064  (64 slots)
 *   small  =  65,088  (256 slots)
 *   medium = 257,184  (1,024 slots)
 *   large  = 1,025,568 (4,096 slots)
 */
export const SLAB_TIERS_V1D = {
  micro:  { maxAccounts: 64,   dataSize: 17_064,     label: "Micro",  description: "64 slots (V1D devnet)" },
  small:  { maxAccounts: 256,  dataSize: 65_088,     label: "Small",  description: "256 slots (V1D devnet)" },
  medium: { maxAccounts: 1024, dataSize: 257_184,    label: "Medium", description: "1,024 slots (V1D devnet)" },
  large:  { maxAccounts: 4096, dataSize: 1_025_568,  label: "Large",  description: "4,096 slots (V1D devnet)" },
} as const;

/**
 * V1D legacy slab sizes — on-chain V1D slabs created before GH#1234 when the SDK assumed
 * postBitmap=18. These are 16 bytes larger per tier than SLAB_TIERS_V1D.
 * PR #1236 fixed postBitmap for new slabs (→2) but caused slab 6ZytbpV4 (65104 bytes,
 * top active market ~$15k 24h vol) to be unrecognized → "Failed to load market". GH#1237.
 *
 * Sizes computed via computeSlabSize(ENGINE_OFF=424, BITMAP_OFF=624, ACCOUNT_SIZE=248, N, postBitmap=18):
 *   micro  =  17,080  (64 slots)
 *   small  =  65,104  (256 slots)  ← slab 6ZytbpV4 TEST/USD
 *   medium = 257,200  (1,024 slots)
 *   large  = 1,025,584 (4,096 slots)
 */
export const SLAB_TIERS_V1D_LEGACY = {
  micro:  { maxAccounts: 64,   dataSize: 17_080,     label: "Micro",  description: "64 slots (V1D legacy, postBitmap=18)" },
  small:  { maxAccounts: 256,  dataSize: 65_104,     label: "Small",  description: "256 slots (V1D legacy, postBitmap=18)" },
  medium: { maxAccounts: 1024, dataSize: 257_200,    label: "Medium", description: "1,024 slots (V1D legacy, postBitmap=18)" },
  large:  { maxAccounts: 4096, dataSize: 1_025_584,  label: "Large",  description: "4,096 slots (V1D legacy, postBitmap=18)" },
} as const;

/** @deprecated Alias — use SLAB_TIERS (already V1) */
export const SLAB_TIERS_V1 = SLAB_TIERS;

export type SlabTierKey = keyof typeof SLAB_TIERS;

/** Calculate slab data size for arbitrary account count.
 *
 * Layout (SBF, u128 align = 8):
 *   HEADER(104) + CONFIG(536) → ENGINE_OFF = 640
 *   RiskEngine fixed scalars: 656 bytes (PERC-299: +24 emergency OI, +32 long/short OI)
 *   + bitmap: ceil(N/64)*8
 *   + num_used_accounts(u16) + pad(6) + next_account_id(u64) + free_head(u16) = 18
 *   + next_free: N*2
 *   + pad to 8-byte alignment for Account array
 *   + accounts: N*248
 *
 * Must match the on-chain program's SLAB_LEN exactly.
 */
export function slabDataSize(maxAccounts: number): number {
  // V0 layout (deployed devnet): ENGINE_OFF=480, ENGINE_BITMAP_OFF=320, ACCOUNT_SIZE=240
  const ENGINE_OFF_V0 = 480;
  const ENGINE_BITMAP_OFF_V0 = 320;
  const ACCOUNT_SIZE_V0 = 240;
  const bitmapBytes = Math.ceil(maxAccounts / 64) * 8;
  const postBitmap = 18;
  const nextFreeBytes = maxAccounts * 2;
  const preAccountsLen = ENGINE_BITMAP_OFF_V0 + bitmapBytes + postBitmap + nextFreeBytes;
  const accountsOff = Math.ceil(preAccountsLen / 8) * 8;
  return ENGINE_OFF_V0 + accountsOff + maxAccounts * ACCOUNT_SIZE_V0;
}

/**
 * Calculate slab data size for V1 layout (ENGINE_OFF=640).
 *
 * NOTE: This formula is accurate for small (256) and medium (1024) tiers but
 * underestimates large (4096) by 16 bytes — likely due to a padding/alignment
 * difference at high account counts or a post-PERC-118 struct addition in the
 * deployed binary. Always prefer the hardcoded SLAB_TIERS values (empirically
 * verified on-chain) over this formula for production use.
 */
export function slabDataSizeV1(maxAccounts: number): number {
  const ENGINE_OFF_V1 = 640;  // HEADER(104) + CONFIG(536) aligned to 8 on SBF = 640
  const ENGINE_BITMAP_OFF_V1 = 656;
  const ACCOUNT_SIZE_V1 = 248;
  const bitmapBytes = Math.ceil(maxAccounts / 64) * 8;
  const postBitmap = 18;
  const nextFreeBytes = maxAccounts * 2;
  const preAccountsLen = ENGINE_BITMAP_OFF_V1 + bitmapBytes + postBitmap + nextFreeBytes;
  const accountsOff = Math.ceil(preAccountsLen / 8) * 8;
  return ENGINE_OFF_V1 + accountsOff + maxAccounts * ACCOUNT_SIZE_V1;
}

/**
 * Validate that a slab data size matches one of the known tier sizes.
 * Use this to catch tier↔program mismatches early (PERC-277).
 *
 * @param dataSize - The expected slab data size (from SLAB_TIERS[tier].dataSize)
 * @param programSlabLen - The program's compiled SLAB_LEN (from on-chain error logs or program introspection)
 * @returns true if sizes match, false if there's a mismatch
 */
export function validateSlabTierMatch(dataSize: number, programSlabLen: number): boolean {
  return dataSize === programSlabLen;
}

/** All known slab data sizes for discovery (V0 + V1 + V1D + V1D legacy + V1M tiers) */
const ALL_SLAB_SIZES = [
  ...Object.values(SLAB_TIERS).map(t => t.dataSize),
  ...Object.values(SLAB_TIERS_V0).map(t => t.dataSize),
  ...Object.values(SLAB_TIERS_V1D).map(t => t.dataSize),
  ...Object.values(SLAB_TIERS_V1D_LEGACY).map(t => t.dataSize),
  ...Object.values(SLAB_TIERS_V1M).map(t => t.dataSize),
];

/** Legacy constant for backward compat */
const SLAB_DATA_SIZE = SLAB_TIERS.large.dataSize;

/** We need header(104) + config(536) + engine up to nextAccountId (~1200). Total ~1840. Use 1940 for margin. */
const HEADER_SLICE_LENGTH = 1940;

function dv(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}
function readU16LE(data: Uint8Array, off: number): number {
  return dv(data).getUint16(off, true);
}
function readU64LE(data: Uint8Array, off: number): bigint {
  return dv(data).getBigUint64(off, true);
}
function readI64LE(data: Uint8Array, off: number): bigint {
  return dv(data).getBigInt64(off, true);
}
function readU128LE(buf: Uint8Array, offset: number): bigint {
  const lo = readU64LE(buf, offset);
  const hi = readU64LE(buf, offset + 8);
  return (hi << 64n) | lo;
}
function readI128LE(buf: Uint8Array, offset: number): bigint {
  const lo = readU64LE(buf, offset);
  const hi = readU64LE(buf, offset + 8);
  const unsigned = (hi << 64n) | lo;
  const SIGN_BIT = 1n << 127n;
  if (unsigned >= SIGN_BIT) return unsigned - (1n << 128n);
  return unsigned;
}

/**
 * Light engine parser that works with partial slab data (dataSlice, no accounts array).
 * Requires a layout hint (from detectSlabLayout on the actual slab size) to use correct offsets.
 *
 * @param data        — partial slab slice (HEADER_SLICE_LENGTH bytes)
 * @param layout      — SlabLayout from detectSlabLayout(actualDataSize). If null, falls back to V0.
 * @param maxAccounts — tier's max accounts for bitmap offset calculation
 */
function parseEngineLight(
  data: Uint8Array,
  layout: SlabLayout | null,
  maxAccounts: number = 4096,
): EngineState {
  const isV0 = !layout || layout.version === 0;
  const base = layout ? layout.engineOff : 480; // V0=480, V1=640
  const bitmapOff = layout ? layout.engineBitmapOff : ENGINE_BITMAP_OFF_V0;

  const minLen = base + bitmapOff;
  if (data.length < minLen) {
    throw new Error(`Slab data too short for engine light parse: ${data.length} < ${minLen}`);
  }

  // Compute tier-dependent offsets for numUsedAccounts and nextAccountId
  const bitmapWords = Math.ceil(maxAccounts / 64);
  const numUsedOff = bitmapOff + bitmapWords * 8; // u16 right after bitmap
  const nextAccountIdOff = Math.ceil((numUsedOff + 2) / 8) * 8; // u64, 8-byte aligned

  const canReadNumUsed = data.length >= base + numUsedOff + 2;
  const canReadNextId = data.length >= base + nextAccountIdOff + 8;

  if (isV0) {
    // V0 engine struct (deployed devnet): ENGINE_OFF=480
    // vault(0,16) + insurance(16,32) + params(48,56) + currentSlot(104,8)
    // + fundingIndex(112,16) + lastFundingSlot(128,8) + fundingRateBps(136,8)
    // + lastCrankSlot(144,8) + maxCrankStaleness(152,8) + totalOI(160,16)
    // + cTot(176,16) + pnlPosTot(192,16) + liqCursor(208,2) + gcCursor(210,2)
    // + lastSweepStart(216,8) + lastSweepComplete(224,8) + crankCursor(232,2) + sweepStartIdx(234,2)
    // + lifetimeLiquidations(240,8) + lifetimeForceCloses(248,8)
    // + netLpPos(256,16) + lpSumAbs(272,16) + lpMaxAbs(288,16) + bitmap(320)
    return {
      vault: readU128LE(data, base + 0),
      insuranceFund: {
        balance: readU128LE(data, base + 16),
        feeRevenue: readU128LE(data, base + 32),
        isolatedBalance: 0n,
        isolationBps: 0,
      },
      currentSlot: readU64LE(data, base + 104),
      fundingIndexQpbE6: readI128LE(data, base + 112),
      lastFundingSlot: readU64LE(data, base + 128),
      fundingRateBpsPerSlotLast: readI64LE(data, base + 136),
      lastCrankSlot: readU64LE(data, base + 144),
      maxCrankStalenessSlots: readU64LE(data, base + 152),
      totalOpenInterest: readU128LE(data, base + 160),
      longOi: 0n,
      shortOi: 0n,
      cTot: readU128LE(data, base + 176),
      pnlPosTot: readU128LE(data, base + 192),
      liqCursor: readU16LE(data, base + 208),
      gcCursor: readU16LE(data, base + 210),
      lastSweepStartSlot: readU64LE(data, base + 216),
      lastSweepCompleteSlot: readU64LE(data, base + 224),
      crankCursor: readU16LE(data, base + 232),
      sweepStartIdx: readU16LE(data, base + 234),
      lifetimeLiquidations: readU64LE(data, base + 240),
      lifetimeForceCloses: readU64LE(data, base + 248),
      netLpPos: readI128LE(data, base + 256),
      lpSumAbs: readU128LE(data, base + 272),
      lpMaxAbs: readU128LE(data, base + 288),
      lpMaxAbsSweep: 0n,
      emergencyOiMode: false,
      emergencyStartSlot: 0n,
      lastBreakerSlot: 0n,
      markPriceE6: 0n, // V0 engine has no mark_price field
      numUsedAccounts: canReadNumUsed ? readU16LE(data, base + numUsedOff) : 0,
      nextAccountId: canReadNextId ? readU64LE(data, base + nextAccountIdOff) : 0n,
    };
  }

  // V2 engine struct (BPF intermediate): ENGINE_OFF=600, BITMAP_OFF=432
  // No mark_price, long_oi, short_oi, emergency OI fields.
  // Field offsets relative to engineOff are different from V1.
  const isV2 = layout?.version === 2;
  if (isV2) {
    return {
      vault: readU128LE(data, base + 0),
      insuranceFund: {
        balance: readU128LE(data, base + 16),
        feeRevenue: readU128LE(data, base + 32),
        isolatedBalance: readU128LE(data, base + 48),
        isolationBps: readU16LE(data, base + 64),
      },
      currentSlot: readU64LE(data, base + 352),
      fundingIndexQpbE6: readI128LE(data, base + 360),
      lastFundingSlot: readU64LE(data, base + 376),
      fundingRateBpsPerSlotLast: readI64LE(data, base + 384),
      lastCrankSlot: readU64LE(data, base + 392),
      maxCrankStalenessSlots: readU64LE(data, base + 400),
      totalOpenInterest: readU128LE(data, base + 408),
      longOi: 0n,              // V2 has no long_oi
      shortOi: 0n,             // V2 has no short_oi
      cTot: readU128LE(data, base + 424),
      pnlPosTot: readU128LE(data, base + 440),
      liqCursor: readU16LE(data, base + 456),
      gcCursor: readU16LE(data, base + 458),
      lastSweepStartSlot: readU64LE(data, base + 464),
      lastSweepCompleteSlot: readU64LE(data, base + 472),
      crankCursor: readU16LE(data, base + 480),
      sweepStartIdx: readU16LE(data, base + 482),
      lifetimeLiquidations: readU64LE(data, base + 488),
      lifetimeForceCloses: readU64LE(data, base + 496),
      netLpPos: readI128LE(data, base + 504),
      lpSumAbs: readU128LE(data, base + 520),
      lpMaxAbs: readU128LE(data, base + 536),
      lpMaxAbsSweep: readU128LE(data, base + 552),
      emergencyOiMode: false,   // V2 has no emergency OI fields
      emergencyStartSlot: 0n,
      lastBreakerSlot: 0n,
      markPriceE6: 0n,          // V2 has no mark_price
      numUsedAccounts: canReadNumUsed ? readU16LE(data, base + numUsedOff) : 0,
      nextAccountId: canReadNextId ? readU64LE(data, base + nextAccountIdOff) : 0n,
    };
  }

  // V1 engine struct (PERC-1094 corrected): ENGINE_OFF=600 (BPF/SBF, CONFIG_LEN=496)
  // vault(0,16) + insurance(16,56) + params(72,288) + currentSlot(360) + fundingIndex(368,16)
  // + lastFundingSlot(384) + fundingRateBps(392) + markPrice(400) + lastCrankSlot(424)
  // + maxCrankStaleness(432) + totalOI(440,16) + longOi(456,16) + shortOi(472,16)
  // + cTot(488,16) + pnlPosTot(504,16) + liqCursor(520,2) + gcCursor(522,2)
  // + lastSweepStart(528) + lastSweepComplete(536) + crankCursor(544,2) + sweepStartIdx(546,2)
  // + lifetimeLiquidations(552) + lifetimeForceCloses(560)
  // + netLpPos(568,16) + lpSumAbs(584,16) + lpMaxAbs(600,16) + lpMaxAbsSweep(616,16)
  // + emergencyOiMode(632,1+7pad) + emergencyStartSlot(640) + lastBreakerSlot(648) + bitmap(656)
  return {
    vault: readU128LE(data, base + 0),
    insuranceFund: {
      balance: readU128LE(data, base + 16),
      feeRevenue: readU128LE(data, base + 32),
      isolatedBalance: readU128LE(data, base + 48),
      isolationBps: readU16LE(data, base + 64),
    },
    currentSlot: readU64LE(data, base + 360),     // PERC-1094: params end at 72+288=360 (was 352)
    fundingIndexQpbE6: readI128LE(data, base + 368),
    lastFundingSlot: readU64LE(data, base + 384),
    fundingRateBpsPerSlotLast: readI64LE(data, base + 392),
    lastCrankSlot: readU64LE(data, base + 424),
    maxCrankStalenessSlots: readU64LE(data, base + 408),
    totalOpenInterest: readU128LE(data, base + 416),
    longOi: readU128LE(data, base + 432),
    shortOi: readU128LE(data, base + 448),
    cTot: readU128LE(data, base + 464),
    pnlPosTot: readU128LE(data, base + 480),
    liqCursor: readU16LE(data, base + 496),
    gcCursor: readU16LE(data, base + 498),
    lastSweepStartSlot: readU64LE(data, base + 504),
    lastSweepCompleteSlot: readU64LE(data, base + 512),
    crankCursor: readU16LE(data, base + 520),
    sweepStartIdx: readU16LE(data, base + 522),
    lifetimeLiquidations: readU64LE(data, base + 528),
    lifetimeForceCloses: readU64LE(data, base + 536),
    netLpPos: readI128LE(data, base + 544),
    lpSumAbs: readU128LE(data, base + 560),
    lpMaxAbs: readU128LE(data, base + 576),
    lpMaxAbsSweep: readU128LE(data, base + 592),
    emergencyOiMode: data[base + 608] !== 0,
    emergencyStartSlot: readU64LE(data, base + 616),
    lastBreakerSlot: readU64LE(data, base + 624),
    markPriceE6: readU64LE(data, base + 400),      // PERC-1094: was 392
    numUsedAccounts: canReadNumUsed ? readU16LE(data, base + numUsedOff) : 0,
    nextAccountId: canReadNextId ? readU64LE(data, base + nextAccountIdOff) : 0n,
  };
}

/** Options for `discoverMarkets`. */
export interface DiscoverMarketsOptions {
  /**
   * Run tier queries sequentially with per-tier retry on HTTP 429 instead of
   * firing all in parallel.  Reduces RPC rate-limit pressure at the cost of
   * slightly slower discovery (~14 round-trips instead of 1 concurrent batch).
   * Default: false (preserves original parallel behaviour).
   *
   * PERC-1650: keeper uses this flag to avoid 429 storms on its fallback RPC
   * (Helius starter tier).  Pass `sequential: true` from CrankService.discover().
   */
  sequential?: boolean;
  /**
   * Delay in ms between sequential tier queries (only used when sequential=true).
   * Default: 200 ms.
   */
  interTierDelayMs?: number;
  /**
   * Per-tier retry backoff delays on 429 (ms).  Jitter of up to +25% is applied.
   * Only used when sequential=true.  Default: [1_000, 3_000, 9_000, 27_000].
   */
  rateLimitBackoffMs?: number[];
}

/** Return true if the error looks like an HTTP 429 / rate-limit response. */
function isRateLimitError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("429") ||
    msg.toLowerCase().includes("rate limit") ||
    msg.toLowerCase().includes("too many requests")
  );
}

/** Add up to 25% random jitter to avoid thundering-herd on retry. */
function withJitter(delayMs: number): number {
  return delayMs + Math.floor(Math.random() * delayMs * 0.25);
}

/**
 * Discover all Percolator markets owned by the given program.
 * Uses getProgramAccounts with dataSize filter + dataSlice to download only ~1400 bytes per slab.
 *
 * @param options.sequential - Run tier queries sequentially with 429 retry (PERC-1650).
 */
export async function discoverMarkets(
  connection: Connection,
  programId: PublicKey,
  options: DiscoverMarketsOptions = {},
): Promise<DiscoveredMarket[]> {
  const {
    sequential = false,
    interTierDelayMs = 200,
    rateLimitBackoffMs = [1_000, 3_000, 9_000, 27_000],
  } = options;

  // Query all known slab sizes in parallel — V0, V1D (deployed devnet), V1D legacy, and V1 (upgraded) tiers.
  // We track the actual dataSize per entry so detectSlabLayout can determine the correct layout,
  // and pass that layout to all parse functions (avoids wrong-version offsets on partial slices).
  // GH#1205: V1D tiers were missing here — V1D slabs fell through to memcmp fallback with wrong
  // dataSize hints → detectSlabLayout returned null → parse failure in discoverMarkets.
  // GH#1237/GH#1238: SLAB_TIERS_V1D_LEGACY (postBitmap=18, e.g. 65,104-byte slabs created before
  // GH#1234) must also be included; omitting them causes legacy on-chain slabs to be missed by
  // dataSize filter queries and fall through to memcmp with wrong maxAccounts hint.
  const ALL_TIERS = [
    ...Object.values(SLAB_TIERS),
    ...Object.values(SLAB_TIERS_V0),
    ...Object.values(SLAB_TIERS_V1D),
    ...Object.values(SLAB_TIERS_V1D_LEGACY),
    ...Object.values(SLAB_TIERS_V2),
    ...Object.values(SLAB_TIERS_V1M),
  ];
  type RawEntry = { pubkey: PublicKey; account: { data: Buffer | Uint8Array }; maxAccounts: number; dataSize: number };
  let rawAccounts: RawEntry[] = [];

  /**
   * Fetch one tier with per-attempt 429 retry (sequential mode only).
   * Returns an array of RawEntry on success, or an empty array after exhausting retries.
   */
  async function fetchTierWithRetry(
    tier: { dataSize: number; maxAccounts: number },
  ): Promise<RawEntry[]> {
    for (let attempt = 0; attempt <= rateLimitBackoffMs.length; attempt++) {
      try {
        const results = await connection.getProgramAccounts(programId, {
          filters: [{ dataSize: tier.dataSize }],
          dataSlice: { offset: 0, length: HEADER_SLICE_LENGTH },
        });
        return results.map(entry => ({ ...entry, maxAccounts: tier.maxAccounts, dataSize: tier.dataSize }));
      } catch (err) {
        if (isRateLimitError(err) && attempt < rateLimitBackoffMs.length) {
          const delay = withJitter(rateLimitBackoffMs[attempt]);
          console.warn(
            `[discoverMarkets] 429 on tier dataSize=${tier.dataSize} attempt=${attempt + 1}, backing off ${delay}ms`,
          );
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        // Non-429 or exhausted retries
        console.warn(
          `[discoverMarkets] Tier query failed (dataSize=${tier.dataSize}, attempt=${attempt + 1}):`,
          err instanceof Error ? err.message : err,
        );
        return [];
      }
    }
    return [];
  }

  try {
    if (sequential) {
      // PERC-1650: sequential mode — one tier at a time with inter-tier spacing + per-tier 429 retry.
      for (let i = 0; i < ALL_TIERS.length; i++) {
        const tier = ALL_TIERS[i];
        const entries = await fetchTierWithRetry(tier);
        rawAccounts.push(...entries);
        if (i < ALL_TIERS.length - 1) {
          await new Promise(r => setTimeout(r, interTierDelayMs));
        }
      }
    } else {
      // Original parallel mode: fire all tier queries simultaneously.
      const queries = ALL_TIERS.map(tier =>
        connection.getProgramAccounts(programId, {
          filters: [{ dataSize: tier.dataSize }],
          dataSlice: { offset: 0, length: HEADER_SLICE_LENGTH },
        }).then(results => results.map(entry => ({ ...entry, maxAccounts: tier.maxAccounts, dataSize: tier.dataSize })))
      );
      const results = await Promise.allSettled(queries);
      let hadRejection = false;
      for (const result of results) {
        if (result.status === "fulfilled") {
          for (const entry of result.value) {
            rawAccounts.push(entry as RawEntry);
          }
        } else {
          hadRejection = true;
          console.warn(
            "[discoverMarkets] Tier query rejected:",
            result.reason instanceof Error ? result.reason.message : result.reason,
          );
        }
      }
      void hadRejection; // intentionally unused — see NOTE below
    }

    // NOTE: hadRejection guard removed — dataSize filters silently return 0 when on-chain
    // account size changed; RPC returns no error, so we must fallback on empty results too.
    if (rawAccounts.length === 0) {
      console.warn("[discoverMarkets] dataSize filters returned 0 markets, falling back to memcmp");
      const fallback = await connection.getProgramAccounts(programId, {
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: "F6P2QNqpQV5", // base58 of TALOCREP (u64 LE magic)
            },
          },
        ],
        dataSlice: { offset: 0, length: HEADER_SLICE_LENGTH },
      });
      // Unknown actual size — use large V0 as safe default (maxAccounts=4096)
      rawAccounts = [...fallback].map(e => ({ ...e, maxAccounts: 4096, dataSize: SLAB_TIERS.large.dataSize })) as RawEntry[];
    }
  } catch (err) {
    console.warn(
      "[discoverMarkets] dataSize filters failed, falling back to memcmp:",
      err instanceof Error ? err.message : err,
    );
    const fallback = await connection.getProgramAccounts(programId, {
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: "F6P2QNqpQV5", // base58 of TALOCREP (u64 LE magic)
          },
        },
      ],
      dataSlice: { offset: 0, length: HEADER_SLICE_LENGTH },
    });
    rawAccounts = [...fallback].map(e => ({ ...e, maxAccounts: 4096, dataSize: SLAB_TIERS.large.dataSize })) as RawEntry[];
  }
  const accounts = rawAccounts;

  const markets: DiscoveredMarket[] = [];
  // GH#1115: deduplicate raw accounts by pubkey — the same slab can appear in multiple
  // tier queries if both V0 and V1 sizes match or if the RPC returns duplicate entries.
  const seenPubkeys = new Set<string>();

  for (const { pubkey, account, maxAccounts, dataSize } of accounts) {
    const pkStr = pubkey.toBase58();
    if (seenPubkeys.has(pkStr)) continue;
    seenPubkeys.add(pkStr);
    const data = new Uint8Array(account.data);

    let valid = true;
    for (let i = 0; i < MAGIC_BYTES.length; i++) {
      if (data[i] !== MAGIC_BYTES[i]) {
        valid = false;
        break;
      }
    }
    if (!valid) continue;

    // Detect layout from actual slab size — not slice length — so parse functions
    // get correct V0/V1 offsets even when working on the partial HEADER_SLICE_LENGTH slice.
    // Pass the data buffer so V2 slabs (same size as V1D) can be disambiguated via version field.
    const layout = detectSlabLayout(dataSize, data);

    try {
      const header = parseHeader(data);
      const config = parseConfig(data, layout);
      const engine = parseEngineLight(data, layout, maxAccounts);
      const params = parseParams(data, layout);

      markets.push({ slabAddress: pubkey, programId, header, config, engine, params });
    } catch (err) {
      console.warn(
        `[discoverMarkets] Failed to parse account ${pubkey.toBase58()}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return markets;
}
