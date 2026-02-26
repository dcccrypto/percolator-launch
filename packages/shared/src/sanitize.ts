/**
 * Input sanitization utilities for API security
 */

const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]+$/;
const MIN_SLAB_ADDRESS_LENGTH = 32;
const MAX_SLAB_ADDRESS_LENGTH = 44;

/**
 * Sanitize a string input by trimming, removing null bytes, and limiting length
 */
export function sanitizeString(input: string, maxLength = 1000): string {
  if (typeof input !== "string") {
    return "";
  }
  
  // Remove null bytes and other control characters
  let sanitized = input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  
  // Trim whitespace
  sanitized = sanitized.trim();
  
  // Limit length
  if (maxLength > 0 && sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength);
  }
  
  return sanitized;
}

/**
 * Validate and sanitize a Solana base58 address (slab, mint, etc.)
 * Returns the address if valid, null otherwise
 */
export function sanitizeSlabAddress(input: string): string | null {
  if (typeof input !== "string") {
    return null;
  }
  
  const sanitized = sanitizeString(input, MAX_SLAB_ADDRESS_LENGTH);
  
  // Check length
  if (sanitized.length < MIN_SLAB_ADDRESS_LENGTH || sanitized.length > MAX_SLAB_ADDRESS_LENGTH) {
    return null;
  }
  
  // Check base58 format
  if (!BASE58_REGEX.test(sanitized)) {
    return null;
  }
  
  return sanitized;
}

/**
 * Sanitize pagination parameters (limit and offset)
 * Returns safe clamped values
 */
export function sanitizePagination(
  limit?: unknown,
  offset?: unknown
): { limit: number; offset: number } {
  const DEFAULT_LIMIT = 50;
  const MAX_LIMIT = 500;
  const MAX_OFFSET = 100000;
  
  let safeLimit = DEFAULT_LIMIT;
  let safeOffset = 0;
  
  // Parse and clamp limit
  if (typeof limit === "number") {
    safeLimit = Math.floor(limit);
  } else if (typeof limit === "string") {
    const parsed = parseInt(limit, 10);
    if (!isNaN(parsed)) {
      safeLimit = parsed;
    }
  }
  
  safeLimit = Math.max(1, Math.min(safeLimit, MAX_LIMIT));
  
  // Parse and clamp offset
  if (typeof offset === "number") {
    safeOffset = Math.floor(offset);
  } else if (typeof offset === "string") {
    const parsed = parseInt(offset, 10);
    if (!isNaN(parsed)) {
      safeOffset = parsed;
    }
  }
  
  safeOffset = Math.max(0, Math.min(safeOffset, MAX_OFFSET));
  
  return { limit: safeLimit, offset: safeOffset };
}

// ── BigInt sanitization for on-chain → DB conversion ──────────────────────

/** PostgreSQL bigint max: 2^63 − 1 */
const PG_BIGINT_MAX = 9_223_372_036_854_775_807n;

/** Solana u64::MAX sentinel value */
const U64_MAX = 18_446_744_073_709_551_615n;

/** Anything ≥ 90% of u64::MAX is treated as a sentinel / uninitialized field */
const SENTINEL_THRESHOLD = (U64_MAX * 9n) / 10n; // ~16.6 × 10^18

/**
 * Sanitize a bigint value before converting to Number for DB insertion.
 *
 * Handles three failure modes:
 *  1. u64::MAX sentinel values (uninitialized on-chain fields) → returns `fallback`
 *  2. Values exceeding PostgreSQL bigint range (±2^63 − 1) → returns `fallback`
 *  3. Values exceeding Number.MAX_SAFE_INTEGER → returns `fallback` (precision loss)
 *
 * This prevents the "value X out of range for type bigint" Postgres errors
 * that occur when on-chain slab fields contain u64::MAX sentinels.
 */
export function sanitizeBigIntForDb(value: bigint, fallback: number = 0): number {
  // Detect u64::MAX sentinel or near-sentinel values
  if (value >= SENTINEL_THRESHOLD) return fallback;

  // Detect negative sentinel-like values (i64-reinterpreted or underflows)
  if (value <= -SENTINEL_THRESHOLD) return fallback;

  // Clamp to PostgreSQL bigint range
  if (value > PG_BIGINT_MAX || value < -PG_BIGINT_MAX) return fallback;

  return Number(value);
}

/**
 * Sanitize a bigint value to a string for DB text/numeric columns.
 * Same sentinel detection as sanitizeBigIntForDb, but preserves full precision
 * for fields stored as text (e.g. net_lp_pos, maintenance_fee_per_slot).
 */
export function sanitizeBigIntToString(value: bigint, fallback: string = "0"): string {
  if (value >= SENTINEL_THRESHOLD || value <= -SENTINEL_THRESHOLD) return fallback;
  return value.toString();
}

/**
 * Sanitize a numeric parameter (price, amount, etc.)
 * Returns null if invalid
 */
export function sanitizeNumber(input: unknown, min?: number, max?: number): number | null {
  let num: number;
  
  if (typeof input === "number") {
    num = input;
  } else if (typeof input === "string") {
    const parsed = parseFloat(input);
    if (isNaN(parsed)) {
      return null;
    }
    num = parsed;
  } else {
    return null;
  }
  
  if (!isFinite(num)) {
    return null;
  }
  
  if (min !== undefined && num < min) {
    return null;
  }
  
  if (max !== undefined && num > max) {
    return null;
  }
  
  return num;
}
