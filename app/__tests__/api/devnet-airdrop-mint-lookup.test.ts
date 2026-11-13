// @vitest-environment node
/**
 * Tests for GH#1703 fix: /api/devnet-airdrop mint validation fallback
 *
 * Root cause: the endpoint only looked up `mintAddress` in the `devnet_mints`
 * table (mirror mints created by the mainnet mirror flow). Market mints created
 * directly via the launch wizard only exist in the `markets` table as
 * `mint_address`. This caused a misleading 400 "not a known devnet mirror mint"
 * even when the server could mint tokens fine.
 *
 * Fix: if not found in `devnet_mints`, also query `markets` by `mint_address`.
 */

import { describe, it, expect } from "vitest";

// ─── Inline logic extracted from the mint-lookup step ───────────────────────

interface MintInfo {
  mainnet_ca: string;
  symbol: string | null;
  decimals: number;
}

type LookupResult =
  | { found: true; source: "devnet_mints" | "markets"; info: MintInfo }
  | { found: false };

/**
 * Pure simulation of the two-step mint lookup added in GH#1703.
 *
 * @param devnetMintsRow - row from devnet_mints table (null = not found)
 * @param marketsRow     - row from markets table (null = not found)
 */
function simulateMintLookup(params: {
  devnetMintsRow: MintInfo | null;
  marketsRow: MintInfo | null;
}): LookupResult {
  const { devnetMintsRow, marketsRow } = params;

  if (devnetMintsRow) {
    return { found: true, source: "devnet_mints", info: devnetMintsRow };
  }

  if (marketsRow) {
    return { found: true, source: "markets", info: marketsRow };
  }

  return { found: false };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("GH#1703 — devnet-airdrop mint lookup fallback", () => {
  const mockMintInfo: MintInfo = {
    mainnet_ca: "So11111111111111111111111111111111111111112",
    symbol: "BONK",
    decimals: 6,
  };

  describe("devnet_mints table hit (mirror mints)", () => {
    it("returns devnet_mints row when found", () => {
      const result = simulateMintLookup({
        devnetMintsRow: mockMintInfo,
        marketsRow: null,
      });
      expect(result.found).toBe(true);
      if (result.found) {
        expect(result.source).toBe("devnet_mints");
        expect(result.info.symbol).toBe("BONK");
      }
    });

    it("prefers devnet_mints over markets when both have a row", () => {
      const marketsMint: MintInfo = { ...mockMintInfo, symbol: "MARKET_SYMBOL" };
      const result = simulateMintLookup({
        devnetMintsRow: mockMintInfo,
        marketsRow: marketsMint,
      });
      expect(result.found).toBe(true);
      if (result.found) {
        expect(result.source).toBe("devnet_mints");
        expect(result.info.symbol).toBe("BONK");
      }
    });
  });

  describe("markets table fallback (direct market mints — GH#1703 regression)", () => {
    it("falls back to markets when devnet_mints has no row", () => {
      const result = simulateMintLookup({
        devnetMintsRow: null,
        marketsRow: mockMintInfo,
      });
      expect(result.found).toBe(true);
      if (result.found) {
        expect(result.source).toBe("markets");
        expect(result.info.symbol).toBe("BONK");
      }
    });

    it("returns the correct mainnet_ca from markets row for price lookup", () => {
      const result = simulateMintLookup({
        devnetMintsRow: null,
        marketsRow: { mainnet_ca: "CCPHprPU6RsT4KbwVRC5Gk21L3B7VFsPUZFxEjZS4SeC", symbol: "BONKUSD", decimals: 5 },
      });
      expect(result.found).toBe(true);
      if (result.found) {
        expect(result.info.mainnet_ca).toBe("CCPHprPU6RsT4KbwVRC5Gk21L3B7VFsPUZFxEjZS4SeC");
        expect(result.info.decimals).toBe(5);
      }
    });
  });

  describe("not found in either table", () => {
    it("returns found=false when both tables have no row", () => {
      const result = simulateMintLookup({
        devnetMintsRow: null,
        marketsRow: null,
      });
      expect(result.found).toBe(false);
    });
  });

  describe("decimals defaulting", () => {
    it("decimals from markets row can be null-coalesced to 6 at call site", () => {
      // Simulate a markets row where decimals could be null
      const rawRow = { mainnet_ca: "abc", symbol: "TEST", decimals: null as unknown as number };
      const result = simulateMintLookup({ devnetMintsRow: null, marketsRow: rawRow });
      expect(result.found).toBe(true);
      if (result.found) {
        const effectiveDecimals = result.info.decimals ?? 6;
        expect(effectiveDecimals).toBe(6);
      }
    });
  });
});
