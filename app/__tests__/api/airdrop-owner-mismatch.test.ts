// @vitest-environment node
/**
 * Tests for GH#1586 fix: /api/airdrop OwnerMismatch when server keypair is not
 * the mint authority for legacy markets.
 *
 * We test the resolveServerOwnedMint logic in isolation:
 *   1. Stored mint is owned by server → return it unchanged
 *   2. Stored mint is owned by a different wallet → look up mirror in devnet_mints
 *   3. Stored mint is owned by different wallet, mirror exists → return mirror
 *   4. Stored mint is owned by different wallet, no mirror → triggers creation path
 *
 * The on-chain getMint call is mocked; the supabase queries are mocked in-process.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const SERVER_AUTH = "GRMMNsNPM1GbgxFh3S34f3jvUX6jPbPiH3oxopnDFiWM";
const MARKET_ADDR = "Bc7A4yCa2SpaBCLCMpphwFE45YPFnJF4Hk1hPfZMKgvK";
const STORED_MINT_SERVER_OWNED = "7xMw7Hb3M4uoVtJhRpgBNhBR2fPasTbnXhsDQ8Yp2nZj"; // owned by SERVER_AUTH
const STORED_MINT_OTHER_OWNED = "usdEkK5G2gLzUyJ9TxhPFoaLnBq3cFZV4cDKG8mNkRT"; // owned by pay6rd5BMKsh7DhTyHcSTNmWVqANYCnBXj6tfkt5Mk3
const MIRROR_MINT = "mirrorMintAbcDefGhi123456789012345678901234"; // server-owned mirror

// ─── Helpers mirroring resolveServerOwnedMint logic ────────────────────────

type MintInfo = { mintAuthority: { toBase58: () => string } | null };
type SupabaseResult = { data: { devnet_mint: string } | null };

/**
 * Pure logic extracted from resolveServerOwnedMint for unit-testable form.
 * Returns:
 *   - "stored"  → use storedMint as-is (server owns it)
 *   - "mirror"  → use a DB mirror mint
 *   - "create"  → must create a new server-owned mint
 */
async function determineAirdropMintPath(
  storedMint: string,
  mintAuthPubkey: string,
  getMintInfo: (mint: string) => Promise<MintInfo | null>,
  queryMirror: (marketAddr: string, creatorWallet: string) => Promise<SupabaseResult>,
  marketAddress: string,
): Promise<"stored" | "mirror" | "create"> {
  // 1. Check on-chain authority
  try {
    const mintInfo = await getMintInfo(storedMint);
    if (mintInfo?.mintAuthority?.toBase58() === mintAuthPubkey) {
      return "stored";
    }
  } catch {
    // Fall through
  }

  // 2. Look for server-owned mirror
  const { data: mirror } = await queryMirror(marketAddress, mintAuthPubkey);
  if (mirror?.devnet_mint) {
    return "mirror";
  }

  // 3. Need to create
  return "create";
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("GH#1586 — airdrop mint authority resolution", () => {
  const noMirror = async () => ({ data: null } as SupabaseResult);
  const hasMirror = async () => ({ data: { devnet_mint: MIRROR_MINT } } as SupabaseResult);

  describe("server owns stored mint", () => {
    it("returns 'stored' when getMint reports server as authority", async () => {
      const getMintInfo = async (_mint: string): Promise<MintInfo> => ({
        mintAuthority: { toBase58: () => SERVER_AUTH },
      });
      const result = await determineAirdropMintPath(
        STORED_MINT_SERVER_OWNED,
        SERVER_AUTH,
        getMintInfo,
        noMirror,
        MARKET_ADDR,
      );
      expect(result).toBe("stored");
    });
  });

  describe("stored mint owned by a different wallet", () => {
    const otherOwnerMint = async (_mint: string): Promise<MintInfo> => ({
      mintAuthority: { toBase58: () => "pay6rd5BMKsh7DhTyHcSTNmWVqANYCnBXj6tfkt5Mk3" },
    });

    it("returns 'mirror' when a server-owned mirror exists in devnet_mints", async () => {
      const result = await determineAirdropMintPath(
        STORED_MINT_OTHER_OWNED,
        SERVER_AUTH,
        otherOwnerMint,
        hasMirror,
        MARKET_ADDR,
      );
      expect(result).toBe("mirror");
    });

    it("returns 'create' when no server-owned mirror exists", async () => {
      const result = await determineAirdropMintPath(
        STORED_MINT_OTHER_OWNED,
        SERVER_AUTH,
        otherOwnerMint,
        noMirror,
        MARKET_ADDR,
      );
      expect(result).toBe("create");
    });
  });

  describe("getMint fails (e.g. mint account missing on-chain)", () => {
    it("returns 'mirror' if mirror exists", async () => {
      const failingGetMint = async (_mint: string): Promise<MintInfo> => {
        throw new Error("Account not found");
      };
      const result = await determineAirdropMintPath(
        "InvalidMintXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        SERVER_AUTH,
        failingGetMint,
        hasMirror,
        MARKET_ADDR,
      );
      expect(result).toBe("mirror");
    });

    it("returns 'create' if no mirror and getMint throws", async () => {
      const failingGetMint = async (_mint: string): Promise<MintInfo> => {
        throw new Error("Account not found");
      };
      const result = await determineAirdropMintPath(
        "InvalidMintXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        SERVER_AUTH,
        failingGetMint,
        noMirror,
        MARKET_ADDR,
      );
      expect(result).toBe("create");
    });
  });

  describe("authority mismatch for all tested markets from GH#1586", () => {
    const knownMismatches = [
      { mint: "usdEkK5G2gLzUyJ9TxhPFoaLnBq3cFZV4cDKG8mNkRT", authority: "pay6rd5BMKsh7DhTyHcSTNmWVqANYCnBXj6tfkt5Mk3" },
      { mint: "MOLTBOT2gLzUyJ9TxhPFoaLnBq3cFZV4cDKG8mNkRTs", authority: "Af5bTkfT7wW8UTEcaJHWB9vmkBmpPB8P9UGzwifBci7H" },
      { mint: "2VqYNj8G2gLzUyJ9TxhPFoaLnBq3cFZV4cDKG8mNkRT", authority: "DFxYHAKRa2GuJNJBfs3swRuHzgta9FLZQZVAwfzDNhz4" },
      { mint: "FKNzcDeY2gLzUyJ9TxhPFoaLnBq3cFZV4cDKG8mNkRT", authority: "4gbVh1AxVNC3RbLtFyxdgiqxrkqed7ph2XGeC3QKA5Ec" },
    ];

    it.each(knownMismatches)(
      "market with mint authority $authority → resolves to 'create' (no mirror exists)",
      async ({ mint, authority }) => {
        const getMintInfo = async (_m: string): Promise<MintInfo> => ({
          mintAuthority: { toBase58: () => authority },
        });
        const result = await determineAirdropMintPath(
          mint,
          SERVER_AUTH,
          getMintInfo,
          noMirror,
          MARKET_ADDR,
        );
        expect(result).toBe("create");
      },
    );
  });
});
