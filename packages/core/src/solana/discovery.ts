import { Connection, PublicKey } from "@solana/web3.js";
import {
  parseHeader,
  parseConfig,
  parseParams,
  type SlabHeader,
  type MarketConfig,
  type EngineState,
  type RiskParams,
} from "./slab.js";

/** Bitmap offset within engine struct (updated for PERC-120/121/122 struct changes) */
const ENGINE_BITMAP_OFF = 632; // Updated for PERC-299 (608 + 24 emergency OI fields)

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
 * Layout: HEADER(104) + CONFIG(384) + RiskEngine(variable by tier)
 *   ENGINE_OFF = align_up(104 + 384, 8) = 488  (SBF: u128 align = 8)
 *   RiskEngine = fixed(608) + bitmap(BW*8) + post_bitmap(18) + next_free(N*2) + pad + accounts(N*248)
 *
 * NOTE: PERC-300 grew CONFIG_LEN from 368→384 (adaptive funding rate fields).
 *       ENGINE_OFF shifted from 472→488.
 *       RiskEngine grew by 32 bytes (PERC-298: long_oi + short_oi U128 fields) + 24 (PERC-299: emergency OI).
 *       Values below must be verified against BPF build before deployment.
 */
export const SLAB_TIERS = {
  small:  { maxAccounts: 256,  dataSize: 65_176,    label: "Small",  description: "256 slots · ~0.45 SOL" },
  medium: { maxAccounts: 1024, dataSize: 257_272,   label: "Medium", description: "1,024 slots · ~1.79 SOL" },
  large:  { maxAccounts: 4096, dataSize: 1_025_656, label: "Large",  description: "4,096 slots · ~7.14 SOL" },
} as const;

export type SlabTierKey = keyof typeof SLAB_TIERS;

/** Calculate slab data size for arbitrary account count.
 *
 * Layout (SBF, u128 align = 8):
 *   HEADER(104) + CONFIG(384) → ENGINE_OFF = 488
 *   RiskEngine fixed scalars: 632 bytes (PERC-299: +24 emergency OI, +32 long/short OI)
 *   + bitmap: ceil(N/64)*8
 *   + num_used_accounts(u16) + pad(6) + next_account_id(u64) + free_head(u16) = 18
 *   + next_free: N*2
 *   + pad to 8-byte alignment for Account array
 *   + accounts: N*248
 *
 * Must match the on-chain program's SLAB_LEN exactly.
 */
export function slabDataSize(maxAccounts: number): number {
  const ENGINE_OFF_LOCAL = 488; // align_up(104 + 384, 8) — PERC-300
  const ENGINE_FIXED = 632;     // scalars before bitmap (608 + 24 for PERC-299 emergency OI fields)
  const ACCOUNT_SIZE = 248;
  const bitmapBytes = Math.ceil(maxAccounts / 64) * 8;
  // After bitmap: num_used(u16,2) + pad(6) + next_account_id(u64,8) + free_head(u16,2) = 18
  const postBitmap = 18;
  const nextFreeBytes = maxAccounts * 2;
  const preAccountsLen = ENGINE_FIXED + bitmapBytes + postBitmap + nextFreeBytes;
  // Align to 8 bytes for Account (max field align = 8 on SBF)
  const accountsOff = Math.ceil(preAccountsLen / 8) * 8;
  return ENGINE_OFF_LOCAL + accountsOff + maxAccounts * ACCOUNT_SIZE;
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

/** All known slab data sizes for discovery */
const ALL_SLAB_SIZES = Object.values(SLAB_TIERS).map(t => t.dataSize);

/** Legacy constant for backward compat */
const SLAB_DATA_SIZE = SLAB_TIERS.large.dataSize;

/** We need header(104) + config(368) + engine up to nextAccountId (~1100). Total ~1572. Use 1600 for margin. */
const HEADER_SLICE_LENGTH = 1600;

const ENGINE_OFF = 488; // PERC-300: CONFIG_LEN grew 368→384

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
 * @param maxAccounts — the tier's max accounts (256/1024/4096) to compute correct bitmap offsets
 */
function parseEngineLight(data: Uint8Array, maxAccounts: number = 4096): EngineState {
  const base = ENGINE_OFF;
  const minLen = base + ENGINE_BITMAP_OFF; // need at least fixed engine fields
  if (data.length < minLen) {
    throw new Error(`Slab data too short for engine light parse: ${data.length} < ${minLen}`);
  }

  // Compute tier-dependent offsets for numUsedAccounts and nextAccountId
  const bitmapWords = Math.ceil(maxAccounts / 64);
  const numUsedOff = ENGINE_BITMAP_OFF + bitmapWords * 8; // u16 right after bitmap
  const nextAccountIdOff = Math.ceil((numUsedOff + 2) / 8) * 8; // u64, 8-byte aligned

  // Check if the partial slice is long enough to read these fields
  const canReadNumUsed = data.length >= base + numUsedOff + 2;
  const canReadNextId = data.length >= base + nextAccountIdOff + 8;

  // Engine field offsets within engine struct (updated for PERC-120/121/122):
  // vault(0) + insurance(16,32) + params(48,288) + currentSlot(336) + fundingIndex(344,16)
  // + lastFundingSlot(360) + fundingRateBps(368) + markPrice(376) + fundingFrozen(384,8)
  // + frozenRate(392) + lastCrankSlot(400) + maxCrankStaleness(408) + totalOI(416,16)
  // + longOi(432,16) + shortOi(448,16) [PERC-298]
  // + cTot(464,16) + pnlPosTot(480,16) + liqCursor(496,2) + gcCursor(498,2)
  // + lastSweepStart(504) + lastSweepComplete(512) + crankCursor(520,2) + sweepStartIdx(522,2)
  // + lifetimeLiquidations(528) + lifetimeForceCloses(536)
  // + netLpPos(544,16) + lpSumAbs(560,16) + lpMaxAbs(576,16) + lpMaxAbsSweep(592,16)
  // + emergencyOiMode(608,1+7pad) + emergencyStartSlot(616,8) + lastBreakerSlot(624,8)
  // + bitmap(632)
  return {
    vault: readU128LE(data, base + 0),
    insuranceFund: {
      balance: readU128LE(data, base + 16),
      feeRevenue: readU128LE(data, base + 32),
    },
    currentSlot: readU64LE(data, base + 336),
    fundingIndexQpbE6: readI128LE(data, base + 344),
    lastFundingSlot: readU64LE(data, base + 360),
    fundingRateBpsPerSlotLast: readI64LE(data, base + 368),
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
  // Query all known slab sizes in parallel to discover markets of any tier
  // Track which tier each account belongs to for correct offset computation
  const ALL_TIERS = Object.values(SLAB_TIERS);
  let rawAccounts: { pubkey: PublicKey; account: { data: Buffer | Uint8Array }; maxAccounts: number }[] = [];
  try {
    const queries = ALL_TIERS.map(tier =>
      connection.getProgramAccounts(programId, {
        filters: [{ dataSize: tier.dataSize }],
        dataSlice: { offset: 0, length: HEADER_SLICE_LENGTH },
      }).then(results => results.map(entry => ({ ...entry, maxAccounts: tier.maxAccounts })))
    );
    const results = await Promise.allSettled(queries);
    let hadRejection = false;
    for (const result of results) {
      if (result.status === "fulfilled") {
        for (const entry of result.value) {
          rawAccounts.push(entry as { pubkey: PublicKey; account: { data: Buffer | Uint8Array }; maxAccounts: number });
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
      rawAccounts = [...fallback].map(e => ({ ...e, maxAccounts: 4096 })) as { pubkey: PublicKey; account: { data: Buffer | Uint8Array }; maxAccounts: number }[];
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
    rawAccounts = [...fallback].map(e => ({ ...e, maxAccounts: 4096 })) as { pubkey: PublicKey; account: { data: Buffer | Uint8Array }; maxAccounts: number }[];
  }
  const accounts = rawAccounts;

  const markets: DiscoveredMarket[] = [];

  for (const { pubkey, account, maxAccounts } of accounts) {
    const data = new Uint8Array(account.data);

    let valid = true;
    for (let i = 0; i < MAGIC_BYTES.length; i++) {
      if (data[i] !== MAGIC_BYTES[i]) {
        valid = false;
        break;
      }
    }
    if (!valid) continue;

    try {
      const header = parseHeader(data);
      const config = parseConfig(data);
      const engine = parseEngineLight(data, maxAccounts);
      const params = parseParams(data);

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
