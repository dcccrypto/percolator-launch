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
 *
 * @param ownerProgramId - The program ID that owns the pool account
 * @returns The detected DEX type, or `null` if the owner is not a supported DEX program
 *
 * Supported DEX programs:
 * - PumpSwap (constant-product AMM)
 * - Raydium CLMM (concentrated liquidity)
 * - Meteora DLMM (discretized liquidity)
 */
export function detectDexType(ownerProgramId: PublicKey): DexType | null {
  if (ownerProgramId.equals(PUMPSWAP_PROGRAM_ID)) return "pumpswap";
  if (ownerProgramId.equals(RAYDIUM_CLMM_PROGRAM_ID)) return "raydium-clmm";
  if (ownerProgramId.equals(METEORA_DLMM_PROGRAM_ID)) return "meteora-dlmm";
  return null;
}

/**
 * Parse a DEX pool account into a {@link DexPoolInfo} struct.
 *
 * @param dexType - The type of DEX (pumpswap, raydium-clmm, or meteora-dlmm)
 * @param poolAddress - The on-chain address of the pool account
 * @param data - Raw account data bytes
 * @returns Parsed pool info including mints and (for PumpSwap) vault addresses
 * @throws Error if data is too short for the given DEX type
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
 * Compute the spot price from a DEX pool in e6 format (i.e., 1.0 = 1_000_000).
 *
 * **SECURITY NOTE:** DEX spot prices have no staleness or confidence checks and are
 * vulnerable to flash-loan manipulation within a single transaction. For high-value
 * markets, prefer Pyth or Chainlink oracles.
 *
 * @param dexType - The type of DEX
 * @param data - Raw pool account data
 * @param vaultData - For PumpSwap only: base and quote vault account data
 * @returns Price in e6 format (quote per base token)
 * @throws Error if data is too short or computation fails
 */
export function computeDexSpotPriceE6(
  dexType: DexType,
  data: Uint8Array,
  vaultData?: { base: Uint8Array; quote: Uint8Array },
): bigint {
  switch (dexType) {
    case "pumpswap":
      if (!vaultData) throw new Error("PumpSwap requires vaultData (base and quote vault accounts)");
      return computePumpSwapPriceE6(data, vaultData);
    case "raydium-clmm":
      return computeRaydiumClmmPriceE6(data);
    case "meteora-dlmm":
      return computeMeteoraDlmmPriceE6(data);
  }
}

// ============================================================================
// PumpSwap
// ============================================================================

const PUMPSWAP_MIN_LEN = 195;

/**
 * Parse a PumpSwap constant-product AMM pool account.
 * @internal
 */
function parsePumpSwapPool(poolAddress: PublicKey, data: Uint8Array): DexPoolInfo {
  if (data.length < PUMPSWAP_MIN_LEN) {
    throw new Error(`PumpSwap pool data too short: ${data.length} < ${PUMPSWAP_MIN_LEN}`);
  }
  return {
    dexType: "pumpswap",
    poolAddress,
    baseMint: new PublicKey(data.slice(35, 67)),
    quoteMint: new PublicKey(data.slice(67, 99)),
    baseVault: new PublicKey(data.slice(131, 163)),
    quoteVault: new PublicKey(data.slice(163, 195)),
  };
}

const SPL_TOKEN_AMOUNT_MIN_LEN = 72;

/**
 * Compute PumpSwap price: quote_amount * 1e6 / base_amount.
 * @internal
 */
function computePumpSwapPriceE6(
  _poolData: Uint8Array,
  vaultData: { base: Uint8Array; quote: Uint8Array },
): bigint {
  if (vaultData.base.length < SPL_TOKEN_AMOUNT_MIN_LEN) {
    throw new Error(`PumpSwap base vault data too short: ${vaultData.base.length} < ${SPL_TOKEN_AMOUNT_MIN_LEN}`);
  }
  if (vaultData.quote.length < SPL_TOKEN_AMOUNT_MIN_LEN) {
    throw new Error(`PumpSwap quote vault data too short: ${vaultData.quote.length} < ${SPL_TOKEN_AMOUNT_MIN_LEN}`);
  }

  const baseDv = new DataView(vaultData.base.buffer, vaultData.base.byteOffset, vaultData.base.byteLength);
  const quoteDv = new DataView(vaultData.quote.buffer, vaultData.quote.byteOffset, vaultData.quote.byteLength);

  const baseAmount = readU64LE(baseDv, 64);
  const quoteAmount = readU64LE(quoteDv, 64);

  if (baseAmount === 0n) return 0n;
  return (quoteAmount * 1_000_000n) / baseAmount;
}

// ============================================================================
// Raydium CLMM
// ============================================================================

const RAYDIUM_CLMM_MIN_LEN = 269; // need at least through sqrt_price_x64 (253 + 16)

/**
 * Parse a Raydium CLMM (concentrated liquidity) pool account.
 * @internal
 */
function parseRaydiumClmmPool(poolAddress: PublicKey, data: Uint8Array): DexPoolInfo {
  if (data.length < RAYDIUM_CLMM_MIN_LEN) {
    throw new Error(`Raydium CLMM pool data too short: ${data.length} < ${RAYDIUM_CLMM_MIN_LEN}`);
  }
  return {
    dexType: "raydium-clmm",
    poolAddress,
    baseMint: new PublicKey(data.slice(73, 105)),
    quoteMint: new PublicKey(data.slice(105, 137)),
  };
}

/**
 * Compute Raydium CLMM spot price from sqrt_price_x64 (Q64.64 fixed-point).
 *
 * Formula: `price_e6 = (sqrt^2 / 2^128) * 10^(6 + decimals0 - decimals1)`
 *
 * Uses a precision-preserving approach: scales sqrt by 1e6 before shifting,
 * preventing zero results for micro-priced tokens (memecoins where sqrt < 2^64).
 *
 * @internal
 */
function computeRaydiumClmmPriceE6(data: Uint8Array): bigint {
  if (data.length < RAYDIUM_CLMM_MIN_LEN) {
    throw new Error(`Raydium CLMM data too short: ${data.length} < ${RAYDIUM_CLMM_MIN_LEN}`);
  }
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const decimals0 = data[233];
  const decimals1 = data[234];

  const sqrtPriceX64 = readU128LE(dv, 253);

  if (sqrtPriceX64 === 0n) return 0n;

  // PRECISION FIX: Scale up by 1e6 BEFORE right-shifting to preserve bits
  // for micro-priced tokens where sqrtPriceX64 < 2^64.
  // scaled_sqrt = sqrt * 1_000_000
  // term = scaled_sqrt >> 64  (preserves 6 more decimal digits)
  // price_e6_raw = term * sqrt >> 64
  // Then adjust decimal_diff by -6 (since we already embedded 1e6).
  const scaledSqrt = sqrtPriceX64 * 1_000_000n;
  const term = scaledSqrt >> 64n;
  const priceE6Raw = (term * sqrtPriceX64) >> 64n;

  const decimalDiff = 6 + decimals0 - decimals1;
  const adjustedDiff = decimalDiff - 6;

  if (adjustedDiff >= 0) {
    const scale = 10n ** BigInt(adjustedDiff);
    return priceE6Raw * scale;
  } else {
    const scale = 10n ** BigInt(-adjustedDiff);
    return priceE6Raw / scale;
  }
}

// ============================================================================
// Meteora DLMM
// ============================================================================

const METEORA_DLMM_MIN_LEN = 145;

/**
 * Parse a Meteora DLMM (discretized liquidity) pool account.
 * @internal
 */
function parseMeteoraPool(poolAddress: PublicKey, data: Uint8Array): DexPoolInfo {
  if (data.length < METEORA_DLMM_MIN_LEN) {
    throw new Error(`Meteora DLMM pool data too short: ${data.length} < ${METEORA_DLMM_MIN_LEN}`);
  }
  return {
    dexType: "meteora-dlmm",
    poolAddress,
    baseMint: new PublicKey(data.slice(81, 113)),
    quoteMint: new PublicKey(data.slice(113, 145)),
  };
}

/**
 * Compute Meteora DLMM spot price from active_id and bin_step.
 *
 * Formula: `price = (1 + bin_step/10000) ^ active_id`
 *
 * Uses binary exponentiation with 1e18 fixed-point precision, then converts to e6.
 * For negative active_id, computes the inverse.
 *
 * @internal
 */
function computeMeteoraDlmmPriceE6(data: Uint8Array): bigint {
  if (data.length < METEORA_DLMM_MIN_LEN) {
    throw new Error(`Meteora DLMM data too short: ${data.length} < ${METEORA_DLMM_MIN_LEN}`);
  }
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const binStep = dv.getUint16(74, true);
  const activeId = dv.getInt32(77, true);

  if (binStep === 0) return 0n;

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

  if (isNeg) {
    if (result === 0n) return 0n;
    return (SCALE * 1_000_000n) / result;
  } else {
    return result / 1_000_000_000_000n; // 1e18 → 1e6
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Read a little-endian u64 from a DataView. */
function readU64LE(dv: DataView, offset: number): bigint {
  const lo = BigInt(dv.getUint32(offset, true));
  const hi = BigInt(dv.getUint32(offset + 4, true));
  return lo | (hi << 32n);
}

/** Read a little-endian u128 from a DataView. */
function readU128LE(dv: DataView, offset: number): bigint {
  const lo = readU64LE(dv, offset);
  const hi = readU64LE(dv, offset + 8);
  return lo | (hi << 64n);
}
