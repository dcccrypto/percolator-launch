/**
 * Parse a human-readable decimal string into native token units.
 * e.g. "100.5" with 6 decimals → 100_500_000n
 */
export function parseHumanAmount(input: string, decimals: number): bigint {
  const trimmed = input.trim();
  if (!trimmed || trimmed === ".") return 0n;

  const negative = trimmed.startsWith("-");
  const abs = negative ? trimmed.slice(1) : trimmed;
  if (!abs || abs === ".") return 0n;

  const parts = abs.split(".");
  if (parts.length > 2) return 0n; // reject "1.2.3"
  const whole = parts[0] || "0";
  const frac = (parts[1] || "").padEnd(decimals, "0").slice(0, decimals);
  const result = BigInt(whole) * BigInt(10 ** decimals) + BigInt(frac);
  return negative ? -result : result;
}

/**
 * Format a native token amount into a human-readable decimal string.
 * e.g. 100_500_000n with 6 decimals → "100.5"
 */
export function formatHumanAmount(raw: bigint, decimals: number): string {
  if (raw === 0n) return "0";

  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const divisor = BigInt(10 ** decimals);
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
