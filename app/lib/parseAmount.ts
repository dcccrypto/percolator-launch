import { normalizeTokenDecimals } from "@/lib/format";

/**
 * Parse a human-readable decimal string into native token units (smallest units).
 * Converts user input like "100.5" into blockchain-native format like 100_500_000n (for 6-decimal token).
 * 
 * Handles:
 * - Decimal point validation (only one allowed)
 * - Negative numbers with minus sign
 * - Trimming whitespace
 * - Zero/empty input (returns 0n)
 * - Precision validation (rejects decimals exceeding token precision)
 * 
 * @param input - Human-readable decimal string (e.g. "100.5", "-50", "  0.001  ")
 * @param decimals - Token's decimal precision (must match blockchain token decimals)
 * @returns Parsed amount in smallest units, or 0n for empty input. Throws if decimals exceed token precision.
 * 
 * @throws {Error} If input has more decimal places than the token supports
 * 
 * @example
 * // 6-decimal token like USDC
 * parseHumanAmount("100.5", 6) // -> 100500000n
 * parseHumanAmount("  0.000001  ", 6) // -> 1n
 * parseHumanAmount("-50", 6) // -> -50000000n
 * parseHumanAmount("abc", 6) // -> 0n (invalid input)
 * parseHumanAmount("0.0000001", 6) // -> throws (too many decimals)
 */
export function parseHumanAmount(input: string, decimalsRaw: number): bigint {
  // Guard malformed decimals (NaN/Infinity/negative/fractional) before they
  // reach BigInt exponentiation or String.padEnd — same fix as the display
  // formatters in lib/format.ts (#2389), extended to this input-parsing path.
  const decimals = normalizeTokenDecimals(decimalsRaw);
  const trimmed = input.trim();
  if (!trimmed || trimmed === ".") return 0n;

  const negative = trimmed.startsWith("-");
  const abs = negative ? trimmed.slice(1) : trimmed;
  if (!abs || abs === ".") return 0n;

  const parts = abs.split(".");
  if (parts.length > 2) return 0n; // reject "1.2.3"
  const whole = parts[0] || "0";
  const fracPart = parts[1] || "";

  // Honor the documented "invalid input -> 0n" contract. `whole`/`fracPart`
  // must be pure digit strings; anything else ("abc", "1e6", "0x5", "1,000")
  // would otherwise reach `BigInt(...)` below and THROW, contradicting the
  // JSDoc and risking an unhandled throw in a caller that parses live input.
  // (The decimals-exceed case below is a genuine, documented @throws.)
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fracPart)) return 0n;

  // M1: Throw error if decimals exceed token precision
  if (fracPart.length > decimals) {
    throw new Error(`Input has ${fracPart.length} decimals, but token only supports ${decimals}`);
  }
  
  const frac = fracPart.padEnd(decimals, "0");
  const result = BigInt(whole) * (10n ** BigInt(decimals)) + BigInt(frac);
  return negative ? -result : result;
}

/**
 * Format a native token amount (smallest units) into a human-readable decimal string.
 * Inverse of parseHumanAmount: converts 100_500_000n (smallest units) back to "100.5" for 6-decimal tokens.
 * 
 * Features:
 * - Strips trailing zeros from fractional part (e.g. "100.500000" -> "100.5")
 * - Preserves negative amounts with minus sign
 * - Returns plain "0" for zero amounts
 * - Preserves full precision without rounding
 * 
 * @param raw - Amount in smallest units (bigint). Can be positive, negative, or zero.
 * @param decimals - Token's decimal precision (must match blockchain token decimals)
 * @returns Human-readable decimal string without trailing zeros
 * 
 * @example
 * // 6-decimal token
 * formatHumanAmount(100500000n, 6) // -> "100.5"
 * formatHumanAmount(1n, 6) // -> "0.000001"
 * formatHumanAmount(-50000000n, 6) // -> "-50"
 * formatHumanAmount(0n, 6) // -> "0"
 * formatHumanAmount(100000000n, 6) // -> "100" (trailing zeros stripped)
 */
export function formatHumanAmount(raw: bigint, decimalsRaw: number): string {
  if (raw === 0n) return "0";

  const decimals = normalizeTokenDecimals(decimalsRaw);
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const remainder = abs % divisor;

  if (remainder === 0n) {
    const w = whole.toString();
    return negative ? `-${w}` : w;
  }

  // Pad fraction to `decimals` digits, then strip trailing zeros
  const fracStr = remainder.toString().padStart(decimals, "0").replace(/0+$/, "");
  const w = whole.toString();
  return `${negative ? "-" : ""}${w}.${fracStr}`;
}
