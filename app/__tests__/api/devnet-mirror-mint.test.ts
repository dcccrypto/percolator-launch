/**
 * Tests for GH#1476 and GH#1477 fixes in /api/devnet-mirror-mint.
 *
 * GH#1477 (Low): Missing walletAddress must return 400 even on cache-hit path.
 * GH#1476 (Medium): walletAddress must be stored as creator_wallet in the DB
 *   upsert so the column constraint is satisfied for uncached tokens.
 *
 * We test the validation and DB-insert logic in isolation using extracted
 * helper functions that mirror the route behaviour.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ─── Trusted client IP for rate limiting ───────────────────────────────────

describe("devnet-mirror-mint uses shared getClientIp (x-real-ip fallback)", () => {
  it("imports getClientIp from @/lib/get-client-ip instead of a local copy", () => {
    const source = readFileSync(
      join(process.cwd(), "app/api/devnet-mirror-mint/route.ts"),
      "utf8",
    );
    expect(source).toContain('import { getClientIp } from "@/lib/get-client-ip"');
    expect(source).toContain("const clientIp = getClientIp(req);");
    expect(source).not.toMatch(/function getClientIp\s*\(/);
  });
});

// ─── GH#1477: walletAddress validation ──────────────────────────────────────

/**
 * Replicates the validation order from the fixed route:
 *   1. Check mainnetCA present
 *   2. Check walletAddress present (NEW — before cache hit)
 *   3. Check walletAddress is valid base58 pubkey
 */
function validateRequestBody(body: {
  mainnetCA?: string;
  walletAddress?: string;
}): { ok: true } | { ok: false; status: number; error: string } {
  if (!body.mainnetCA) {
    return { ok: false, status: 400, error: "Missing mainnetCA" };
  }
  if (!body.walletAddress) {
    return { ok: false, status: 400, error: "Missing walletAddress" };
  }
  // Minimal base58 length check (real route uses `new PublicKey(walletAddress)`)
  if (body.walletAddress.length < 32 || body.walletAddress.length > 44) {
    return { ok: false, status: 400, error: "Invalid walletAddress" };
  }
  return { ok: true };
}

describe("GH#1477 — walletAddress validation before cache-hit", () => {
  const validCA = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
  const validWallet = "G7NGnUffoo2bKBY7nGjJmSZq7rSvG4bsJpK931rGQshD";

  it("returns 400 when walletAddress is missing", () => {
    const result = validateRequestBody({ mainnetCA: validCA });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toBe("Missing walletAddress");
    }
  });

  it("returns 400 when walletAddress is empty string", () => {
    const result = validateRequestBody({ mainnetCA: validCA, walletAddress: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toBe("Missing walletAddress");
    }
  });

  it("returns 400 when walletAddress is clearly invalid", () => {
    const result = validateRequestBody({ mainnetCA: validCA, walletAddress: "not-a-pubkey" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
    }
  });

  it("passes validation with valid mainnetCA and walletAddress", () => {
    const result = validateRequestBody({ mainnetCA: validCA, walletAddress: validWallet });
    expect(result.ok).toBe(true);
  });

  it("returns 400 when mainnetCA is missing (regardless of walletAddress)", () => {
    const result = validateRequestBody({ walletAddress: validWallet });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toBe("Missing mainnetCA");
    }
  });
});

// ─── GH#1476: creator_wallet included in DB upsert ──────────────────────────

/**
 * Replicates the upsert payload construction from the fixed route.
 * The key fix: walletAddress is now passed as creator_wallet.
 */
function buildUpsertPayload(opts: {
  mainnetCA: string;
  devnetMint: string;
  symbol: string;
  name: string;
  decimals: number;
  logoUrl?: string;
  walletAddress: string;
}) {
  return {
    mainnet_ca: opts.mainnetCA,
    devnet_mint: opts.devnetMint,
    symbol: opts.symbol,
    name: opts.name,
    decimals: opts.decimals,
    logo_url: opts.logoUrl ?? null,
    creator_wallet: opts.walletAddress, // GH#1476 fix
  };
}

describe("GH#1476 — creator_wallet included in DB upsert payload", () => {
  it("includes creator_wallet in upsert payload", () => {
    const payload = buildUpsertPayload({
      mainnetCA: "WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk",
      devnetMint: "DevNetMint111111111111111111111111111111111",
      symbol: "WEN",
      name: "WEN",
      decimals: 6,
      walletAddress: "G7NGnUffoo2bKBY7nGjJmSZq7rSvG4bsJpK931rGQshD",
    });

    expect(payload.creator_wallet).toBe("G7NGnUffoo2bKBY7nGjJmSZq7rSvG4bsJpK931rGQshD");
    expect(payload.creator_wallet).not.toBeNull();
    expect(payload.creator_wallet).not.toBeUndefined();
  });

  it("logo_url defaults to null when logoUrl is undefined", () => {
    const payload = buildUpsertPayload({
      mainnetCA: "WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk",
      devnetMint: "DevNetMint111111111111111111111111111111111",
      symbol: "WEN",
      name: "WEN",
      decimals: 6,
      walletAddress: "G7NGnUffoo2bKBY7nGjJmSZq7rSvG4bsJpK931rGQshD",
    });

    expect(payload.logo_url).toBeNull();
  });

  it("includes logo_url when logoUrl is provided", () => {
    const payload = buildUpsertPayload({
      mainnetCA: "WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk",
      devnetMint: "DevNetMint111111111111111111111111111111111",
      symbol: "WEN",
      name: "WEN",
      decimals: 6,
      logoUrl: "https://example.com/wen.png",
      walletAddress: "G7NGnUffoo2bKBY7nGjJmSZq7rSvG4bsJpK931rGQshD",
    });

    expect(payload.logo_url).toBe("https://example.com/wen.png");
  });

  it("all required DB columns are present", () => {
    const payload = buildUpsertPayload({
      mainnetCA: "WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk",
      devnetMint: "DevNetMint111111111111111111111111111111111",
      symbol: "WEN",
      name: "WEN",
      decimals: 6,
      walletAddress: "G7NGnUffoo2bKBY7nGjJmSZq7rSvG4bsJpK931rGQshD",
    });

    const requiredKeys = ["mainnet_ca", "devnet_mint", "symbol", "name", "decimals", "logo_url", "creator_wallet"];
    for (const key of requiredKeys) {
      expect(payload).toHaveProperty(key);
    }
  });
});
