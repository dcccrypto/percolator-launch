/**
 * Confirming a close before that market's position had loaded threw "No user account" before
 * any setError, so every close UI showed nothing. The hook now sets COPY.closeNotLoaded and still
 * throws (callers keep the modal open on it); the in-progress guard stays silent.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { BANNED } from "@/__tests__/lib/banned-terms-harvest";

const NOT_LOADED = "We couldn't load your position on this market yet. Nothing was sent. Try again in a moment.";

let acct: unknown = null;
let release: (() => void) | null = null;
const tradeMock = vi.fn(() => new Promise<string>((r) => { release = () => r("SIG"); }));
vi.mock("@/hooks/useTrade", () => ({ useTrade: () => ({ trade: tradeMock }), prewarmTradeSubmission: vi.fn(), findV17Portfolio: vi.fn() }));
vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({ connection: {} }),
  useWalletCompat: () => ({ publicKey: null }),
}));
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: () => acct }));
vi.mock("@/hooks/useMarketHealth", () => ({ useSingleMarketHealth: () => null }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => ({ accounts: [], raw: null, programId: null }) }));
vi.mock("@/lib/priceStore/priceStore", () => ({ getLivePriceSnapshot: () => ({ priceE6: 1_000_000n, priceUsd: 1 }) }));
vi.mock("@/lib/portfolio-invalidation", () => ({ invalidatePortfolio: vi.fn() }));
vi.mock("@percolatorct/sdk", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isV17Account: () => false,
  fetchSlab: vi.fn(async () => new Uint8Array(8)),
  parseAccount: vi.fn(() => ({ positionSize: 100n })),
}));

import { useClosePosition } from "@/hooks/useClosePosition";
const SLAB = "AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr";

describe("close before this market's position has loaded", () => {
  beforeEach(() => { acct = null; tradeMock.mockClear(); });

  it("shows the not-loaded message and still throws the same plain error", async () => {
    const { result } = renderHook(() => useClosePosition(SLAB));
    let thrown: unknown = null;
    await act(async () => { try { await result.current.closePosition(100); } catch (e) { thrown = e; } });
    expect((thrown as Error).message).toBe("No user account"); // lpsel-live.test.tsx:123 retry still matches
    expect(result.current.error).toBe(NOT_LOADED);
    for (const [term, re] of BANNED) expect(re.test(result.current.error ?? ""), term).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(result.current.phase).toBe("idle");
    expect(tradeMock).not.toHaveBeenCalled();
  });

  it("a retry after the account lands clears the message; a double click stays silent", async () => {
    const { result, rerender } = renderHook(() => useClosePosition(SLAB));
    await act(async () => { await result.current.closePosition(100).catch(() => {}); });
    expect(result.current.error).toBe(NOT_LOADED);

    acct = { idx: 3, account: { positionSize: 100n } };
    rerender();
    let p!: Promise<unknown>;
    act(() => { p = result.current.closePosition(100); });
    expect(result.current.error).toBeNull();
    await act(async () => { await expect(result.current.closePosition(100)).rejects.toThrow("Close already in progress"); });
    expect(result.current.error).toBeNull();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); release?.(); await p; });
    expect(result.current.error).toBeNull();
  });

  it("resetPhase clears the message", async () => {
    const { result } = renderHook(() => useClosePosition(SLAB));
    await act(async () => { await result.current.closePosition(100).catch(() => {}); });
    expect(result.current.error).toBe(NOT_LOADED);
    act(() => result.current.resetPhase());
    expect(result.current.error).toBeNull();
  });
});
