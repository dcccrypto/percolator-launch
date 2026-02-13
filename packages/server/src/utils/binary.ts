/** Decode base58 string to Uint8Array */
export function decodeBase58(str: string): Uint8Array | null {
  try {
    const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const BASE = 58;
    let zeros = 0;
    while (zeros < str.length && str[zeros] === "1") zeros++;
    const bytes: number[] = [];
    for (let i = zeros; i < str.length; i++) {
      const charIndex = ALPHABET.indexOf(str[i]);
      if (charIndex < 0) return null;
      let carry = charIndex;
      for (let j = bytes.length - 1; j >= 0; j--) {
        carry += bytes[j] * BASE;
        bytes[j] = carry & 0xff;
        carry >>= 8;
      }
      while (carry > 0) {
        bytes.unshift(carry & 0xff);
        carry >>= 8;
      }
    }
    const result = new Uint8Array(zeros + bytes.length);
    result.set(bytes, zeros);
    return result;
  } catch {
    return null;
  }
}

/** Read unsigned 128-bit little-endian integer */
export function readU128LE(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = 15; i >= 0; i--) {
    value = (value << 8n) | BigInt(bytes[i]);
  }
  return value;
}

/**
 * Parse signed i128 size from trade instruction data.
 * Returns { sizeValue, side } where sizeValue is the absolute value.
 */
export function parseTradeSize(sizeBytes: Uint8Array): { sizeValue: bigint; side: "long" | "short" } {
  const isNegative = sizeBytes[15] >= 128;
  const side: "long" | "short" = isNegative ? "short" : "long";

  let sizeValue: bigint;
  if (isNegative) {
    const inverted = new Uint8Array(16);
    for (let k = 0; k < 16; k++) inverted[k] = ~sizeBytes[k] & 0xff;
    sizeValue = readU128LE(inverted) + 1n;
  } else {
    sizeValue = readU128LE(sizeBytes);
  }

  return { sizeValue, side };
}
