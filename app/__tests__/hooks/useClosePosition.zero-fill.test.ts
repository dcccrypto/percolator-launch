/**
 * P1 zero-fill coupling on the CLOSE path: useClosePosition routes through
 * useTrade().trade(), which records the measured fill per signature
 * (lib/limits/fill-check.ts). A zero fill must THROW (every caller keeps its
 * modal open and shows the hook error) with the "Market at capacity — no fill"
 * copy, never resolve as a successful close. A full fill resolves normally.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const tradeMock = vi.fn();
vi.mock("@/hooks/useTrade", () => ({ useTrade: () => ({ trade: tradeMock }), prewarmTradeSubmission: vi.fn() }));
vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({ connection: {} }),
  useWalletCompat: () => ({ publicKey: null }),
}));
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: () => ({ idx: 3, account: { positionSize: 100n } }) }));
vi.mock("@/hooks/useMarketHealth", () => ({ useSingleMarketHealth: () => null }));
vi.mock("@/components/providers/SlabProvider", () => ({
  // raw = null => v12 path (fresh read via fetchSlab/parseAccount, mocked below)
  useSlabState: () => ({ accounts: [], raw: null, programId: null }),
}));
vi.mock("@/lib/priceStore/priceStore", () => ({ getLivePriceSnapshot: () => ({ priceE6: 1_000_000n, priceUsd: 1 }) }));
vi.mock("@/lib/portfolio-invalidation", () => ({ invalidatePortfolio: vi.fn() }));
vi.mock("@percolatorct/sdk", async (orig) => {
  const real = await orig<Record<string, unknown>>();
  return {
    ...real,
    isV17Account: () => false,
    fetchSlab: vi.fn(async () => new Uint8Array(8)),
    parseAccount: vi.fn(() => ({ positionSize: 100n })),
  };
});

import { useClosePosition } from "@/hooks/useClosePosition";
import { recordFillResult } from "@/lib/limits/fill-check";
import { COPY } from "@/lib/limits/copy";
import { seedLotExp0 } from "../helpers/v22-fixtures";

seedLotExp0();

const SLAB = "AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr";
beforeEach(() => tradeMock.mockReset());

describe("useClosePosition — measured fill", () => {
  it("zero fill: throws, error = 'Market at capacity — no fill', phase never 'confirming'", async () => {
    tradeMock.mockImplementation(async () => {
      recordFillResult("SIG0", { kind: "zero", filledQ: 0n });
      return "SIG0";
    });
    const { result } = renderHook(() => useClosePosition(SLAB));
    let thrown: unknown = null;
    await act(async () => {
      try {
        await result.current.closePosition(100);
      } catch (e) {
        thrown = e;
      }
    });
    expect(thrown).toBeInstanceOf(Error);
    expect(result.current.error).toBe(COPY.closeZeroFill);
    expect(result.current.error).toContain("Market at capacity — no fill");
    expect(result.current.phase).toBe("idle");
    expect(tradeMock).toHaveBeenCalledWith(expect.objectContaining({ size: -100n }));
  });

  it("full fill: resolves with the signature and the measured fill", async () => {
    tradeMock.mockImplementation(async () => {
      recordFillResult("SIG1", { kind: "full", filledQ: -100n });
      return "SIG1";
    });
    const { result } = renderHook(() => useClosePosition(SLAB));
    let r: unknown;
    await act(async () => {
      r = await result.current.closePosition(100);
    });
    expect(r).toEqual({ signature: "SIG1", fill: { kind: "full", filledQ: -100n } });
    expect(result.current.error).toBeNull();
  });

  it("partial fill: resolves, but says only part closed", async () => {
    tradeMock.mockImplementation(async () => {
      recordFillResult("SIG2", { kind: "partial", filledQ: -40n });
      return "SIG2";
    });
    const { result } = renderHook(() => useClosePosition(SLAB));
    await act(async () => {
      await result.current.closePosition(100);
    });
    expect(result.current.error).toMatch(/^Partially closed/);
  });

  it("not measured (P1 flag off): legacy success path", async () => {
    tradeMock.mockResolvedValue("SIG3");
    const { result } = renderHook(() => useClosePosition(SLAB));
    let r: unknown;
    await act(async () => {
      r = await result.current.closePosition(50);
    });
    expect(r).toEqual({ signature: "SIG3", fill: null });
    expect(result.current.error).toBeNull();
  });
});
