/**
 * SlabProvider backup poll is paused while the tab is hidden (RPC-credit saving) and resumes
 * with an immediate catch-up read when the tab is shown again.
 * (Mock scaffolding copied from SlabProvider-allowlist.test.tsx.)
 *
 * Original header, for the scaffolding below: SlabProvider phishing guard.
 *
 * Validates that the provider refuses to publish `programId` to consumers
 * when the slab account is owned by a program not in `getAllProgramIds()`.
 * Without this gate, a phishing URL like /trade/<malicious_slab> would let
 * downstream hooks (useDeposit/useWithdraw/useTrade/useInitUser) build
 * wallet-signed transactions against an attacker-controlled BPF program
 * that can CPI spl_token::Transfer to drain the user's ATA.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { FC, ReactNode } from "react";
import { PublicKey } from "@solana/web3.js";
import { getConfig } from "@/lib/config";

// The wrapper this deployment is configured for (it is in getAllProgramIds()). Read from config, not
// hardcoded: the old pinned v17 devnet id went stale at the v18 redeploy and the legitimate-path test
// failed because the guard (correctly) refused it.
const ALLOWED_PROGRAM = getConfig().programId;
const ATTACKER_PROGRAM = "11111111111111111111111111111112";
const SLAB_ADDRESS = "So11111111111111111111111111111111111111112";

// Stub the SDK parsers so we don't have to hand-craft large v17 slab buffers.
// The gate runs BEFORE parseHeader, so legitimate parses succeed and
// attacker slabs are rejected on the owner check regardless of bytes.
// v17: EXPECTED_SLAB_VERSION = 16 — mock must return version=16 to pass the version check.
// Partial mock: SlabProvider transitively imports lib/v17-adl, which reads further SDK constants
// (V17_ASSET_SLOT_WRAPPER_LEN, ...) at module load; a full replacement breaks on every new one.
vi.mock("@percolatorct/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@percolatorct/sdk")>()),
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
  V17_WRAPPER_CONFIG_LEN: 576,
  V17_MARKET_GROUP_OFF: 592,
  V17_MARKET_GROUP_LEN: 758,
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


function setVisibility(v: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("SlabProvider backup poll visibility gating", () => {
  beforeEach(() => {
    vi.resetModules();
    getAccountInfo.mockReset();
    onAccountChange.mockClear();
    onAccountChange.mockReturnValue(1);
    getAccountInfo.mockResolvedValue({ data: new Uint8Array(1024), owner: new PublicKey(ALLOWED_PROGRAM) });
    setVisibility("visible");
  });
  afterEach(() => {
    vi.useRealTimers();
    setVisibility("visible");
  });

  it("polls every 5s while visible, makes ZERO reads while hidden, and re-reads at once on return", async () => {
    vi.useFakeTimers();
    const { SlabProvider, useSlabState } = await import("@/components/providers/SlabProvider");
    const wrapper: FC<{ children: ReactNode }> = ({ children }) => (
      <SlabProvider slabAddress={SLAB_ADDRESS}>{children}</SlabProvider>
    );
    renderHook(() => useSlabState(), { wrapper });
    await vi.advanceTimersByTimeAsync(10); // initial read
    expect(getAccountInfo).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(getAccountInfo).toHaveBeenCalledTimes(2); // visible: backup poll still runs

    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getAccountInfo).toHaveBeenCalledTimes(2); // hidden for a minute: no reads

    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(10);
    expect(getAccountInfo).toHaveBeenCalledTimes(3); // immediate catch-up on return

    await vi.advanceTimersByTimeAsync(5_000);
    expect(getAccountInfo).toHaveBeenCalledTimes(4); // cadence resumed
  });
});
