import { describe, it, expect, vi, beforeEach } from "vitest";
import { PublicKey } from "@solana/web3.js";

/**
 * PERC-8311 — useAdminActions authority pre-flight checks.
 *
 * Verifies that privileged admin/oracle actions throw descriptive errors when
 * the connected wallet does not hold the required role, preventing sign-doomed-tx UX.
 */

// ─── Minimal DiscoveredMarket mock ───────────────────────────────────────────

const ADMIN_PK = new PublicKey("3BTomn4cTCcTXaGWnvTxU4ArQWq9spfSZ2KAcaXHPFX6");
const ORACLE_PK = new PublicKey("C2okXiWSM6S68Cx1ZyRbUzF7chMG8Sixo8JfqRkyHMWz");
const SLAB_PK = new PublicKey("27kaERB4L51djBQoQtLYURQNML5naZGaATuj2oB6kL1d");
const PROGRAM_PK = new PublicKey("D5Fnzt2XCP7xbavWjqdRRJvGxB7uTtmzemaFX1PWnyVu");
const COLLATERAL_PK = new PublicKey("B34xF8mQ9DQ7jHY7mZpVE6SknMw9d8SRHjrcYYfZaYPG");
const VAULT_PK = new PublicKey("45ie9QT16AE1MekYjKu2Z2mKat6eeGqQoL96dnFmxYNP");
const STRANGER_PK = new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");

function makeMarket(adminOverride?: PublicKey, oracleOverride?: PublicKey) {
  return {
    slabAddress: SLAB_PK,
    programId: PROGRAM_PK,
    header: {
      admin: adminOverride ?? ADMIN_PK,
      paused: false,
    },
    config: {
      oracleAuthority: oracleOverride ?? ORACLE_PK,
      collateralMint: COLLATERAL_PK,
      vaultPubkey: VAULT_PK,
    },
  } as any;
}

// ─── Import the pure helper functions directly ────────────────────────────────
// We extract the validation logic by reading the source to confirm the functions exist
// and test them through the hook behavior using mocking.

// Mock the heavy deps so we can import the hook in a test environment
vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: vi.fn(),
  useConnectionCompat: vi.fn(() => ({ connection: {} })),
}));
vi.mock("@/lib/tx", () => ({
  sendTx: vi.fn().mockResolvedValue({ signature: "abc123" }),
}));
vi.mock("@percolatorct/sdk", async () => {
  const actual = await vi.importActual("@percolatorct/sdk");
  return {
    ...actual,
    encodeSetOracleAuthority: vi.fn(() => Buffer.from([])),
    encodePushOraclePrice: vi.fn(() => Buffer.from([])),
    encodeSetOraclePriceCap: vi.fn(() => Buffer.from([])),
    encodeTopUpInsurance: vi.fn(() => Buffer.from([])),
    encodeRenounceAdmin: vi.fn(() => Buffer.from([])),
    encodeCreateInsuranceMint: vi.fn(() => Buffer.from([])),
    encodeSetRiskThreshold: vi.fn(() => Buffer.from([])),
    encodePauseMarket: vi.fn(() => Buffer.from([])),
    encodeUnpauseMarket: vi.fn(() => Buffer.from([])),
    buildAccountMetas: vi.fn(() => []),
    buildIx: vi.fn(() => ({ programId: PROGRAM_PK, keys: [], data: Buffer.from([]) })),
    deriveVaultAuthority: vi.fn(() => [VAULT_PK]),
    deriveInsuranceLpMint: vi.fn(() => [VAULT_PK]),
  };
});

import { useWalletCompat } from "@/hooks/useWalletCompat";
import { renderHook } from "@testing-library/react";
import { useAdminActions } from "@/hooks/useAdminActions";

function mockWallet(pubkey: PublicKey) {
  vi.mocked(useWalletCompat).mockReturnValue({
    publicKey: pubkey,
    signTransaction: vi.fn(),
  });
}

describe("useAdminActions — PERC-8311 authority pre-flight checks", () => {
  describe("setOracleAuthority", () => {
    it("throws when wallet is not oracle authority", async () => {
      mockWallet(STRANGER_PK);
      const { result } = renderHook(() => useAdminActions());
      await expect(
        result.current.setOracleAuthority(makeMarket(), ORACLE_PK.toBase58()),
      ).rejects.toThrow(/not the oracle authority/i);
    });

    it("throws a migration error when wallet IS oracle authority", async () => {
      mockWallet(ORACLE_PK);
      const { result } = renderHook(() => useAdminActions());
      await expect(
        result.current.setOracleAuthority(makeMarket(), ORACLE_PK.toBase58()),
      ).rejects.toThrow(/server-side oracle flow/i);
    });
  });

  describe("pushPrice", () => {
    it("throws when wallet is not oracle authority", async () => {
      mockWallet(STRANGER_PK);
      const { result } = renderHook(() => useAdminActions());
      await expect(
        result.current.pushPrice(makeMarket(), "50000000000"),
      ).rejects.toThrow(/not the oracle authority/i);
    });

    it("throws a migration error when wallet IS oracle authority", async () => {
      mockWallet(ORACLE_PK);
      const { result } = renderHook(() => useAdminActions());
      await expect(
        result.current.pushPrice(makeMarket(), "50000000000"),
      ).rejects.toThrow(/server-side oracle flow/i);
    });
  });

  describe("pauseMarket", () => {
    // v17: PauseMarket (tag 56) was removed. The instruction no longer exists in the
    // v17 on-chain program (tag 56 is now TopUpInsuranceDomain). Both admin and
    // stranger wallets now receive the same "removed in v17" error regardless of authority.
    it("throws v17 removed-instruction error for any wallet (stranger)", async () => {
      mockWallet(STRANGER_PK);
      const { result } = renderHook(() => useAdminActions());
      await expect(
        result.current.pauseMarket(makeMarket()),
      ).rejects.toThrow(/PauseMarket was removed in v17/i);
    });

    it("throws v17 removed-instruction error for admin wallet too", async () => {
      mockWallet(ADMIN_PK);
      const { result } = renderHook(() => useAdminActions());
      await expect(
        result.current.pauseMarket(makeMarket()),
      ).rejects.toThrow(/PauseMarket was removed in v17/i);
    });
  });

  describe("unpauseMarket", () => {
    // v17: UnpauseMarket (tag 58) was removed. Tag 58 is now UpdateFeeRedirectPolicy.
    // Both admin and stranger wallets now receive the same "removed in v17" error.
    it("throws v17 removed-instruction error for any wallet (stranger)", async () => {
      mockWallet(STRANGER_PK);
      const { result } = renderHook(() => useAdminActions());
      await expect(
        result.current.unpauseMarket(makeMarket()),
      ).rejects.toThrow(/UnpauseMarket was removed in v17/i);
    });

    it("throws v17 removed-instruction error for admin wallet too", async () => {
      mockWallet(ADMIN_PK);
      const { result } = renderHook(() => useAdminActions());
      await expect(
        result.current.unpauseMarket(makeMarket()),
      ).rejects.toThrow(/UnpauseMarket was removed in v17/i);
    });
  });

  describe("renounceAdmin", () => {
    it("throws when wallet is not admin", async () => {
      mockWallet(STRANGER_PK);
      const { result } = renderHook(() => useAdminActions());
      await expect(
        result.current.renounceAdmin(makeMarket()),
      ).rejects.toThrow(/not the market admin/i);
    });

    it("succeeds when wallet IS admin", async () => {
      mockWallet(ADMIN_PK);
      const { result } = renderHook(() => useAdminActions());
      await expect(
        result.current.renounceAdmin(makeMarket()),
      ).resolves.not.toThrow();
    });
  });

  describe("resetRiskGate", () => {
    // v17: SetRiskThreshold (tag 11) was removed. The stub throws immediately with a
    // descriptive "removed in v17" error for any caller, regardless of admin authority.
    it("throws v17 removed-instruction error for any wallet", async () => {
      mockWallet(STRANGER_PK);
      const { result } = renderHook(() => useAdminActions());
      await expect(
        result.current.resetRiskGate(makeMarket()),
      ).rejects.toThrow(/SetRiskThreshold.*removed in v17/i);
    });
  });

  describe("createInsuranceMint", () => {
    it("throws — moved to percolator-stake", async () => {
      mockWallet(STRANGER_PK);
      const { result } = renderHook(() => useAdminActions());
      await expect(
        result.current.createInsuranceMint(makeMarket()),
      ).rejects.toThrow(/percolator-stake/i);
    });
  });

  describe("topUpInsurance", () => {
    it("does NOT require admin authority (any token holder can top up)", async () => {
      mockWallet(STRANGER_PK);
      const { result } = renderHook(() => useAdminActions());
      // Should NOT throw authority error (may throw for other reasons like ATA in test env)
      try {
        await result.current.topUpInsurance(makeMarket(), 1000n);
      } catch (err) {
        expect((err as Error).message).not.toMatch(/not the market admin/i);
        expect((err as Error).message).not.toMatch(/not the oracle authority/i);
      }
    });
  });

  describe("error message quality", () => {
    // Use renounceAdmin (authority check still present in v17) to verify error quality.
    // pauseMarket/unpauseMarket were removed in v17 and no longer run authority checks.
    it("includes truncated wallet address in error message (via renounceAdmin)", async () => {
      mockWallet(STRANGER_PK);
      const { result } = renderHook(() => useAdminActions());
      await expect(
        result.current.renounceAdmin(makeMarket()),
      ).rejects.toThrow(STRANGER_PK.toBase58().slice(0, 8));
    });

    it("includes truncated admin address in error message (via renounceAdmin)", async () => {
      mockWallet(STRANGER_PK);
      const { result } = renderHook(() => useAdminActions());
      await expect(
        result.current.renounceAdmin(makeMarket()),
      ).rejects.toThrow(ADMIN_PK.toBase58().slice(0, 8));
    });
  });
});
