/** Mock scaffolding copied from SlabProvider-visibility-poll.test.tsx. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
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



/**
 * #3786 (R3-8 backoff) and #3790 (N5 readFailing) both count failed backup polls in SlabProvider. After merging them the
 * counter must move ONCE per failed poll: "NO CONNECTION" only after 2 consecutive failures, and the backoff doubles per
 * failure (5s -> 10s -> 20s), not twice per failure. A good read clears both.
 */
describe("SlabProvider backup poll: one failure counter drives readFailing and the backoff", () => {
  beforeEach(() => {
    vi.resetModules();
    getAccountInfo.mockReset();
    onAccountChange.mockClear();
    onAccountChange.mockReturnValue(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("readFailing after the 2nd failed poll (not the 1st); delays 10s then 20s; a good read clears it and restores 5s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const good = { data: new Uint8Array(1024), owner: new PublicKey(ALLOWED_PROGRAM) };
    getAccountInfo.mockResolvedValueOnce(good); // initial load
    const { SlabProvider, useSlabState } = await import("@/components/providers/SlabProvider");
    const wrapper: FC<{ children: ReactNode }> = ({ children }) => <SlabProvider slabAddress={SLAB_ADDRESS}>{children}</SlabProvider>;
    const { result } = renderHook(() => useSlabState(), { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(getAccountInfo).toHaveBeenCalledTimes(1);
    expect(result.current.config).toBeTruthy();

    getAccountInfo.mockRejectedValue(new Error("503"));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); }); // poll 2: first failure
    expect(getAccountInfo).toHaveBeenCalledTimes(2);
    expect(result.current.readFailing ?? false).toBe(false);

    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); }); // backoff after 1 failure is 10s, not 20s... and not 5s
    expect(getAccountInfo).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); }); // poll 3: second failure
    expect(getAccountInfo).toHaveBeenCalledTimes(3);
    expect(result.current.readFailing).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(19_000); }); // backoff after 2 failures is 20s
    expect(getAccountInfo).toHaveBeenCalledTimes(3);
    getAccountInfo.mockResolvedValue(good);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); }); // poll 4: success
    expect(getAccountInfo).toHaveBeenCalledTimes(4);
    expect(result.current.readFailing).toBe(false);

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); }); // steady cadence again
    expect(getAccountInfo).toHaveBeenCalledTimes(5);
  });

  it("a WebSocket update does not clear readFailing while HTTP reads keep failing (no badge flicker)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const good = { data: new Uint8Array(1024), owner: new PublicKey(ALLOWED_PROGRAM) };
    getAccountInfo.mockResolvedValueOnce(good);
    const { SlabProvider, useSlabState } = await import("@/components/providers/SlabProvider");
    const wrapper: FC<{ children: ReactNode }> = ({ children }) => <SlabProvider slabAddress={SLAB_ADDRESS}>{children}</SlabProvider>;
    const { result } = renderHook(() => useSlabState(), { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(result.current.config).toBeTruthy();

    getAccountInfo.mockRejectedValue(new Error("503"));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(result.current.readFailing).toBe(true);

    // The socket keeps delivering (different bytes so the byte-equality short-circuit is not hit).
    const wsHandler = onAccountChange.mock.calls[0][1] as (info: { data: Uint8Array; owner: PublicKey }) => void;
    const changed = new Uint8Array(1024);
    changed[0] = 7;
    await act(async () => { wsHandler({ data: changed, owner: new PublicKey(ALLOWED_PROGRAM) }); });
    expect(result.current.readFailing).toBe(true);

    // Only a successful HTTP read clears it.
    getAccountInfo.mockResolvedValue(good);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(result.current.readFailing).toBe(false);
  });
});
