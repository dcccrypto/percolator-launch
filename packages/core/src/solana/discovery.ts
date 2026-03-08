import { Connection, PublicKey } from "@solana/web3.js";
import {
  parseHeader,
  parseConfig,
  parseParams,
  detectSlabLayout,
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
 * Slab tier definitions.
 * IMPORTANT: dataSize must match the compiled program's SLAB_LEN for that MAX_ACCOUNTS.
 * The on-chain program has a hardcoded SLAB_LEN — slab account data.len() must equal it exactly.
 *
 * Layout: HEADER(104) + CONFIG(536) + RiskEngine(variable by tier)
 *   ENGINE_OFF = align_up(104 + 536, 8) = 640  (SBF: u128 align = 8)
 *   RiskEngine = fixed(656) + bitmap(BW*8) + post_bitmap(18) + next_free(N*2) + pad + accounts(N*248)
 *
 * NOTE: CONFIG_LEN grew 368→384→400→416→432→496→536 across PERC-298 through PERC-328.
 *       PERC-306/307/312/314/315 added 64 bytes (isolation, orphan, safety valve, dispute, LP collateral).
 *       PERC-328 added 40 bytes (_reserved: [u8; 40] for SlabHeader isolation).
 *       ENGINE_OFF = 640 (verified against on-chain compile-time assertion: const _: [(); 536] = [(); CONFIG_LEN]).
 *       RiskEngine grew by 32 bytes (PERC-298: long_oi + short_oi) + 24 (PERC-299: emergency OI).
 *       Values below must be verified against BPF build before deployment.
 */
// V1 sizes (deployed devnet program: HEADER=104, CONFIG=536, ENGINE_OFF=640, ACCOUNT_SIZE=248)
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

/** Calculate slab data size for V1 layout (future program upgrade). */
export function slabDataSizeV1(maxAccounts: number): number {
  const ENGINE_OFF_V1 = 640;
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

/** All known slab data sizes for discovery (V0 + V1 tiers) */
const ALL_SLAB_SIZES = [
  ...Object.values(SLAB_TIERS).map(t => t.dataSize),
  ...Object.values(SLAB_TIERS_V0).map(t => t.dataSize),
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

  // V1 engine struct (future upgrade / V1 slabs): ENGINE_OFF=640
  // vault(0) + insurance(16,48) + params(64,288) + currentSlot(352) + fundingIndex(360,16)
  // + lastFundingSlot(376) + fundingRateBps(384) + markPrice(392) + lastCrankSlot(400)
  // + maxCrankStaleness(408) + totalOI(416,16) + longOi(432,16) + shortOi(448,16)
  // + cTot(464,16) + pnlPosTot(480,16) + liqCursor(496,2) + gcCursor(498,2)
  // + lastSweepStart(504) + lastSweepComplete(512) + crankCursor(520,2) + sweepStartIdx(522,2)
  // + lifetimeLiquidations(528) + lifetimeForceCloses(536)
  // + netLpPos(544,16) + lpSumAbs(560,16) + lpMaxAbs(576,16) + lpMaxAbsSweep(592,16)
  // + emergencyOiMode(608,1+7pad) + emergencyStartSlot(616) + lastBreakerSlot(624) + bitmap(656)
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
    lastCrankSlot: readU64LE(data, base + 400),
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
    markPriceE6: readU64LE(data, base + 392),
    numUsedAccounts: canReadNumUsed ? readU16LE(data, base + numUsedOff) : 0,
    nextAccountId: canReadNextId ? readU64LE(data, base + nextAccountIdOff) : 0n,
  };
}

/**
 * Discover all Percolator markets owned by the given program.
 * Uses getProgramAccounts with dataSize filter + dataSlice to download only ~1400 bytes per slab.
 */
export async function discoverMarkets(
  connection: Connection,
  programId: PublicKey,
): Promise<DiscoveredMarket[]> {
  // Query all known slab sizes in parallel — both V0 (deployed devnet) and V1 (upgraded) tiers.
  // We track the actual dataSize per entry so detectSlabLayout can determine the correct layout,
  // and pass that layout to all parse functions (avoids wrong-version offsets on partial slices).
  const ALL_TIERS = [
    ...Object.values(SLAB_TIERS),
    ...Object.values(SLAB_TIERS_V0),
  ];
  type RawEntry = { pubkey: PublicKey; account: { data: Buffer | Uint8Array }; maxAccounts: number; dataSize: number };
  let rawAccounts: RawEntry[] = [];
  try {
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
    // If any tier queries failed and we found no accounts, fall back to memcmp discovery
    if (hadRejection && rawAccounts.length === 0) {
      console.warn("[discoverMarkets] All tier queries failed, falling back to memcmp");
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

  for (const { pubkey, account, maxAccounts, dataSize } of accounts) {
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
    const layout = detectSlabLayout(dataSize);

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
