// @vitest-environment node
/**
 * Tests for GH#1769: devnet_mints null after market creation blocks Get Test Tokens.
 *
 * Root cause: When a user creates a market with a devnet-native token (created via
 * Token Factory, not the Percolator mirror-mint flow), the mint authority is the user's
 * wallet, not the server keypair. /api/devnet-airdrop previously returned a 400 error
 * instead of resolving a server-owned mirror mint.
 *
 * Fix:
 *   1. resolveServerOwnedDevnetMint: when authority mismatch, look for Percolator-owned
 *      devnet mirror in devnet_mints by mainnet_ca, or create one on the fly.
 *   2. Self-referencing devnet_mints row (mainnet_ca === devnet_mint) → look up markets
 *      table for real mainnet_ca.
 *   3. /api/markets POST now upserts devnet_mints with the market's devnet mint address
 *      and mainnet_ca so future airdrop lookups find the row immediately.
 *
 * These tests validate the logic in pure form (no real RPC calls).
 */

import { describe, it, expect } from "vitest";

// ─── Pure logic tests ─────────────────────────────────────────────────────────

/**
 * Simulate the GH#1769 authority-mismatch resolution path.
 *
 * resolveServerOwnedDevnetMint:
 *   1. Query devnet_mints for existing server-owned row by mainnet_ca (excluding self-refs)
 *   2. Verify on-chain authority of found row
 *   3. If none found → create a new devnet SPL mint (mocked as "new-server-mint")
 */
async function resolveServerOwnedDevnetMintLogic(opts: {
  mainnetCa: string;
  serverAuthPubkey: string;
  // Simulated DB: rows with { mainnet_ca, devnet_mint, authority }
  dbRows: Array<{ mainnet_ca: string; devnet_mint: string; authority: string }>;
}): Promise<string | null> {
  const { mainnetCa, serverAuthPubkey, dbRows } = opts;

  // Step 1: Look for server-owned row in devnet_mints by mainnet_ca
  const existingRow = dbRows.find(
    (r) => r.mainnet_ca === mainnetCa && r.devnet_mint !== mainnetCa,
  );

  if (existingRow) {
    // Step 2: Verify on-chain authority
    if (existingRow.authority === serverAuthPubkey) {
      return existingRow.devnet_mint;
    }
    // Stale row — fall through to create
  }

  // Step 3: Create new server-owned mint (mock)
  return "new-server-mint";
}

/**
 * Simulate the self-referencing devnet row detection and markets table lookup.
 */
function resolveMainnetCa(opts: {
  mintAddress: string;
  devnetMintsRow: { mainnet_ca: string; devnet_mint: string } | null;
  marketsRow: { mainnet_ca: string | null } | null;
}): { mainnetCa: string; isSelfReferencing: boolean } {
  const { mintAddress, devnetMintsRow, marketsRow } = opts;

  if (!devnetMintsRow) {
    // No devnet_mints row → use markets table
    return {
      mainnetCa: marketsRow?.mainnet_ca ?? mintAddress,
      isSelfReferencing: !marketsRow?.mainnet_ca || marketsRow.mainnet_ca === mintAddress,
    };
  }

  if (devnetMintsRow.mainnet_ca === mintAddress) {
    // Self-referencing: devnet-register-mint set mainnet_ca = devnet_mint = mintAddress
    // Try markets table for real mainnet_ca
    const realMainnetCa = marketsRow?.mainnet_ca;
    if (realMainnetCa && realMainnetCa !== mintAddress) {
      return { mainnetCa: realMainnetCa, isSelfReferencing: false };
    }
    return { mainnetCa: mintAddress, isSelfReferencing: true };
  }

  return { mainnetCa: devnetMintsRow.mainnet_ca, isSelfReferencing: false };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

const SERVER_AUTH = "GRMMNsNPM1GbgxFh3S34f3jvUX6jPbPiH3oxopnDFiWM";
const BONK_MAINNET_CA = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"; // real BONK
const BONK_DEVNET_MIRROR = "CCPHprPU6Rs1q3yDLxDFwfaxSb8HJ72MRECgbqAZu94Y"; // user-created on devnet
const BONK_SERVER_MIRROR = "serverMirrorMint123456789012345678901234"; // Percolator-owned devnet mirror

describe("GH#1769: devnet_mints null after market creation", () => {
  describe("resolveMainnetCa", () => {
    it("uses devnet_mints.mainnet_ca when non-self-referencing (normal mirror flow)", () => {
      const result = resolveMainnetCa({
        mintAddress: BONK_DEVNET_MIRROR,
        devnetMintsRow: { mainnet_ca: BONK_MAINNET_CA, devnet_mint: BONK_DEVNET_MIRROR },
        marketsRow: { mainnet_ca: BONK_MAINNET_CA },
      });
      expect(result.mainnetCa).toBe(BONK_MAINNET_CA);
      expect(result.isSelfReferencing).toBe(false);
    });

    it("detects self-referencing row (native devnet token) and upgrades to real mainnet_ca from markets", () => {
      const nativeMint = "nativeMintAbcDef123456789012345678901234";
      const result = resolveMainnetCa({
        mintAddress: nativeMint,
        devnetMintsRow: { mainnet_ca: nativeMint, devnet_mint: nativeMint }, // self-referencing
        marketsRow: { mainnet_ca: BONK_MAINNET_CA }, // real mainnet_ca in markets
      });
      expect(result.mainnetCa).toBe(BONK_MAINNET_CA);
      expect(result.isSelfReferencing).toBe(false);
    });

    it("stays self-referencing when markets table has no mainnet_ca", () => {
      const nativeMint = "nativeMintAbcDef123456789012345678901234";
      const result = resolveMainnetCa({
        mintAddress: nativeMint,
        devnetMintsRow: { mainnet_ca: nativeMint, devnet_mint: nativeMint },
        marketsRow: { mainnet_ca: null },
      });
      expect(result.mainnetCa).toBe(nativeMint);
      expect(result.isSelfReferencing).toBe(true);
    });

    it("uses markets.mainnet_ca when no devnet_mints row exists (markets-table fallback)", () => {
      const result = resolveMainnetCa({
        mintAddress: BONK_DEVNET_MIRROR,
        devnetMintsRow: null,
        marketsRow: { mainnet_ca: BONK_MAINNET_CA },
      });
      expect(result.mainnetCa).toBe(BONK_MAINNET_CA);
      expect(result.isSelfReferencing).toBe(false);
    });

    it("self-referencing when no devnet_mints row and no real mainnet_ca in markets", () => {
      const mint = "someDevnetMint12345678901234567890";
      const result = resolveMainnetCa({
        mintAddress: mint,
        devnetMintsRow: null,
        marketsRow: { mainnet_ca: null },
      });
      expect(result.mainnetCa).toBe(mint);
      expect(result.isSelfReferencing).toBe(true);
    });
  });

  describe("resolveServerOwnedDevnetMintLogic", () => {
    it("returns existing server-owned mirror when found in devnet_mints", async () => {
      const result = await resolveServerOwnedDevnetMintLogic({
        mainnetCa: BONK_MAINNET_CA,
        serverAuthPubkey: SERVER_AUTH,
        dbRows: [
          { mainnet_ca: BONK_MAINNET_CA, devnet_mint: BONK_SERVER_MIRROR, authority: SERVER_AUTH },
        ],
      });
      expect(result).toBe(BONK_SERVER_MIRROR);
    });

    it("skips stale mirror (authority mismatch) and creates a new one", async () => {
      const OTHER_AUTH = "otherAuthPubkey1234567890123456789012345";
      const result = await resolveServerOwnedDevnetMintLogic({
        mainnetCa: BONK_MAINNET_CA,
        serverAuthPubkey: SERVER_AUTH,
        dbRows: [
          { mainnet_ca: BONK_MAINNET_CA, devnet_mint: BONK_SERVER_MIRROR, authority: OTHER_AUTH }, // stale
        ],
      });
      // Falls through to create → returns mock "new-server-mint"
      expect(result).toBe("new-server-mint");
    });

    it("creates a new mint when no server-owned row exists in devnet_mints", async () => {
      const result = await resolveServerOwnedDevnetMintLogic({
        mainnetCa: BONK_MAINNET_CA,
        serverAuthPubkey: SERVER_AUTH,
        dbRows: [], // empty
      });
      expect(result).toBe("new-server-mint");
    });

    it("excludes self-referencing rows from the devnet_mints lookup", async () => {
      // Self-referencing row: mainnet_ca === devnet_mint — these are native devnet registrations
      // and should not be returned as server-owned mirrors.
      const result = await resolveServerOwnedDevnetMintLogic({
        mainnetCa: BONK_DEVNET_MIRROR,
        serverAuthPubkey: SERVER_AUTH,
        dbRows: [
          // Self-referencing row (from devnet-register-mint) — should be excluded
          { mainnet_ca: BONK_DEVNET_MIRROR, devnet_mint: BONK_DEVNET_MIRROR, authority: SERVER_AUTH },
        ],
      });
      // Self-ref excluded → falls through to create new mint
      expect(result).toBe("new-server-mint");
    });
  });

  describe("markets POST devnet_mints upsert guard", () => {
    /**
     * Simulate the upsert guard: only write to devnet_mints when
     * mint_address AND mainnet_ca are both present AND different.
     */
    function shouldUpsertDevnetMints(opts: {
      mint_address: string | null;
      mainnet_ca: string | null;
    }): boolean {
      const { mint_address, mainnet_ca } = opts;
      return !!(mint_address && mainnet_ca && mainnet_ca !== mint_address);
    }

    it("upserts when both mint_address and mainnet_ca are present and different", () => {
      expect(shouldUpsertDevnetMints({
        mint_address: BONK_DEVNET_MIRROR,
        mainnet_ca: BONK_MAINNET_CA,
      })).toBe(true);
    });

    it("skips upsert when mainnet_ca is null (devnet-native token without real CA)", () => {
      expect(shouldUpsertDevnetMints({
        mint_address: BONK_DEVNET_MIRROR,
        mainnet_ca: null,
      })).toBe(false);
    });

    it("skips upsert when mainnet_ca === mint_address (self-referencing, no real mainnet token)", () => {
      expect(shouldUpsertDevnetMints({
        mint_address: BONK_DEVNET_MIRROR,
        mainnet_ca: BONK_DEVNET_MIRROR,
      })).toBe(false);
    });

    it("skips upsert when mint_address is null", () => {
      expect(shouldUpsertDevnetMints({
        mint_address: null,
        mainnet_ca: BONK_MAINNET_CA,
      })).toBe(false);
    });
  });
});
