/**
 * SlabProvider phishing guard.
 *
 * Validates that the provider refuses to publish `programId` to consumers
 * when the slab account is owned by a program not in `getAllProgramIds()`.
 * Without this gate, a phishing URL like /trade/<malicious_slab> would let
 * downstream hooks (useDeposit/useWithdraw/useTrade/useInitUser) build
 * wallet-signed transactions against an attacker-controlled BPF program
 * that can CPI spl_token::Transfer to drain the user's ATA.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { FC, ReactNode } from "react";
import { PublicKey } from "@solana/web3.js";

const ALLOWED_PROGRAM = "FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD"; // devnet default + large tier
const ATTACKER_PROGRAM = "11111111111111111111111111111112";
const SLAB_ADDRESS = "So11111111111111111111111111111111111111112";

// Stub the SDK parsers so we don't have to hand-craft large v17 slab buffers.
// The gate runs BEFORE parseHeader, so legitimate parses succeed and
// attacker slabs are rejected on the owner check regardless of bytes.
// v17: EXPECTED_SLAB_VERSION = 16 — mock must return version=16 to pass the version check.
vi.mock("@percolatorct/sdk", () => ({
  parseHeader: () => ({ version: 16 }),
  parseConfig: () => ({
    collateralMint: new PublicKey("11111111111111111111111111111111"),
    vaultPubkey: new PublicKey("11111111111111111111111111111111"),
  }),
  parseEngine: () => ({}),
  parseParams: () => ({}),
  parseAllAccounts: () => [],
  // v17 additions — return false so tests exercise the v12 parse path
  isV17Account: () => false,
  parseWrapperConfigV17: () => ({}),
  parseAssetOracleProfileV17: () => ({ oracleLegFeeds: [] }),
  V17_HEADER_LEN: 16,
  V17_WRAPPER_CONFIG_LEN: 432,
}));

vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/mock-trade-data", () => ({
  isMockSlab: () => false,
  getMockSlabState: () => null,
}));

const getAccountInfo = vi.fn();
const onAccountChange = vi.fn().mockReturnValue(1);
const removeAccountChangeListener = vi.fn();

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({
    connection: {
      rpcEndpoint: "http://test",
      getAccountInfo,
      onAccountChange,
      removeAccountChangeListener,
    },
  }),
}));

describe("SlabProvider phishing guard", () => {
  beforeEach(() => {
    getAccountInfo.mockReset();
    onAccountChange.mockClear();
    onAccountChange.mockReturnValue(1);
  });

  it("ACCEPTS a slab owned by a known program (legitimate path)", async () => {
    getAccountInfo.mockResolvedValue({
      data: new Uint8Array(1024),
      owner: new PublicKey(ALLOWED_PROGRAM),
    });

    const { SlabProvider, useSlabState } = await import(
      "@/components/providers/SlabProvider"
    );
    const wrapper: FC<{ children: ReactNode }> = ({ children }) => (
      <SlabProvider slabAddress={SLAB_ADDRESS}>{children}</SlabProvider>
    );

    const { result } = renderHook(() => useSlabState(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeNull();
    expect(result.current.programId?.toBase58()).toBe(ALLOWED_PROGRAM);
    expect(result.current.config).not.toBeNull();
  });

  it("REJECTS a slab owned by an attacker program (exploit case)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    getAccountInfo.mockResolvedValue({
      data: new Uint8Array(1024),
      owner: new PublicKey(ATTACKER_PROGRAM),
    });

    const { SlabProvider, useSlabState } = await import(
      "@/components/providers/SlabProvider"
    );
    const wrapper: FC<{ children: ReactNode }> = ({ children }) => (
      <SlabProvider slabAddress={SLAB_ADDRESS}>{children}</SlabProvider>
    );

    try {
      const { result } = renderHook(() => useSlabState(), { wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.error).toMatch(/not owned by a recognized/i);
      // Critical: programId must be null so downstream hooks short-circuit.
      expect(result.current.programId).toBeNull();
      // Parsed state must not leak from a rejected account.
      expect(result.current.config).toBeNull();
      expect(result.current.engine).toBeNull();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("does NOT echo the attacker program ID in the user-facing error", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    getAccountInfo.mockResolvedValue({
      data: new Uint8Array(1024),
      owner: new PublicKey(ATTACKER_PROGRAM),
    });

    const { SlabProvider, useSlabState } = await import(
      "@/components/providers/SlabProvider"
    );
    const wrapper: FC<{ children: ReactNode }> = ({ children }) => (
      <SlabProvider slabAddress={SLAB_ADDRESS}>{children}</SlabProvider>
    );

    try {
      const { result } = renderHook(() => useSlabState(), { wrapper });
      await waitFor(() => expect(result.current.error).toBeTruthy());

      expect(result.current.error).not.toContain(ATTACKER_PROGRAM);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("REJECTS via the WebSocket subscription path (not just polling)", async () => {
    // Initial poll returns nothing; the WS callback delivers the attacker payload.
    getAccountInfo.mockResolvedValue(null);
    let wsCb: ((info: { data: Buffer; owner: PublicKey }) => void) | null =
      null;
    onAccountChange.mockImplementation((_pk: PublicKey, cb: typeof wsCb) => {
      wsCb = cb;
      return 1;
    });

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { SlabProvider, useSlabState } = await import(
      "@/components/providers/SlabProvider"
    );
    const wrapper: FC<{ children: ReactNode }> = ({ children }) => (
      <SlabProvider slabAddress={SLAB_ADDRESS}>{children}</SlabProvider>
    );

    try {
      const { result } = renderHook(() => useSlabState(), { wrapper });
      await waitFor(() => expect(onAccountChange).toHaveBeenCalled());

      // Push an attacker-owned payload via the WS callback.
      wsCb!({
        data: Buffer.alloc(1024),
        owner: new PublicKey(ATTACKER_PROGRAM),
      });

      await waitFor(() => expect(result.current.error).toBeTruthy());
      expect(result.current.programId).toBeNull();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("does not flap during initial load when owner is undefined", async () => {
    // Hang the RPC so we observe the loading window.
    getAccountInfo.mockImplementation(() => new Promise(() => {}));

    const { SlabProvider, useSlabState } = await import(
      "@/components/providers/SlabProvider"
    );
    const wrapper: FC<{ children: ReactNode }> = ({ children }) => (
      <SlabProvider slabAddress={SLAB_ADDRESS}>{children}</SlabProvider>
    );

    const { result } = renderHook(() => useSlabState(), { wrapper });
    // Brief await to let the effect register.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(true);
  });
});
