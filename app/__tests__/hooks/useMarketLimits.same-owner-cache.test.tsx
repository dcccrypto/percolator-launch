// @vitest-environment jsdom
/**
 * #2985 corrections at the hook level: the post-burn LP-owner resolution is cached and
 * shared per market (one getProgramAccounts-backed resolve, not one per ticket mount),
 * expires (TransferPortfolioOwnership, tag 72, can move the LP), its open-blocking
 * window is bounded, and a failure retries in the background without blocking.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

const CREATOR = new PublicKey(new Uint8Array(32).fill(0x9c));
const WALLET = new PublicKey(new Uint8Array(32).fill(0x42)).toBase58();
const SLAB = "AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr";
const PROGRAM = "GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ";

const mocks = vi.hoisted(() => ({
  resolveMarketLp: vi.fn(),
  assetProfile: null as unknown,
  connection: {},
}));

vi.mock("@/lib/limits/flags", async (orig) => ({
  ...(await orig<typeof import("@/lib/limits/flags")>()),
  limitsFlags: () => ({ p1: false, p2: false, p2FeeCharged: false, p3: false }),
}));
vi.mock("@/lib/market-lp", () => ({ resolveMarketLp: mocks.resolveMarketLp }));
vi.mock("@/lib/pollWhenVisible", () => ({ pollWhenVisible: () => () => undefined }));
vi.mock("@/hooks/useWalletCompat", () => ({ useConnectionCompat: () => ({ connection: mocks.connection }) }));
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({ raw: null, programId: new PublicKey(PROGRAM), assetProfile: mocks.assetProfile }),
}));

import { useMarketLimits, __resetSameOwnerLpCache } from "@/hooks/useMarketLimits";

const RENOUNCED = { assetAdmin: PublicKey.default };

beforeEach(() => {
  __resetSameOwnerLpCache();
  mocks.resolveMarketLp.mockReset();
  mocks.assetProfile = RENOUNCED;
});
afterEach(() => vi.useRealTimers());

describe("caching / sharing", () => {
  it("resolves once per market across remounts; a remount starts NOT pending", async () => {
    mocks.resolveMarketLp.mockResolvedValue({ owner: CREATOR });
    const a = renderHook(() => useMarketLimits(SLAB, 0, WALLET));
    await waitFor(() => expect(a.result.current.sameOwnerLpOwner).not.toBeNull());
    a.unmount();

    const b = renderHook(() => useMarketLimits(SLAB, 0, WALLET));
    // First render of the remount already has the owner: no pending flash, no RPC.
    expect(b.result.current.sameOwnerPending).toBe(false);
    expect(Array.from(b.result.current.sameOwnerLpOwner ?? [])).toEqual(Array.from(CREATOR.toBytes()));
    expect(mocks.resolveMarketLp).toHaveBeenCalledTimes(1);
  });

  it("concurrent mounts (desktop + mobile rail) share ONE in-flight resolve", async () => {
    let release!: (v: unknown) => void;
    mocks.resolveMarketLp.mockReturnValue(new Promise((r) => (release = r)));
    const a = renderHook(() => useMarketLimits(SLAB, 0, WALLET));
    const b = renderHook(() => useMarketLimits(SLAB, 0, WALLET));
    expect(a.result.current.sameOwnerPending).toBe(true);
    await act(async () => release({ owner: CREATOR }));
    await waitFor(() => expect(b.result.current.sameOwnerLpOwner).not.toBeNull());
    expect(a.result.current.sameOwnerLpOwner).not.toBeNull();
    expect(mocks.resolveMarketLp).toHaveBeenCalledTimes(1);
  });

  it("the cache expires (the LP portfolio can be transferred, tag 72)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    mocks.resolveMarketLp.mockResolvedValue({ owner: CREATOR });
    const a = renderHook(() => useMarketLimits(SLAB, 0, WALLET));
    await waitFor(() => expect(a.result.current.sameOwnerLpOwner).not.toBeNull());
    a.unmount();
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    const b = renderHook(() => useMarketLimits(SLAB, 0, WALLET));
    await waitFor(() => expect(mocks.resolveMarketLp).toHaveBeenCalledTimes(2));
    b.unmount();
  });
});

describe("bounded, non-blocking failure handling", () => {
  it("a failed first attempt ends pending at once and retries in the background", async () => {
    vi.useFakeTimers();
    mocks.resolveMarketLp.mockRejectedValue(new Error("429"));
    const { result } = renderHook(() => useMarketLimits(SLAB, 0, WALLET));
    expect(result.current.sameOwnerPending).toBe(true);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.sameOwnerPending).toBe(false);
    expect(result.current.sameOwnerUnresolved).toBe(true);
    expect(mocks.resolveMarketLp).toHaveBeenCalledTimes(1);

    mocks.resolveMarketLp.mockResolvedValue({ owner: CREATOR });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(mocks.resolveMarketLp).toHaveBeenCalledTimes(2);
    expect(result.current.sameOwnerUnresolved).toBe(false);
    expect(result.current.sameOwnerLpOwner).not.toBeNull();
  });

  it("retries are bounded (1 + 3) and never re-enter pending", async () => {
    vi.useFakeTimers();
    mocks.resolveMarketLp.mockResolvedValue(null);
    const { result } = renderHook(() => useMarketLimits(SLAB, 0, WALLET));
    for (const ms of [0, 2_000, 8_000, 30_000, 120_000]) {
      await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
      expect(result.current.sameOwnerPending).toBe(false);
    }
    expect(mocks.resolveMarketLp).toHaveBeenCalledTimes(4);
  });

  it("a hanging first attempt stops blocking after the 8 s cap", async () => {
    vi.useFakeTimers();
    mocks.resolveMarketLp.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useMarketLimits(SLAB, 0, WALLET));
    expect(result.current.sameOwnerPending).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(7_999); });
    expect(result.current.sameOwnerPending).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.sameOwnerPending).toBe(false);
  });
});

describe("scope", () => {
  it("unknown profile (null): not pending, no resolve", () => {
    mocks.assetProfile = null;
    const { result } = renderHook(() => useMarketLimits(SLAB, 0, WALLET));
    expect(result.current.sameOwnerPending).toBe(false);
    expect(mocks.resolveMarketLp).not.toHaveBeenCalled();
  });

  it("no wallet: not pending, no resolve", () => {
    const { result } = renderHook(() => useMarketLimits(SLAB, 0, null));
    expect(result.current.sameOwnerPending).toBe(false);
    expect(mocks.resolveMarketLp).not.toHaveBeenCalled();
  });
});
