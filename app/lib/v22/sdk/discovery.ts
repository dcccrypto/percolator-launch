/*
 * LOCAL ADAPTER PORT, not original code: verbatim from percolator-sdk feat/v22-sdk @ adf8fd0 (draft dcccrypto/percolator-sdk#406, sdk 9.0.0-candidate),
 * src/solana/discovery.ts. Only the imports are retargeted (installed @percolatorct/sdk 8.0.0 root for the shared parsers/types, the vendored ./slab
 * for the VERSION-aware isV17MarketAccount / unknownMarketVersion / knownWrapperVersions). Delete when @percolatorct/sdk >= 9.0.0 ships.
 * Do not edit here; fix upstream in percolator-sdk.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import {
  parseHeader,
  parseConfig,
  parseParams,
  detectSlabLayout,
  parseWrapperConfigV17,
  SLAB_TIERS_V1M,
  SLAB_TIERS_V1M2,
  SLAB_TIERS_V2,
  SLAB_TIERS_V_ADL,
  SLAB_TIERS_V12_1,
  SLAB_TIERS_V12_15,
  SLAB_TIERS_V12_17,
  SLAB_TIERS_V12_19,
  SLAB_TIERS_V_SETDEXPOOL,
  getStaticMarkets,
  type StaticMarketEntry,
  type Network,
  type SlabHeader,
  type MarketConfig,
  type EngineState,
  type RiskParams,
  type SlabLayout,
  type WrapperConfigV17,
} from "@percolatorct/sdk";
import { isV17MarketAccount, unknownMarketVersion, knownWrapperVersions } from "./slab";

/** V1 bitmap offset within engine struct (updated for PERC-120/121/122 struct changes) */
const ENGINE_BITMAP_OFF = 656; // Updated for PERC-299 (608 + 24 emergency OI fields)
/** V0 bitmap offset within engine struct (deployed devnet program) */
const ENGINE_BITMAP_OFF_V0 = 320;

/**
 * A discovered Percolator market from on-chain program accounts.
 */
export interface DiscoveredMarket {
  slabAddress: PublicKey;
  /** v17-line markets: the wrapper VERSION (18 = v2.1, 19 = v2.2); decode with `LAYOUTS_BY_VERSION.get(wrapperVersion)`. */
  wrapperVersion?: number;
  /** The program that owns this slab account */
  programId: PublicKey;
  /**
   * v12.x slab header. Present when the market is a v12 slab account (PERCOLAT magic).
   * Absent (undefined) for v17 market group accounts (PERCV16\0 magic) — use configV17 instead.
   */
  header: SlabHeader;
  /**
   * v12.x market config parsed from the slab CONFIG region (536 bytes at offset 104).
   * Present for v12 slab accounts. Absent for v17 accounts — use configV17 instead.
   */
  config: MarketConfig;
  /**
   * v12.x engine state (bitmap, account counts).
   * Present for v12 slab accounts. Absent for v17 accounts.
   */
  engine: EngineState;
  /**
   * v12.x risk parameters.
   * Present for v12 slab accounts. Absent for v17 accounts.
   */
  params: RiskParams;
  /**
   * v17 wrapper config (WrapperConfigV16 struct, 496 bytes at header offset 16;
   * post-protocol-fee — was 432 bytes / VERSION 16 pre-protocol-fee).
   * Present when the market is a v17 market group account (PERCV16\0 magic).
   * Absent for v12 slab accounts.
   *
   * Use `isV17Market(m)` to narrow the type:
   * ```ts
   * if (m.configV17) {
   *   console.log(m.configV17.collateralMint.toBase58());
   * }
   * ```
   */
  configV17?: WrapperConfigV17;
}

/** PERCOLAT magic bytes (v12.x slabs) — stored little-endian on-chain as TALOCREP */
const MAGIC_BYTES = new Uint8Array([0x54, 0x41, 0x4c, 0x4f, 0x43, 0x52, 0x45, 0x50]);

/**
 * v17 market group magic bytes — "PERCV16\0" as little-endian bytes.
 * These are the first 8 bytes of every v17 percolator-owned market group account.
 * The program writes MAGIC.to_le_bytes() (v16_program.rs:966), so the on-chain bytes
 * are LITTLE-ENDIAN: 0x5045_5243_5631_3600 ("PERCV16\0") -> [0x00,0x36,0x31,0x56,0x43,0x52,0x45,0x50].
 * A memcmp filter at offset 0 must use this exact LE order (isV17Account reads it via readU64LE).
 */
const V17_MAGIC_BYTES = new Uint8Array([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);

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
/**
 * Default slab tiers for the current mainnet program (v12.17).
 * These are used by useCreateMarket to allocate slab accounts of the correct size.
 * V12_17: two-bucket warmup, per-side funding, ACCOUNT_SIZE=352 (SBF).
 */
export const SLAB_TIERS = {
  small:  SLAB_TIERS_V12_17["small"],
  medium: SLAB_TIERS_V12_17["medium"],
  large:  SLAB_TIERS_V12_17["large"],
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

/**
 * V_ADL slab tier sizes — PERC-8270/8271 ADL-upgraded program.
 * ENGINE_OFF=624, BITMAP_OFF=1006, ACCOUNT_SIZE=312, postBitmap=18.
 * New account layout adds ADL tracking fields (+64 bytes/account).
 * BPF SLAB_LEN verified by cargo build-sbf in PERC-8271: large (4096) = 1288304 bytes.
 */
// Single source of truth lives in slab.ts (SLAB_TIERS_V_ADL).
export const SLAB_TIERS_V_ADL_DISCOVERY = SLAB_TIERS_V_ADL;

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

/** All known slab data sizes for discovery (V0 + V1 + V1D + V1D legacy + V1M + V_ADL tiers) */
const ALL_SLAB_SIZES = [
  ...Object.values(SLAB_TIERS).map(t => t.dataSize),
  ...Object.values(SLAB_TIERS_V0).map(t => t.dataSize),
  ...Object.values(SLAB_TIERS_V1D).map(t => t.dataSize),
  ...Object.values(SLAB_TIERS_V1D_LEGACY).map(t => t.dataSize),
  ...Object.values(SLAB_TIERS_V1M).map(t => t.dataSize),
  ...Object.values(SLAB_TIERS_V_ADL).map(t => t.dataSize),
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
export function parseEngineLight(
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
      fundingRateE9: 0n,
      marketMode: null,
      lastCrankSlot: readU64LE(data, base + 144),
      maxCrankStalenessSlots: readU64LE(data, base + 152),
      totalOpenInterest: readU128LE(data, base + 160),
      longOi: 0n,
      shortOi: 0n,
      cTot: readU128LE(data, base + 176),
      pnlPosTot: readU128LE(data, base + 192),
      pnlMaturedPosTot: 0n,
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
      oraclePriceE6: 0n,
      fLongNum: 0n, fShortNum: 0n, negPnlAccountCount: 0n, fundPxLast: 0n,
      resolvedKLongTerminalDelta: 0n, resolvedKShortTerminalDelta: 0n, resolvedLivePrice: 0n,
      numUsedAccounts: canReadNumUsed ? readU16LE(data, base + numUsedOff) : 0,
      nextAccountId: canReadNextId ? readU64LE(data, base + nextAccountIdOff) : 0n,
    };
  }

  // NOTE: a hardcoded "V2 engine struct (BPF intermediate)" branch used to live here,
  // gated on `layout?.version === 2`. It was dead/stale: `SlabLayout.version === 2` is
  // also set by buildLayoutV12_15/17/19 (V12_19 inherits it by spreading V12_17's base
  // layout) — an unrelated reuse of the same discriminant — which meant V12_15/17/19
  // (the currently-deployed mainnet tier line) were being routed through this branch's
  // long-stale hardcoded offsets (e.g. currentSlot at a fixed `base+352`) instead of
  // their own correct per-field offsets (V12_19's real engineCurrentSlotOff is 200).
  // Every field this branch returned was potentially wrong for V12_15/17/19. Removed
  // per the layout-driven branch's own comment below, which already documents that it
  // covers V12_15/17/19 — that was the intended path all along.

  // Layout-driven engine parse: covers V_ADL (engineOff=624, accountSize=312), V12_1, V12_15,
  // V12_17, V12_19, V1M, V1M2, V_SETDEXPOOL and any future layout registered in slab.ts.
  // PR #185 / PR #151: replaced the narrow isVAdl gate (engineOff===624 && accountSize===312)
  // with a general layout !== null check so ALL layout variants use the descriptor-driven path.
  // The old hardcoded V1 fallback block (fixed offsets) is removed — it misread V12_1x slabs
  // that share engineOff=640 but have different internal struct sizes.
  if (layout !== null) {
    const l = layout;
    // hasInsuranceIsolation: v17+ layouts expose isolatedBalance/isolationBps; older ones set -1.
    const hasInsuranceIsolation = l.engineInsuranceIsolatedOff >= 0 && l.engineInsuranceIsolationBpsOff >= 0;
    // Absent-field guards. A SlabLayout sets an offset to -1 when the engine
    // struct for that tier has no such field, and `base + (-1)` would read
    // garbage straddling the byte before the engine region rather than failing.
    // V12_15 has 25 such fields and V12_17/V12_19 have 22 each, so every read
    // below goes through these instead of reading the offset directly.
    const u16At = (off: number): number => (off >= 0 ? readU16LE(data, base + off) : 0);
    const u64At = (off: number): bigint => (off >= 0 ? readU64LE(data, base + off) : 0n);
    const i64At = (off: number): bigint => (off >= 0 ? readI64LE(data, base + off) : 0n);
    const u128At = (off: number): bigint => (off >= 0 ? readU128LE(data, base + off) : 0n);
    const i128At = (off: number): bigint => (off >= 0 ? readI128LE(data, base + off) : 0n);
    return {
      vault: readU128LE(data, base + 0),
      insuranceFund: {
        balance: readU128LE(data, base + l.engineInsuranceOff),
        feeRevenue: readU128LE(data, base + l.engineInsuranceOff + 16),
        isolatedBalance: hasInsuranceIsolation ? readU128LE(data, base + l.engineInsuranceIsolatedOff) : 0n,
        isolationBps: hasInsuranceIsolation ? readU16LE(data, base + l.engineInsuranceIsolationBpsOff) : 0,
      },
      currentSlot: readU64LE(data, base + l.engineCurrentSlotOff),
      // engineFundingIndexOff is -1 on V12_15/17/19 (this field doesn't exist in those
      // engine structs) — guard the same way the heavy parser does (slab.ts parseEngine)
      // or `base + (-1)` reads 16 bytes starting one byte before the engine region.
      fundingIndexQpbE6: l.engineFundingIndexOff >= 0
        ? ((l.engineLastFundingSlotOff >= 0 && l.engineLastFundingSlotOff - l.engineFundingIndexOff === 8)
            ? BigInt(readI64LE(data, base + l.engineFundingIndexOff))
            : readI128LE(data, base + l.engineFundingIndexOff))
        : 0n,
      lastFundingSlot: u64At(l.engineLastFundingSlotOff),
      fundingRateBpsPerSlotLast: i64At(l.engineFundingRateBpsOff),
      fundingRateE9: 0n,
      marketMode: null,
      lastCrankSlot: u64At(l.engineLastCrankSlotOff),
      maxCrankStalenessSlots: u64At(l.engineMaxCrankStalenessOff),
      totalOpenInterest: u128At(l.engineTotalOiOff),
      longOi: u128At(l.engineLongOiOff),
      shortOi: u128At(l.engineShortOiOff),
      cTot: readU128LE(data, base + l.engineCTotOff),
      pnlPosTot: readU128LE(data, base + l.enginePnlPosTotOff),
      pnlMaturedPosTot: 0n,
      liqCursor: u16At(l.engineLiqCursorOff),
      gcCursor: u16At(l.engineGcCursorOff),
      lastSweepStartSlot: u64At(l.engineLastSweepStartOff),
      lastSweepCompleteSlot: u64At(l.engineLastSweepCompleteOff),
      crankCursor: u16At(l.engineCrankCursorOff),
      sweepStartIdx: u16At(l.engineSweepStartIdxOff),
      lifetimeLiquidations: u64At(l.engineLifetimeLiquidationsOff),
      lifetimeForceCloses: u64At(l.engineLifetimeForceClosesOff),
      netLpPos: i128At(l.engineNetLpPosOff),
      lpSumAbs: u128At(l.engineLpSumAbsOff),
      lpMaxAbs: u128At(l.engineLpMaxAbsOff),
      lpMaxAbsSweep: u128At(l.engineLpMaxAbsSweepOff),
      emergencyOiMode: l.engineEmergencyOiModeOff >= 0 ? data[base + l.engineEmergencyOiModeOff] !== 0 : false,
      emergencyStartSlot: u64At(l.engineEmergencyStartSlotOff),
      lastBreakerSlot: u64At(l.engineLastBreakerSlotOff),
      markPriceE6: u64At(l.engineMarkPriceOff),
      oraclePriceE6: 0n,
      fLongNum: 0n,
      fShortNum: 0n,
      negPnlAccountCount: 0n,
      fundPxLast: 0n,
      resolvedKLongTerminalDelta: 0n,
      resolvedKShortTerminalDelta: 0n,
      resolvedLivePrice: 0n,
      numUsedAccounts: canReadNumUsed ? readU16LE(data, base + numUsedOff) : 0,
      nextAccountId: canReadNextId ? readU64LE(data, base + nextAccountIdOff) : 0n,
    };
  }

  // layout === null: unrecognized slab format — callers should have skipped via the
  // layout !== null guard in discoverMarkets before calling parseEngineLight.
  throw new Error(`parseEngineLight: unrecognized slab layout (isV0=${isV0})`);
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

  /**
   * In parallel mode (the default), cap how many tier RPC requests are in-flight
   * at once to avoid accidental RPC storms from client code.
   *
   * Default: 6
   */
  maxParallelTiers?: number;

  /**
   * Hard cap on how many tier dataSize queries are attempted.
   * Default: all known tiers.
   */
  maxTierQueries?: number;

  /**
   * Base URL of the Percolator REST API (e.g. `"https://percolatorlaunch.com/api"`).
   *
   * When set, `discoverMarkets` will fall back to the REST API's `GET /markets`
   * endpoint if `getProgramAccounts` fails or returns 0 results (common on public
   * mainnet RPCs that reject `getProgramAccounts`).
   *
   * The API returns slab addresses which are then fetched on-chain via
   * `getMarketsByAddress` (uses `getMultipleAccounts`, works on all RPCs).
   *
   * GH#59 / PERC-8424: Unblocks mainnet users without a Helius API key.
   *
   * @example
   * ```ts
   * const markets = await discoverMarkets(connection, programId, {
   *   apiBaseUrl: "https://percolatorlaunch.com/api",
   * });
   * ```
   */
  apiBaseUrl?: string;

  /**
   * Timeout in ms for the API fallback HTTP request.
   * Only used when `apiBaseUrl` is set.
   * Default: 10_000 (10 seconds).
   */
  apiTimeoutMs?: number;

  /**
   * Network hint for tier-3 static bundle fallback (`"mainnet"` or `"devnet"`).
   *
   * When both `getProgramAccounts` (tier 1) and the REST API (tier 2) fail,
   * `discoverMarkets` will fall back to a bundled static list of known slab
   * addresses for the specified network.  The addresses are fetched on-chain
   * via `getMarketsByAddress` (`getMultipleAccounts` — works on all RPCs).
   *
   * If not set, tier-3 fallback is disabled.
   *
   * The static list can be extended at runtime via `registerStaticMarkets()`.
   *
   * @see {@link registerStaticMarkets} to add addresses at runtime
   * @see {@link getStaticMarkets} to inspect the current static list
   *
   * @example
   * ```ts
   * const markets = await discoverMarkets(connection, programId, {
   *   apiBaseUrl: "https://percolatorlaunch.com/api",
   *   network: "mainnet",  // enables tier-3 static fallback
   * });
   * ```
   */
  network?: Network;
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

/** Add equal-distribution jitter (range: [delayMs/2, delayMs]) to avoid thundering-herd on retry. */
function withJitter(delayMs: number): number {
  const half = Math.floor(delayMs / 2);
  return half + Math.floor(Math.random() * (delayMs - half + 1));
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
    maxParallelTiers = 6,
  } = options;

  // Query all known slab sizes in parallel — V0, V1D (deployed devnet), V1D legacy, and V1 (upgraded) tiers.
  // We track the actual dataSize per entry so detectSlabLayout can determine the correct layout,
  // and pass that layout to all parse functions (avoids wrong-version offsets on partial slices).
  // GH#1205: V1D tiers were missing here — V1D slabs fell through to memcmp fallback with wrong
  // dataSize hints → detectSlabLayout returned null → parse failure in discoverMarkets.
  // GH#1237/GH#1238: SLAB_TIERS_V1D_LEGACY (postBitmap=18, e.g. 65,104-byte slabs created before
  // GH#1234) must also be included; omitting them causes legacy on-chain slabs to be missed by
  // dataSize filter queries and fall through to memcmp with wrong maxAccounts hint.
  // 2026-04-29: SLAB_TIERS_V12_19 added — same class of bug. v12.19 mainnet slabs (deployed
  // 2026-05-01 to ESa89R5...) produce 96784-byte (small) accounts that none of the older tiers
  // match. Without this entry, discoverMarkets on the upgraded program returns 0 markets via the
  // dataSize-filter path and falls through to memcmp with wrong layout hints.
  //
  // PR #199: Build ALL_TIERS via a Map keyed on dataSize to eliminate duplicate tier entries.
  // SLAB_TIERS and SLAB_TIERS_V12_17 are intentionally identical (both emit small/medium/large
  // v12.17 entries), producing duplicate dataSize values that caused redundant RPC calls.
  // Tie-break: keep the entry with higher maxAccounts (more capable parse context).
  const ALL_TIERS_RAW = [
    ...Object.values(SLAB_TIERS),           // v12.17 (default)
    ...Object.values(SLAB_TIERS_V12_19),    // v12.19 (deployed mainnet)
    ...Object.values(SLAB_TIERS_V12_17),    // v12.17 (explicit)
    ...Object.values(SLAB_TIERS_V12_15),    // v12.15
    ...Object.values(SLAB_TIERS_V12_1),     // v12.1
    ...Object.values(SLAB_TIERS_V0),
    ...Object.values(SLAB_TIERS_V1D),
    ...Object.values(SLAB_TIERS_V1D_LEGACY),
    ...Object.values(SLAB_TIERS_V2),
    ...Object.values(SLAB_TIERS_V1M),
    ...Object.values(SLAB_TIERS_V1M2),
    ...Object.values(SLAB_TIERS_V_ADL),
    ...Object.values(SLAB_TIERS_V_SETDEXPOOL),
  ];
  const tierBySize = new Map<number, { dataSize: number; maxAccounts: number }>();
  for (const tier of ALL_TIERS_RAW) {
    const existing = tierBySize.get(tier.dataSize);
    if (!existing || tier.maxAccounts > existing.maxAccounts) {
      tierBySize.set(tier.dataSize, tier);
    }
  }
  const ALL_TIERS = [...tierBySize.values()];
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

  const maxTierQueries = options.maxTierQueries ?? ALL_TIERS.length;
  const tiersToQuery = ALL_TIERS.slice(0, maxTierQueries);

  // Avoid accidental `0`/negative or NaN causing infinite loops.
  const effectiveMaxParallelTiers = Math.max(1, Number.isFinite(maxParallelTiers) ? maxParallelTiers : 6);

  try {
    if (sequential) {
      // PERC-1650: sequential mode — one tier at a time with inter-tier spacing + per-tier 429 retry.
      for (let i = 0; i < tiersToQuery.length; i++) {
        const tier = tiersToQuery[i];
        const entries = await fetchTierWithRetry(tier);
        rawAccounts.push(...entries);
        if (i < tiersToQuery.length - 1) {
          await new Promise(r => setTimeout(r, interTierDelayMs));
        }
      }
    } else {
      // Parallel mode: cap tier concurrency so we don't fire 20+ large
      // getProgramAccounts calls at once from a single client call.
      for (let offset = 0; offset < tiersToQuery.length; offset += effectiveMaxParallelTiers) {
        const chunk = tiersToQuery.slice(offset, offset + effectiveMaxParallelTiers);
        const queries = chunk.map(tier =>
          connection.getProgramAccounts(programId, {
            filters: [{ dataSize: tier.dataSize }],
            dataSlice: { offset: 0, length: HEADER_SLICE_LENGTH },
          }).then(results =>
            results.map(entry => ({
              ...entry,
              maxAccounts: tier.maxAccounts,
              dataSize: tier.dataSize,
            })),
          ),
        );

        const results = await Promise.allSettled(queries);
        for (const result of results) {
          if (result.status === "fulfilled") {
            for (const entry of result.value) {
              rawAccounts.push(entry as RawEntry);
            }
          } else {
            console.warn(
              "[discoverMarkets] Tier query rejected:",
              result.reason instanceof Error ? result.reason.message : result.reason,
            );
          }
        }
      }
    }

    // TASK C: Fetch v17 market group accounts via memcmp on the v17 magic bytes.
    // V17 accounts have dynamic sizes and do NOT appear in fixed dataSize tier filters.
    // The memcmp bytes are derived in-code from V17_MAGIC_BYTES (the on-chain LE order) via
    // base64 (web3.js >=1.87) so the filter cannot drift from / mis-order the magic constant.
    try {
      const v17Results = await connection.getProgramAccounts(programId, {
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: Buffer.from(V17_MAGIC_BYTES).toString("base64"),
              encoding: "base64",
            },
          },
        ],
        dataSlice: { offset: 0, length: HEADER_SLICE_LENGTH },
      });
      for (const e of v17Results) {
        rawAccounts.push({ ...e, maxAccounts: 0, dataSize: e.account.data.length } as RawEntry);
      }
    } catch {
      // v17 memcmp query is best-effort — silently ignore failures (RPC may reject getProgramAccounts)
    }

    // NOTE: hadRejection guard removed — dataSize filters silently return 0 when on-chain
    // account size changed; RPC returns no error, so we must fallback on empty results too.
    if (rawAccounts.length === 0) {
      console.warn("[discoverMarkets] dataSize filters returned 0 markets, falling back to memcmp");
      // PR #183 / PR #166: fetch full account data (no dataSlice) so detectSlabLayout can
      // identify the actual tier from account.data.length instead of hardcoding large/4096.
      const fallback = await connection.getProgramAccounts(programId, {
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: "F6P2QNqpQV5", // base58 of TALOCREP (u64 LE magic)
            },
          },
        ],
      });
      rawAccounts = [...fallback].map(e => {
        const len = e.account.data.length;
        const lay = detectSlabLayout(len, new Uint8Array(e.account.data));
        return { ...e, maxAccounts: lay?.maxAccounts ?? 4096, dataSize: len };
      }) as RawEntry[];
    }
  } catch (err) {
    console.warn(
      "[discoverMarkets] dataSize filters failed, falling back to memcmp:",
      err instanceof Error ? err.message : err,
    );
    try {
      // PR #183 / PR #166: same full-data fetch as the empty-result fallback above.
      const fallback = await connection.getProgramAccounts(programId, {
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: "F6P2QNqpQV5", // base58 of TALOCREP (u64 LE magic)
            },
          },
        ],
      });
      rawAccounts = [...fallback].map(e => {
        const len = e.account.data.length;
        const lay = detectSlabLayout(len, new Uint8Array(e.account.data));
        return { ...e, maxAccounts: lay?.maxAccounts ?? 4096, dataSize: len };
      }) as RawEntry[];
    } catch (memcmpErr) {
      // GH#59: memcmp also rejected (public mainnet RPCs reject all getProgramAccounts)
      console.warn(
        "[discoverMarkets] memcmp fallback also failed:",
        memcmpErr instanceof Error ? memcmpErr.message : memcmpErr,
      );
    }
  }

  // GH#59 / PERC-8424: If getProgramAccounts returned nothing (public mainnet RPC
  // rejects it) and an API base URL is configured, fall back to the REST API to
  // discover slab addresses, then use getMarketsByAddress (getMultipleAccounts).
  if (rawAccounts.length === 0 && options.apiBaseUrl) {
    console.warn(
      "[discoverMarkets] RPC discovery returned 0 markets, falling back to REST API",
    );
    try {
      const apiResult = await discoverMarketsViaApi(
        connection,
        programId,
        options.apiBaseUrl,
        { timeoutMs: options.apiTimeoutMs },
      );
      if (apiResult.length > 0) {
        return apiResult;
      }
      // API returned 0 markets — fall through to tier 3
      console.warn(
        "[discoverMarkets] REST API returned 0 markets, checking tier-3 static bundle",
      );
    } catch (apiErr) {
      console.warn(
        "[discoverMarkets] API fallback also failed:",
        apiErr instanceof Error ? apiErr.message : apiErr,
      );
      // Fall through to tier 3
    }
  }

  // PERC-8435: Tier 3 — static bundle fallback.  If both getProgramAccounts and
  // the REST API failed (or returned 0 results) and a network hint is provided,
  // use the bundled static market list as a last-resort address directory.
  if (rawAccounts.length === 0 && options.network) {
    const staticEntries = getStaticMarkets(options.network);
    if (staticEntries.length > 0) {
      console.warn(
        `[discoverMarkets] Tier 1+2 failed, falling back to static bundle (${staticEntries.length} addresses for ${options.network})`,
      );
      try {
        return await discoverMarketsViaStaticBundle(
          connection,
          programId,
          staticEntries,
        );
      } catch (staticErr) {
        console.warn(
          "[discoverMarkets] Static bundle fallback also failed:",
          staticErr instanceof Error ? staticErr.message : staticErr,
        );
        // Fall through to return empty array
      }
    } else {
      console.warn(
        `[discoverMarkets] Static bundle has 0 entries for ${options.network} — skipping tier 3`,
      );
    }
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

    // Check for v17 market group account (magic = "PERCV16\0", kind == KIND_MARKET).
    // The data slice is HEADER_SLICE_LENGTH=1940 bytes, which exceeds the 512-byte
    // minimum needed by parseWrapperConfigV17 (post-protocol-fee; was 448). V17 accounts have dynamic sizes and
    // do NOT appear in the fixed-size tier queries; they reach this loop only via the
    // memcmp fallback or if the account happens to match a tier size by coincidence.
    // #264: gate on isV17MarketAccount (kind byte @10 == 1) so portfolio/ledger/
    // registry accounts — which share the magic+version but carry no WrapperConfigV16
    // — are not mis-parsed as markets.
    {
      const unknownV = unknownMarketVersion(data);
      if (unknownV !== null) {
        console.warn(`[discoverMarkets] skipping ${pkStr}: wrapper VERSION ${unknownV} is not a layout this SDK knows (decodes ${knownWrapperVersions().join(", ")})`);
        continue;
      }
    }
    if (isV17MarketAccount(data)) {
      try {
        const configV17 = parseWrapperConfigV17(data);
        markets.push({
          wrapperVersion: new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(8, true),
          slabAddress: pubkey,
          programId,
          header: {} as SlabHeader,
          config: {} as MarketConfig,
          engine: {} as EngineState,
          params: {} as RiskParams,
          configV17,
        });
      } catch (err) {
        console.warn(
          `[discoverMarkets] Failed to parse v17 account ${pkStr}:`,
          err instanceof Error ? err.message : err,
        );
      }
      continue;
    }

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

    if (!layout) {
      console.warn(
        `[discoverMarkets] Skipping account ${pkStr}: unrecognized layout for dataSize=${dataSize}`,
      );
      continue;
    }

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

/**
 * Options for `getMarketsByAddress`.
 */
export interface GetMarketsByAddressOptions {
  /**
   * Maximum number of addresses per `getMultipleAccounts` RPC call.
   * Solana limits a single call to 100 accounts; callers may lower this
   * to reduce per-request payload size or avoid 429s.
   *
   * Default: 100 (Solana maximum).
   */
  batchSize?: number;

  /**
   * Delay in ms between batches when the address list exceeds `batchSize`.
   * Helps avoid rate-limiting on public RPCs.
   *
   * Default: 0 (no delay).
   */
  interBatchDelayMs?: number;
}

/**
 * Fetch and parse Percolator markets by their known slab addresses.
 *
 * Unlike `discoverMarkets()` — which uses `getProgramAccounts` and is blocked
 * on public mainnet RPCs — this function uses `getMultipleAccounts`, which works
 * on any RPC endpoint (including `api.mainnet-beta.solana.com`).
 *
 * Callers must already know the market slab addresses (e.g. from an indexer,
 * a hardcoded registry, or a previous `discoverMarkets` call on a permissive RPC).
 *
 * @param connection - Solana RPC connection
 * @param programId - The Percolator program that owns these slabs
 * @param addresses - Array of slab account public keys to fetch
 * @param options   - Optional batching/delay configuration
 * @returns Parsed markets for all valid slab accounts; invalid/missing accounts are silently skipped.
 *
 * @example
 * ```ts
 * import { getMarketsByAddress, getProgramId } from "@percolator/sdk";
 * import { Connection, PublicKey } from "@solana/web3.js";
 *
 * const connection = new Connection("https://api.mainnet-beta.solana.com");
 * const programId = getProgramId("mainnet");
 * const slabs = [
 *   new PublicKey("So11111111111111111111111111111111111111112"),
 *   // ... more known slab addresses
 * ];
 *
 * const markets = await getMarketsByAddress(connection, programId, slabs);
 * console.log(`Found ${markets.length} markets`);
 * ```
 */
export async function getMarketsByAddress(
  connection: Connection,
  programId: PublicKey,
  addresses: PublicKey[],
  options: GetMarketsByAddressOptions = {},
): Promise<DiscoveredMarket[]> {
  if (addresses.length === 0) return [];

  const {
    batchSize = 100,
    interBatchDelayMs = 0,
  } = options;

  const effectiveBatchSize = Math.max(1, Math.min(batchSize, 100));

  // Fetch account data in batches (Solana caps getMultipleAccounts at 100)
  type AccountResult = { pubkey: PublicKey; data: Buffer | Uint8Array } | null;
  const fetched: AccountResult[] = [];

  for (let offset = 0; offset < addresses.length; offset += effectiveBatchSize) {
    const batch = addresses.slice(offset, offset + effectiveBatchSize);

    const response = await connection.getMultipleAccountsInfo(batch);

    for (let i = 0; i < batch.length; i++) {
      const info = response[i];
      if (info && info.data) {
        if (!info.owner.equals(programId)) {
          console.warn(
            `[getMarketsByAddress] Skipping ${batch[i].toBase58()}: owner mismatch ` +
            `(expected ${programId.toBase58()}, got ${info.owner.toBase58()})`,
          );
          continue;
        }
        fetched.push({ pubkey: batch[i], data: info.data });
      }
    }

    // Inter-batch delay to avoid rate-limiting
    if (interBatchDelayMs > 0 && offset + effectiveBatchSize < addresses.length) {
      await new Promise(r => setTimeout(r, interBatchDelayMs));
    }
  }

  // Parse each account into a DiscoveredMarket
  const markets: DiscoveredMarket[] = [];

  for (const entry of fetched) {
    if (!entry) continue;
    const { pubkey, data: rawData } = entry;
    const data = new Uint8Array(rawData);

    // Gate: check for a v17 MARKET account first, then fall through to v12 slab path.
    // #264: gate on isV17MarketAccount (kind byte @10 == 1) — portfolio/ledger/registry
    // accounts share the magic+version but are not markets and carry no WrapperConfigV16.
    {
      const unknownV = unknownMarketVersion(data);
      if (unknownV !== null) {
        console.warn(`[getMarketsByAddress] skipping ${pubkey.toBase58()}: wrapper VERSION ${unknownV} is not a layout this SDK knows (decodes ${knownWrapperVersions().join(", ")})`);
        continue;
      }
    }
    if (isV17MarketAccount(data)) {
      try {
        const configV17 = parseWrapperConfigV17(data);
        // v17 accounts have no slab header/config/engine/params; supply defaults so
        // the DiscoveredMarket type is satisfied. Callers should check configV17 !== undefined
        // to detect a v17 market.
        markets.push({
          wrapperVersion: new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(8, true),
          slabAddress: pubkey,
          programId,
          header: {} as SlabHeader,
          config: {} as MarketConfig,
          engine: {} as EngineState,
          params: {} as RiskParams,
          configV17,
        });
      } catch (err) {
        console.warn(
          `[getMarketsByAddress] Failed to parse v17 account ${pubkey.toBase58()}:`,
          err instanceof Error ? err.message : err,
        );
      }
      continue;
    }

    // Validate v12 magic bytes
    let valid = true;
    for (let i = 0; i < MAGIC_BYTES.length; i++) {
      if (data[i] !== MAGIC_BYTES[i]) {
        valid = false;
        break;
      }
    }
    if (!valid) {
      console.warn(
        `[getMarketsByAddress] Skipping ${pubkey.toBase58()}: invalid magic bytes`,
      );
      continue;
    }

    // Detect layout from full account data length
    const layout = detectSlabLayout(data.length, data);
    if (!layout) {
      console.warn(
        `[getMarketsByAddress] Skipping ${pubkey.toBase58()}: unrecognized layout for dataSize=${data.length}`,
      );
      continue;
    }

    try {
      const header = parseHeader(data);
      const config = parseConfig(data, layout);
      const engine = parseEngineLight(data, layout, layout.maxAccounts);
      const params = parseParams(data, layout);

      markets.push({ slabAddress: pubkey, programId, header, config, engine, params });
    } catch (err) {
      console.warn(
        `[getMarketsByAddress] Failed to parse account ${pubkey.toBase58()}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return markets;
}

// ---------------------------------------------------------------------------
// REST API-based market discovery (GH#59 / PERC-8424)
// ---------------------------------------------------------------------------

/**
 * Shape of a single market entry returned by the Percolator REST API
 * (`GET /markets`).  Only the fields needed for discovery are typed here;
 * the full API response may contain additional statistics fields.
 */
export interface ApiMarketEntry {
  slab_address: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  status?: string;
  [key: string]: unknown;
}

/** Options for {@link discoverMarketsViaApi}. */
export interface DiscoverMarketsViaApiOptions {
  /**
   * Timeout in ms for the HTTP request to the REST API.
   * Default: 10_000 (10 seconds).
   */
  timeoutMs?: number;

  /**
   * Options forwarded to {@link getMarketsByAddress} for the on-chain fetch
   * step (batch size, inter-batch delay).
   */
  onChainOptions?: GetMarketsByAddressOptions;
}

/**
 * Discover Percolator markets by first querying the REST API for slab addresses,
 * then fetching full on-chain data via `getMarketsByAddress` (which uses
 * `getMultipleAccounts` — works on all RPCs including public mainnet nodes).
 *
 * This is the recommended discovery path for mainnet users who do not have a
 * Helius API key, since `getProgramAccounts` is rejected by public RPCs.
 *
 * The REST API acts as an address directory only — all market data is verified
 * on-chain via `getMarketsByAddress`, so the caller gets the same
 * `DiscoveredMarket[]` result as `discoverMarkets()`.
 *
 * @param connection - Solana RPC connection (any endpoint, including public)
 * @param programId - The Percolator program that owns the slabs
 * @param apiBaseUrl - Base URL of the Percolator REST API
 *                     (e.g. `"https://percolatorlaunch.com/api"`)
 * @param options - Optional timeout and on-chain fetch configuration
 * @returns Parsed markets for all valid slab accounts discovered via the API
 *
 * @example
 * ```ts
 * import { discoverMarketsViaApi, getProgramId } from "@percolator/sdk";
 * import { Connection } from "@solana/web3.js";
 *
 * const connection = new Connection("https://api.mainnet-beta.solana.com");
 * const programId = getProgramId("mainnet");
 * const markets = await discoverMarketsViaApi(
 *   connection,
 *   programId,
 *   "https://percolatorlaunch.com/api",
 * );
 * console.log(`Discovered ${markets.length} markets via API fallback`);
 * ```
 */
export async function discoverMarketsViaApi(
  connection: Connection,
  programId: PublicKey,
  apiBaseUrl: string,
  options: DiscoverMarketsViaApiOptions = {},
): Promise<DiscoveredMarket[]> {
  const { timeoutMs = 10_000, onChainOptions } = options;

  // Normalise base URL — strip trailing slash to avoid double-slash in path
  const base = apiBaseUrl.replace(/\/+$/, "");
  const url = `${base}/markets`;

  // Fetch market list from REST API
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(
      `[discoverMarketsViaApi] API returned ${response.status} ${response.statusText} from ${url}`,
    );
  }

  const body = (await response.json()) as { markets?: ApiMarketEntry[] };
  const apiMarkets = body.markets;

  if (!Array.isArray(apiMarkets) || apiMarkets.length === 0) {
    console.warn("[discoverMarketsViaApi] API returned 0 markets");
    return [];
  }

  // Extract valid slab addresses
  const addresses: PublicKey[] = [];
  for (const entry of apiMarkets) {
    if (!entry.slab_address || typeof entry.slab_address !== "string") continue;
    try {
      addresses.push(new PublicKey(entry.slab_address));
    } catch {
      console.warn(
        `[discoverMarketsViaApi] Skipping invalid slab address: ${entry.slab_address}`,
      );
    }
  }

  if (addresses.length === 0) {
    console.warn("[discoverMarketsViaApi] No valid slab addresses from API");
    return [];
  }

  console.log(
    `[discoverMarketsViaApi] API returned ${addresses.length} slab addresses, fetching on-chain data`,
  );

  // Fetch full on-chain data via getMultipleAccounts (works on all RPCs)
  return getMarketsByAddress(connection, programId, addresses, onChainOptions);
}

// ---------------------------------------------------------------------------
// Static bundle fallback (PERC-8435 — tier 3)
// ---------------------------------------------------------------------------

/** Options for {@link discoverMarketsViaStaticBundle}. */
export interface DiscoverMarketsViaStaticBundleOptions {
  /**
   * Options forwarded to {@link getMarketsByAddress} for the on-chain fetch
   * step (batch size, inter-batch delay).
   */
  onChainOptions?: GetMarketsByAddressOptions;
}

/**
 * Discover Percolator markets from a static list of known slab addresses.
 *
 * This is the tier-3 (last-resort) fallback for `discoverMarkets()`.  It uses
 * a bundled list of known slab addresses and fetches their full account data
 * on-chain via `getMarketsByAddress` (`getMultipleAccounts` — works on all RPCs).
 *
 * The static list acts as an address directory only — all market data is verified
 * on-chain, so stale entries are silently skipped (the account won't have valid
 * magic bytes or will have been closed).
 *
 * @param connection - Solana RPC connection (any endpoint)
 * @param programId - The Percolator program that owns the slabs
 * @param entries   - Static market entries (typically from {@link getStaticMarkets})
 * @param options   - Optional on-chain fetch configuration
 * @returns Parsed markets for all valid slab accounts; stale/missing entries are skipped.
 *
 * @example
 * ```ts
 * import {
 *   discoverMarketsViaStaticBundle,
 *   getStaticMarkets,
 *   getProgramId,
 * } from "@percolator/sdk";
 * import { Connection } from "@solana/web3.js";
 *
 * const connection = new Connection("https://api.mainnet-beta.solana.com");
 * const programId = getProgramId("mainnet");
 * const entries = getStaticMarkets("mainnet");
 *
 * const markets = await discoverMarketsViaStaticBundle(
 *   connection,
 *   programId,
 *   entries,
 * );
 * console.log(`Recovered ${markets.length} markets from static bundle`);
 * ```
 */
export async function discoverMarketsViaStaticBundle(
  connection: Connection,
  programId: PublicKey,
  entries: StaticMarketEntry[],
  options: DiscoverMarketsViaStaticBundleOptions = {},
): Promise<DiscoveredMarket[]> {
  if (entries.length === 0) return [];

  // Extract valid slab addresses from static entries
  const addresses: PublicKey[] = [];
  for (const entry of entries) {
    if (!entry.slabAddress || typeof entry.slabAddress !== "string") continue;
    try {
      addresses.push(new PublicKey(entry.slabAddress));
    } catch {
      console.warn(
        `[discoverMarketsViaStaticBundle] Skipping invalid slab address: ${entry.slabAddress}`,
      );
    }
  }

  if (addresses.length === 0) {
    console.warn("[discoverMarketsViaStaticBundle] No valid slab addresses in static bundle");
    return [];
  }

  console.log(
    `[discoverMarketsViaStaticBundle] Fetching ${addresses.length} slab addresses on-chain`,
  );

  return getMarketsByAddress(connection, programId, addresses, options.onChainOptions);
}
