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

/**
 * A discovered Percolator market from on-chain program accounts.
 */
export interface DiscoveredMarket {
  slabAddress: PublicKey;
  header: SlabHeader;
  config: MarketConfig;
  engine: EngineState;
  params: RiskParams;
}

/** PERCOLAT magic bytes */
const MAGIC_BYTES = new Uint8Array([0x50, 0x45, 0x52, 0x43, 0x4f, 0x4c, 0x41, 0x54]);

/** Full slab size */
const SLAB_DATA_SIZE = 992_560;

/** We need header(72) + config(320) + engine up to nextAccountId (928+8). Total ~1328. Use 1400 for margin. */
const HEADER_SLICE_LENGTH = 1400;

const ENGINE_OFF = 392;

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
 */
function parseEngineLight(data: Uint8Array): EngineState {
  const base = ENGINE_OFF;
  const minLen = base + 936;
  if (data.length < minLen) {
    throw new Error(`Slab data too short for engine light parse: ${data.length} < ${minLen}`);
  }

  return {
    vault: readU128LE(data, base + 0),
    insuranceFund: {
      balance: readU128LE(data, base + 16),
      feeRevenue: readU128LE(data, base + 32),
    },
    currentSlot: readU64LE(data, base + 192),
    fundingIndexQpbE6: readI128LE(data, base + 200),
    lastFundingSlot: readU64LE(data, base + 216),
    fundingRateBpsPerSlotLast: readI64LE(data, base + 224),
    lastCrankSlot: readU64LE(data, base + 232),
    maxCrankStalenessSlots: readU64LE(data, base + 240),
    totalOpenInterest: readU128LE(data, base + 248),
    cTot: readU128LE(data, base + 264),
    pnlPosTot: readU128LE(data, base + 280),
    liqCursor: readU16LE(data, base + 296),
    gcCursor: readU16LE(data, base + 298),
    lastSweepStartSlot: readU64LE(data, base + 304),
    lastSweepCompleteSlot: readU64LE(data, base + 312),
    crankCursor: readU16LE(data, base + 320),
    sweepStartIdx: readU16LE(data, base + 322),
    lifetimeLiquidations: readU64LE(data, base + 328),
    lifetimeForceCloses: readU64LE(data, base + 336),
    netLpPos: readI128LE(data, base + 344),
    lpSumAbs: readU128LE(data, base + 360),
    lpMaxAbs: readU128LE(data, base + 376),
    lpMaxAbsSweep: readU128LE(data, base + 392),
    numUsedAccounts: readU16LE(data, base + 920),
    nextAccountId: readU64LE(data, base + 928),
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
  let accounts;
  try {
    accounts = await connection.getProgramAccounts(programId, {
      filters: [{ dataSize: SLAB_DATA_SIZE }],
      dataSlice: { offset: 0, length: HEADER_SLICE_LENGTH },
    });
  } catch (err) {
    console.warn(
      "[discoverMarkets] dataSize filter failed, falling back to memcmp:",
      err instanceof Error ? err.message : err,
    );
    accounts = await connection.getProgramAccounts(programId, {
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: "ERjBEaJzTfy", // base58 of PERCOLAT (8 bytes)
          },
        },
      ],
      dataSlice: { offset: 0, length: HEADER_SLICE_LENGTH },
    });
  }

  const markets: DiscoveredMarket[] = [];

  for (const { pubkey, account } of accounts) {
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
      const engine = parseEngineLight(data);
      const params = parseParams(data);

      markets.push({ slabAddress: pubkey, header, config, engine, params });
    } catch (err) {
      console.warn(
        `[discoverMarkets] Failed to parse account ${pubkey.toBase58()}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return markets;
}
