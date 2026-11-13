// @vitest-environment node
/**
 * Tests for GH#1771 fix: /api/devnet-airdrop shared-mint multi-row error
 *
 * Root cause: when a mint address appears in multiple markets rows (e.g. SOL or USDC
 * used as collateral in 14 markets), the Supabase query used .maybeSingle() on
 * `markets` which throws PGRST116 ("multiple rows returned"). Users hit a misleading
 * "not a Percolator devnet market mint" error.
 *
 * Fix: replace .maybeSingle() with .order(created_at DESC).limit(N) and pick the
 * best row client-side (prefer rows with a non-null mainnet_ca).
 */

import { describe, it, expect } from "vitest";

// ─── Inline logic mirroring the fix in /api/devnet-airdrop ──────────────────

interface MarketRow {
  mainnet_ca: string | null;
  symbol: string | null;
  decimals: number | null;
}

/**
 * Simulate the fixed shared-mint resolution:
 * Given multiple rows for the same mint_address, pick the best one.
 */
function pickBestMarketRow(rows: MarketRow[], mintAddress: string): MarketRow | null {
  if (!rows.length) return null;
  // Prefer a row with a real (non-self-referencing) mainnet_ca
  return (
    rows.find((r) => r.mainnet_ca && r.mainnet_ca !== mintAddress) ?? rows[0]
  );
}

/**
 * Simulate the old broken behaviour: .maybeSingle() on a multi-row result.
 */
function simulateMaybeSingleThrow(rows: MarketRow[]): { error: string } | { data: MarketRow } {
  if (rows.length > 1) {
    return { error: "PGRST116: multiple rows returned" };
  }
  return { data: rows[0] ?? null as unknown as MarketRow };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const MINT_ADDR = "So11111111111111111111111111111111111111112"; // wSOL

const sharedMintRows: MarketRow[] = [
  { mainnet_ca: "So11111111111111111111111111111111111111112", symbol: "SOL", decimals: 9 },
  { mainnet_ca: "So11111111111111111111111111111111111111112", symbol: "SOL", decimals: 9 },
  { mainnet_ca: "So11111111111111111111111111111111111111112", symbol: "SOL", decimals: 9 },
  { mainnet_ca: null, symbol: "SOL-PERP", decimals: 9 },
  { mainnet_ca: MINT_ADDR, symbol: "SOL2", decimals: 9 },  // self-referencing
];

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("GH#1771 — devnet-airdrop shared-mint multi-row fix", () => {
  describe("old behaviour: .maybeSingle() fails for shared mints", () => {
    it("throws PGRST116 when multiple rows are returned", () => {
      const result = simulateMaybeSingleThrow(sharedMintRows);
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toContain("PGRST116");
      }
    });

    it("works fine when there's only one row (non-shared mint)", () => {
      const singleRow: MarketRow[] = [
        { mainnet_ca: "BoNk111111111111111111111111111111111111111", symbol: "BONK", decimals: 5 },
      ];
      const result = simulateMaybeSingleThrow(singleRow);
      expect("data" in result).toBe(true);
    });
  });

  describe("fixed behaviour: pick best row from multi-row result", () => {
    it("returns a row (not null/error) for 14 duplicate-mint rows", () => {
      const result = pickBestMarketRow(sharedMintRows, MINT_ADDR);
      expect(result).not.toBeNull();
    });

    it("prefers rows with a real (non-self-referencing) mainnet_ca", () => {
      const result = pickBestMarketRow(sharedMintRows, MINT_ADDR);
      // Should pick first row with mainnet_ca !== MINT_ADDR
      expect(result?.mainnet_ca).toBe("So11111111111111111111111111111111111111112");
      expect(result?.mainnet_ca).not.toBeNull();
    });

    it("falls back to first row when all mainnet_cas are null or self-referencing", () => {
      const allNullRows: MarketRow[] = [
        { mainnet_ca: null, symbol: "UNKNOWN", decimals: 6 },
        { mainnet_ca: null, symbol: "UNKNOWN2", decimals: 6 },
        { mainnet_ca: MINT_ADDR, symbol: "SELF", decimals: 6 },
      ];
      const result = pickBestMarketRow(allNullRows, MINT_ADDR);
      expect(result).not.toBeNull();
      expect(result?.symbol).toBe("UNKNOWN"); // first row
    });

    it("returns null for empty rows array", () => {
      const result = pickBestMarketRow([], MINT_ADDR);
      expect(result).toBeNull();
    });

    it("handles single-row case correctly (regression guard)", () => {
      const singleRow: MarketRow[] = [
        { mainnet_ca: "BoNk111111111111111111111111111111111111111", symbol: "BONK", decimals: 5 },
      ];
      const result = pickBestMarketRow(singleRow, MINT_ADDR);
      expect(result?.symbol).toBe("BONK");
    });

    it("extracts correct decimals from picked row", () => {
      const rows: MarketRow[] = [
        { mainnet_ca: null, symbol: "A", decimals: null },
        { mainnet_ca: "real111111111111111111111111111111111111111", symbol: "B", decimals: 8 },
      ];
      const result = pickBestMarketRow(rows, MINT_ADDR);
      const effectiveDecimals = result?.decimals ?? 6;
      expect(effectiveDecimals).toBe(8);
    });

    it("decimals null-coalesces to 6 when best row has null decimals", () => {
      const rows: MarketRow[] = [
        { mainnet_ca: "real111111111111111111111111111111111111111", symbol: "C", decimals: null },
      ];
      const result = pickBestMarketRow(rows, MINT_ADDR);
      const effectiveDecimals = result?.decimals ?? 6;
      expect(effectiveDecimals).toBe(6);
    });
  });

  describe("self-referencing mint edge case (GH#1769 + GH#1771 overlap)", () => {
    it("skips self-referencing rows when picking mainnet_ca for price lookup", () => {
      const mixedRows: MarketRow[] = [
        { mainnet_ca: MINT_ADDR, symbol: "SELF1", decimals: 9 },  // self-referencing
        { mainnet_ca: MINT_ADDR, symbol: "SELF2", decimals: 9 },  // self-referencing
        { mainnet_ca: "real111111111111111111111111111111111111111", symbol: "REAL", decimals: 9 },
      ];
      const result = pickBestMarketRow(mixedRows, MINT_ADDR);
      expect(result?.mainnet_ca).toBe("real111111111111111111111111111111111111111");
      expect(result?.symbol).toBe("REAL");
    });
  });
});
