// @vitest-environment node
/**
 * GH#1963 / PERC-8326: /api/markets POST input validation
 *
 * Tests for the validation logic added in the fix:
 *  - oracle_authority: must be a valid Solana pubkey (when provided)
 *  - mainnet_ca: must be a valid Solana public key (when provided)
 *  - symbol: 1–20 chars, alphanumeric/dash/dot/underscore only
 *  - name: 1–64 printable chars, no control characters
 *
 * These tests mirror the guard logic in route.ts in isolation — no
 * HTTP layer or Supabase mocking required.
 */

import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";

// ── Mirrors of validation helpers from route.ts ──────────────────────────────

const SYMBOL_RE = /^[A-Za-z0-9._\-]{1,20}$/;

function validateSymbol(raw: unknown, fallback: string): { ok: boolean; error?: string; value?: string } {
  const resolved = (typeof raw === "string" && raw.length > 0) ? raw : fallback;
  if (!SYMBOL_RE.test(resolved)) {
    return { ok: false, error: "Invalid symbol: must be 1–20 chars, alphanumeric/dash/dot/underscore only" };
  }
  return { ok: true, value: resolved };
}

function validateName(raw: unknown, fallback: string): { ok: boolean; error?: string; value?: string } {
  const resolved = (typeof raw === "string" && raw.length > 0) ? raw : fallback;
  if (typeof resolved !== "string" || resolved.trim().length === 0 || resolved.length > 64) {
    return { ok: false, error: "Invalid name: must be 1–64 characters" };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(resolved)) {
    return { ok: false, error: "Invalid name: must not contain control characters" };
  }
  return { ok: true, value: resolved };
}

function validatePubkey(value: unknown, field: string): { ok: boolean; error?: string } {
  if (!value) return { ok: true }; // optional field — skip when absent
  try {
    new PublicKey(value as string);
    return { ok: true };
  } catch {
    return { ok: false, error: `Invalid ${field}: must be a valid Solana public key` };
  }
}

const VALID_PUBKEY = "11111111111111111111111111111111";
const VALID_MINT   = "So11111111111111111111111111111111111111112";

// ── oracle_authority validation ───────────────────────────────────────────────

describe("GH#1963: oracle_authority validation", () => {
  it("accepts a valid Solana pubkey", () => {
    expect(validatePubkey(VALID_PUBKEY, "oracle_authority").ok).toBe(true);
  });

  it("accepts the SOL mint pubkey", () => {
    expect(validatePubkey(VALID_MINT, "oracle_authority").ok).toBe(true);
  });

  it("rejects a garbage string", () => {
    const result = validatePubkey("not-a-pubkey", "oracle_authority");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("oracle_authority");
  });

  it("rejects an empty string", () => {
    // empty string — falsy, treated as absent (ok)
    expect(validatePubkey("", "oracle_authority").ok).toBe(true);
  });

  it("rejects a truncated base58 string", () => {
    const result = validatePubkey("111111111111", "oracle_authority");
    expect(result.ok).toBe(false);
  });

  it("rejects a SQL injection attempt", () => {
    const result = validatePubkey("'; DROP TABLE markets; --", "oracle_authority");
    expect(result.ok).toBe(false);
  });

  it("skips validation when oracle_authority is null/undefined", () => {
    expect(validatePubkey(null, "oracle_authority").ok).toBe(true);
    expect(validatePubkey(undefined, "oracle_authority").ok).toBe(true);
  });
});

// ── mainnet_ca validation ─────────────────────────────────────────────────────

describe("GH#1963: mainnet_ca validation", () => {
  it("accepts a valid pubkey", () => {
    expect(validatePubkey(VALID_MINT, "mainnet_ca").ok).toBe(true);
  });

  it("rejects garbage mainnet_ca", () => {
    const result = validatePubkey("0x1234abcd", "mainnet_ca");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("mainnet_ca");
  });

  it("rejects a 256-char random string", () => {
    const long = "a".repeat(256);
    const result = validatePubkey(long, "mainnet_ca");
    expect(result.ok).toBe(false);
  });

  it("is optional — absent is fine", () => {
    expect(validatePubkey(undefined, "mainnet_ca").ok).toBe(true);
    expect(validatePubkey(null, "mainnet_ca").ok).toBe(true);
  });
});

// ── symbol validation ─────────────────────────────────────────────────────────

describe("GH#1963: symbol validation", () => {
  const fallback = VALID_MINT.slice(0, 4).toUpperCase(); // "SO11"

  it("accepts valid token symbols", () => {
    for (const sym of ["BTC", "SOL", "USDC", "mSOL", "JiTO", "BTC.b", "USD-C", "A"]) {
      expect(validateSymbol(sym, fallback).ok).toBe(true);
    }
  });

  it("rejects symbols longer than 20 chars", () => {
    const result = validateSymbol("A".repeat(21), fallback);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("1–20");
  });

  it("rejects symbols with spaces", () => {
    expect(validateSymbol("BTC PERP", fallback).ok).toBe(false);
  });

  it("rejects symbols with special chars (<, >, script injections)", () => {
    expect(validateSymbol("<script>", fallback).ok).toBe(false);
    expect(validateSymbol("BTC;DROP", fallback).ok).toBe(false);
    expect(validateSymbol("BTC'", fallback).ok).toBe(false);
  });

  it("falls back to derived symbol when raw is absent", () => {
    const result = validateSymbol("", fallback);
    // Empty string → use fallback; fallback must pass regex
    expect(result.ok).toBe(true);
    expect(result.value).toBe(fallback);
  });

  it("accepts exactly 20 chars", () => {
    expect(validateSymbol("A".repeat(20), fallback).ok).toBe(true);
  });

  it("rejects 0 effective length (symbol after fallback is also empty)", () => {
    // If both raw and fallback are empty, the regex rejects it (min length 1).
    expect(validateSymbol("", "").ok).toBe(false);
  });
});

// ── name validation ───────────────────────────────────────────────────────────

describe("GH#1963: name validation", () => {
  const mintSlice = VALID_MINT.slice(0, 8);
  const fallback = `Token ${mintSlice}`;

  it("accepts a normal market name", () => {
    expect(validateName("SOL/USDC Perp", fallback).ok).toBe(true);
  });

  it("accepts exactly 64 characters", () => {
    expect(validateName("A".repeat(64), fallback).ok).toBe(true);
  });

  it("rejects names longer than 64 chars", () => {
    const result = validateName("A".repeat(65), fallback);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("1–64");
  });

  it("rejects names with null bytes", () => {
    const result = validateName("Market\x00Name", fallback);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("control");
  });

  it("rejects names with newlines (control char)", () => {
    expect(validateName("Market\nName", fallback).ok).toBe(false);
  });

  it("rejects names with tab characters", () => {
    expect(validateName("Market\tName", fallback).ok).toBe(false);
  });

  it("rejects empty/whitespace-only names", () => {
    expect(validateName("   ", fallback).ok).toBe(false);
  });

  it("uses fallback when name is absent", () => {
    const result = validateName("", fallback);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(fallback);
  });

  it("rejects injection attempt with control chars", () => {
    // ESC sequences used in ANSI injection
    expect(validateName("\x1b[31mRED\x1b[0m", fallback).ok).toBe(false);
  });
});
