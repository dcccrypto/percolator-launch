import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Extract testable logic from faucet route ───────────────────────────────

/** base58 decode (mirrored from route) */
function base58Decode(encoded: string): Uint8Array {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const map: Record<string, number> = {};
  for (let i = 0; i < ALPHABET.length; i++) map[ALPHABET[i]] = i;
  let n = BigInt(0);
  for (const ch of encoded) {
    if (!(ch in map)) throw new Error(`Invalid base58 char: ${ch}`);
    n = n * BigInt(58) + BigInt(map[ch]);
  }
  const hex = n.toString(16).padStart(128, "0");
  const bytes = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Validate a Solana wallet address (base58, 32-44 chars) */
function isValidWallet(wallet: string): boolean {
  if (!wallet || typeof wallet !== "string") return false;
  if (wallet.length < 32 || wallet.length > 44) return false;
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  return [...wallet].every((ch) => ALPHABET.includes(ch));
}

/** Check faucet rate limit */
function checkRateLimit(
  claims: { amount: number }[],
  dailyLimitRaw: number
): { allowed: boolean; remaining: number } {
  const total = claims.reduce((sum, c) => sum + c.amount, 0);
  const remaining = Math.max(0, dailyLimitRaw - total);
  return { allowed: total < dailyLimitRaw, remaining };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Faucet: base58Decode", () => {
  it("decodes a known base58 string to 64 bytes", () => {
    const result = base58Decode("1111111111111111111111111111111111111111111111111111111111111111");
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(64);
  });

  it("throws on invalid base58 characters", () => {
    expect(() => base58Decode("000INVALID")).toThrow("Invalid base58 char");
  });

  it("throws on character 'O' (not in base58)", () => {
    expect(() => base58Decode("OOOOO")).toThrow("Invalid base58 char: O");
  });

  it("throws on character 'l' (not in base58)", () => {
    expect(() => base58Decode("lllll")).toThrow("Invalid base58 char: l");
  });

  it("throws on character 'I' (not in base58)", () => {
    expect(() => base58Decode("IIIII")).toThrow("Invalid base58 char: I");
  });

  it("handles all-ones encoding deterministically", () => {
    const a = base58Decode("11111111111111111111111111111111");
    const b = base58Decode("11111111111111111111111111111111");
    expect(a).toEqual(b);
  });
});

describe("Faucet: isValidWallet", () => {
  it("accepts a valid 44-char base58 address", () => {
    expect(isValidWallet("FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD")).toBe(true);
  });

  it("accepts a valid 32-char base58 address", () => {
    expect(isValidWallet("11111111111111111111111111111111")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isValidWallet("")).toBe(false);
  });

  it("rejects null/undefined", () => {
    expect(isValidWallet(null as any)).toBe(false);
    expect(isValidWallet(undefined as any)).toBe(false);
  });

  it("rejects too short address", () => {
    expect(isValidWallet("abc")).toBe(false);
  });

  it("rejects address with invalid chars (0, O, I, l)", () => {
    expect(isValidWallet("0xfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD")).toBe(false);
  });

  it("rejects address with spaces", () => {
    expect(isValidWallet("FxfD37s1 ZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD")).toBe(false);
  });
});

describe("Faucet: checkRateLimit", () => {
  const DAILY_LIMIT = 10_000_000_000; // 10k simUSDC raw

  it("allows first claim", () => {
    const result = checkRateLimit([], DAILY_LIMIT);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(DAILY_LIMIT);
  });

  it("allows claim under limit", () => {
    const claims = [{ amount: 5_000_000_000 }];
    const result = checkRateLimit(claims, DAILY_LIMIT);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(5_000_000_000);
  });

  it("rejects claim at limit", () => {
    const claims = [{ amount: 10_000_000_000 }];
    const result = checkRateLimit(claims, DAILY_LIMIT);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("rejects claim over limit", () => {
    const claims = [{ amount: 7_000_000_000 }, { amount: 5_000_000_000 }];
    const result = checkRateLimit(claims, DAILY_LIMIT);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("sums multiple claims correctly", () => {
    const claims = [{ amount: 3_000_000_000 }, { amount: 3_000_000_000 }];
    const result = checkRateLimit(claims, DAILY_LIMIT);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4_000_000_000);
  });
});
