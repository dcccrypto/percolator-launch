import { PublicKey } from "@solana/web3.js";
import {
  PUMPSWAP_PROGRAM_ID,
  RAYDIUM_CLMM_PROGRAM_ID,
  METEORA_DLMM_PROGRAM_ID,
} from "./pda.js";

export type DexType = "pumpswap" | "raydium-clmm" | "meteora-dlmm";

export interface DexPoolInfo {
  dexType: DexType;
  poolAddress: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseVault?: PublicKey;  // PumpSwap only
  quoteVault?: PublicKey; // PumpSwap only
}

/**
 * Detect DEX type from the program that owns the pool account.
 * Returns null if the owner is not a supported DEX program.
 */
export function detectDexType(ownerProgramId: PublicKey): DexType | null {
  if (ownerProgramId.equals(PUMPSWAP_PROGRAM_ID)) return "pumpswap";
  if (ownerProgramId.equals(RAYDIUM_CLMM_PROGRAM_ID)) return "raydium-clmm";
  if (ownerProgramId.equals(METEORA_DLMM_PROGRAM_ID)) return "meteora-dlmm";
  return null;
}

/**
 * Parse a DEX pool account into a DexPoolInfo struct.
 */
export function parseDexPool(
  dexType: DexType,
  poolAddress: PublicKey,
  data: Uint8Array,
): DexPoolInfo {
  switch (dexType) {
    case "pumpswap":
      return parsePumpSwapPool(poolAddress, data);
    case "raydium-clmm":
      return parseRaydiumClmmPool(poolAddress, data);
    case "meteora-dlmm":
      return parseMeteoraPool(poolAddress, data);
  }
}

/**
 * Compute the spot price from a DEX pool in e6 format.
 *
 * For PumpSwap, vaultData must be provided (base and quote vault account data).
 * For Raydium CLMM and Meteora DLMM, only pool data is needed.
 */
export function computeDexSpotPriceE6(
  dexType: DexType,
  data: Uint8Array,
  vaultData?: { base: Uint8Array; quote: Uint8Array },
): bigint {
  switch (dexType) {
    case "pumpswap":
      return computePumpSwapPriceE6(data, vaultData!);
    case "raydium-clmm":
      return computeRaydiumClmmPriceE6(data);
    case "meteora-dlmm":
      return computeMeteoraDlmmPriceE6(data);
  }
}

// ============================================================================
// PumpSwap
// ============================================================================

function parsePumpSwapPool(poolAddress: PublicKey, data: Uint8Array): DexPoolInfo {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    dexType: "pumpswap",
    poolAddress,
    baseMint: new PublicKey(data.slice(35, 67)),
    quoteMint: new PublicKey(data.slice(67, 99)),
    baseVault: new PublicKey(data.slice(131, 163)),
    quoteVault: new PublicKey(data.slice(163, 195)),
  };
}

function computePumpSwapPriceE6(
  _poolData: Uint8Array,
  vaultData: { base: Uint8Array; quote: Uint8Array },
): bigint {
  const baseDv = new DataView(vaultData.base.buffer, vaultData.base.byteOffset, vaultData.base.byteLength);
  const quoteDv = new DataView(vaultData.quote.buffer, vaultData.quote.byteOffset, vaultData.quote.byteLength);

  // SPL token amount at offset 64 (u64 LE)
  const baseAmount = readU64LE(baseDv, 64);
  const quoteAmount = readU64LE(quoteDv, 64);

  if (baseAmount === 0n) return 0n;
  return (quoteAmount * 1_000_000n) / baseAmount;
}

// ============================================================================
// Raydium CLMM
// ============================================================================

function parseRaydiumClmmPool(poolAddress: PublicKey, data: Uint8Array): DexPoolInfo {
  return {
    dexType: "raydium-clmm",
    poolAddress,
    baseMint: new PublicKey(data.slice(73, 105)),
    quoteMint: new PublicKey(data.slice(105, 137)),
  };
}

function computeRaydiumClmmPriceE6(data: Uint8Array): bigint {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const decimals0 = data[233];
  const decimals1 = data[234];

  // sqrt_price_x64 is u128 at offset 253
  const sqrtPriceX64 = readU128LE(dv, 253);

  if (sqrtPriceX64 === 0n) return 0n;

  // price_e6 = sqrt^2 * 10^(6 + d0 - d1) / 2^128
  // Split computation to avoid overflow:
  // term1 = sqrtHi * sqrt (where sqrtHi = sqrt >> 64)
  // price_e6 = term1 * scale / 2^64
  const sqrtHi = sqrtPriceX64 >> 64n;
  const term1 = sqrtHi * sqrtPriceX64;

  const decimalDiff = 6 + decimals0 - decimals1;

  if (decimalDiff >= 0) {
    const scale = 10n ** BigInt(decimalDiff);
    return (term1 * scale) >> 64n;
  } else {
    const scale = 10n ** BigInt(-decimalDiff);
    return (term1 >> 64n) / scale;
  }
}

// ============================================================================
// Meteora DLMM
// ============================================================================

function parseMeteoraPool(poolAddress: PublicKey, data: Uint8Array): DexPoolInfo {
  return {
    dexType: "meteora-dlmm",
    poolAddress,
    baseMint: new PublicKey(data.slice(81, 113)),
    quoteMint: new PublicKey(data.slice(113, 145)),
  };
}

function computeMeteoraDlmmPriceE6(data: Uint8Array): bigint {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // bin_step_seed at offset 74 (u16 LE) = bin_step
  const binStep = dv.getUint16(74, true);
  // active_id at offset 77 (i32 LE)
  const activeId = dv.getInt32(77, true);

  if (binStep === 0) return 0n;

  // Price = (1 + binStep/10000) ^ activeId
  // Binary exponentiation in fixed-point (scale = 1e18)
  const SCALE = 1_000_000_000_000_000_000n; // 1e18
  const base = SCALE + (BigInt(binStep) * SCALE) / 10_000n;

  const isNeg = activeId < 0;
  let exp = isNeg ? BigInt(-activeId) : BigInt(activeId);

  let result = SCALE;
  let b = base;

  while (exp > 0n) {
    if (exp & 1n) {
      result = (result * b) / SCALE;
    }
    exp >>= 1n;
    if (exp > 0n) {
      b = (b * b) / SCALE;
    }
  }

  // Convert from 1e18 to 1e6
  if (isNeg) {
    // price = 1/result => SCALE * 1e6 / result
    if (result === 0n) return 0n;
    return (SCALE * 1_000_000n) / result;
  } else {
    return result / 1_000_000_000_000n; // result / 1e12
  }
}

// ============================================================================
// Helpers
// ============================================================================

function readU64LE(dv: DataView, offset: number): bigint {
  const lo = BigInt(dv.getUint32(offset, true));
  const hi = BigInt(dv.getUint32(offset + 4, true));
  return lo | (hi << 32n);
}

function readU128LE(dv: DataView, offset: number): bigint {
  const lo = readU64LE(dv, offset);
  const hi = readU64LE(dv, offset + 8);
  return lo | (hi << 64n);
}
