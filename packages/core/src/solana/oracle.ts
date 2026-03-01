/**
 * Oracle account parsing utilities.
 *
 * Chainlink aggregator layout on Solana (from Toly's percolator-cli):
 *   offset 138: decimals (u8)
 *   offset 216: latest answer (i64 LE)
 *
 * Minimum account size: 224 bytes (offset 216 + 8 bytes for i64).
 *
 * These utilities validate oracle data BEFORE parsing to prevent silent
 * propagation of stale or malformed Chainlink data as price.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum buffer size to read Chainlink price data */
const CHAINLINK_MIN_SIZE = 224; // 216 + 8

/** Maximum reasonable decimals for a price feed */
const MAX_DECIMALS = 18;

/** Offset of decimals field in Chainlink aggregator account */
const CHAINLINK_DECIMALS_OFFSET = 138;

/** Offset of latest answer in Chainlink aggregator account */
const CHAINLINK_ANSWER_OFFSET = 216;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OraclePrice {
  price: bigint;
  decimals: number;
}

// ---------------------------------------------------------------------------
// Browser-compatible read helpers using DataView
// ---------------------------------------------------------------------------

function readU8(data: Uint8Array, off: number): number {
  return data[off];
}

function readBigInt64LE(data: Uint8Array, off: number): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigInt64(off, true);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse price data from a Chainlink aggregator account buffer.
 *
 * Validates:
 * - Buffer is large enough to contain the required fields (≥ 224 bytes)
 * - Decimals are in a reasonable range (0-18)
 * - Price is positive (non-zero)
 *
 * @param data - Raw account data from Chainlink aggregator
 * @returns Parsed oracle price with decimals
 * @throws if the buffer is invalid or contains unreasonable data
 */
export function parseChainlinkPrice(data: Uint8Array): OraclePrice {
  if (data.length < CHAINLINK_MIN_SIZE) {
    throw new Error(
      `Oracle account data too small: ${data.length} bytes (need at least ${CHAINLINK_MIN_SIZE})`
    );
  }

  const decimals = readU8(data, CHAINLINK_DECIMALS_OFFSET);
  if (decimals > MAX_DECIMALS) {
    throw new Error(
      `Oracle decimals out of range: ${decimals} (max ${MAX_DECIMALS})`
    );
  }

  const price = readBigInt64LE(data, CHAINLINK_ANSWER_OFFSET);
  if (price <= 0n) {
    throw new Error(
      `Oracle price is non-positive: ${price}`
    );
  }

  return { price, decimals };
}

/**
 * Validate that a buffer looks like a valid Chainlink aggregator account.
 * Returns true if the buffer passes all validation checks, false otherwise.
 * Use this for non-throwing validation.
 */
export function isValidChainlinkOracle(data: Uint8Array): boolean {
  try {
    parseChainlinkPrice(data);
    return true;
  } catch {
    return false;
  }
}

// Re-export constants for consumers
export { CHAINLINK_MIN_SIZE, CHAINLINK_DECIMALS_OFFSET, CHAINLINK_ANSWER_OFFSET, MAX_DECIMALS };
