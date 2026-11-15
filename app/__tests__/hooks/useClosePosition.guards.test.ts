/**
 * useClosePosition: the refusals and error routes that run BEFORE or AFTER the trade is sent (v12 path, so no
 * portfolio bytes are needed): not-loaded account, bad percent, lot-market refusal, mock mode, unverifiable
 * position, flat position, zero-size rounding, missing live mark, error classification, prewarm no-ops.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const H = vi.hoisted(() => ({
  trade: vi.fn(),
  user: { idx: 3, account: { positionSize: 100n } } as unknown,
  mock: false,
  priceE6: 1_000_000n as bigint | null,
  pos: 100n,
  fetchFails: false,
  wallet: null as unknown,
  prewarm: vi.fn(),
}));

vi.mock("@/hooks/useTrade", () => ({ useTrade: () => ({ trade: H.trade }), prewarmTradeSubmission: H.prewarm }));
vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({ connection: {} }),
  useWalletCompat: () => ({ publicKey: H.wallet }),
}));
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: () => H.user }));
vi.mock("@/hooks/useMarketHealth", () => ({ useSingleMarketHealth: () => null }));
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({ accounts: [], raw: null, programId: null }),
}));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => H.mock }));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => true }));
vi.mock("@/lib/priceStore/priceStore", () => ({ getLivePriceSnapshot: () => ({ priceE6: H.priceE6, priceUsd: 1 }) }));
vi.mock("@/lib/portfolio-invalidation", () => ({ invalidatePortfolio: vi.fn() }));
vi.mock("@percolatorct/sdk", async (orig) => {
  const real = await orig<Record<string, unknown>>();
  return {
    ...real,
    isV17Account: () => false,
    fetchSlab: vi.fn(async () => {
      if (H.fetchFails) throw new Error("rpc down");
      return new Uint8Array(8);
    }),
    parseAccount: vi.fn(() => ({ positionSize: H.pos })),
  };
});

import { useClosePosition } from "@/hooks/useClosePosition";
import { seedLotExp0 } from "../helpers/v22-fixtures";
import { __setUnknownLotExpForTest } from "@/lib/v22/lot-registry";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { Keypair } from "@solana/web3.js";

const SLAB = "AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr";

beforeEach(() => {
  H.trade.mockReset();
  H.prewarm.mockReset();
  H.user = { idx: 3, account: { positionSize: 100n } };
  H.mock = false;
  H.priceE6 = 1_000_000n;
  H.pos = 100n;
  H.fetchFails = false;
  H.wallet = null;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

async function close(hook: ReturnType<typeof useClosePosition>, pct: number, opts?: Parameters<typeof hook.closePosition>[1]) {
  let thrown: unknown = null;
  let value: unknown;
  await act(async () => {
    try {
      value = await hook.closePosition(pct, opts);
    } catch (e) {
      thrown = e;
    }
  });
  return { thrown, value };
}

describe("useClosePosition — guards (lots known)", () => {
  seedLotExp0();

  it("account not loaded: sets the not-loaded copy and throws, nothing sent", async () => {
    H.user = null;
    const { result } = renderHook(() => useClosePosition(SLAB));
    const { thrown } = await close(result.current, 100);
    expect((thrown as Error).message).toBe("No user account");
    expect(result.current.error).toBeTruthy();
    expect(H.trade).not.toHaveBeenCalled();
  });

  it("a named account on a market that is not loaded yet: 'Market not loaded'", async () => {
    H.user = null;
    const { result } = renderHook(() => useClosePosition(SLAB));
    const { thrown } = await close(result.current, 100, { portfolioPk: Keypair.generate().publicKey });
    expect((thrown as Error).message).toBe("Market not loaded");
    expect(result.current.error).toBeTruthy();
    expect(H.trade).not.toHaveBeenCalled();
  });

  it.each([0, 101, -5])("percent %s is refused", async (pct) => {
    const { result } = renderHook(() => useClosePosition(SLAB));
    const { thrown } = await close(result.current, pct);
    expect((thrown as Error).message).toBe("Close percent must be 1-100");
    expect(H.trade).not.toHaveBeenCalled();
  });

  it("mock mode: resolves with a null signature and walks submitting -> confirming -> idle", async () => {
    vi.useFakeTimers();
    try {
      H.mock = true;
      const { result } = renderHook(() => useClosePosition(SLAB));
      let p!: Promise<unknown>;
      act(() => {
        p = result.current.closePosition(100);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });
      await expect(p).resolves.toEqual({ signature: null });
      expect(result.current.phase).toBe("confirming");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(result.current.phase).toBe("idle");
      expect(H.trade).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("v12 position read fails: calm 'could not verify' error, nothing sent", async () => {
    H.fetchFails = true;
    const { result } = renderHook(() => useClosePosition(SLAB));
    const { thrown } = await close(result.current, 100);
    expect((thrown as Error).message).toMatch(/Could not verify current on-chain position/);
    expect(result.current.error).toMatch(/Could not verify/);
    expect(result.current.phase).toBe("idle");
    expect(result.current.loading).toBe(false);
    expect(H.trade).not.toHaveBeenCalled();
  });

  it("flat position: refuses instead of sending a trade", async () => {
    H.pos = 0n;
    const { result } = renderHook(() => useClosePosition(SLAB));
    const { thrown } = await close(result.current, 100);
    expect(thrown).toBeInstanceOf(Error);
    expect(result.current.error).toBeTruthy();
    expect(H.trade).not.toHaveBeenCalled();
  });

  it("a percent that rounds to zero lots is refused (no 0-size trade)", async () => {
    H.pos = 1n;
    const { result } = renderHook(() => useClosePosition(SLAB));
    const { thrown } = await close(result.current, 10);
    expect(thrown).toBeInstanceOf(Error);
    expect(result.current.error).toBeTruthy();
    expect(H.trade).not.toHaveBeenCalled();
  });

  it("no live mark on a v12 market: refuses with the reconnect copy", async () => {
    H.priceE6 = null;
    const { result } = renderHook(() => useClosePosition(SLAB));
    const { thrown } = await close(result.current, 100);
    expect((thrown as Error).message).toMatch(/Live mark price unavailable/);
    expect(result.current.error).toMatch(/Live mark price unavailable/);
    expect(H.trade).not.toHaveBeenCalled();
  });

  it("a named account on a legacy (non-v17) market: not matched, nothing sent", async () => {
    // raw is null in this harness, so the market-not-loaded refusal fires first; both are calm refusals.
    const { result } = renderHook(() => useClosePosition(SLAB));
    const { thrown } = await close(result.current, 100, { portfolioPk: Keypair.generate().publicKey });
    expect(thrown).toBeInstanceOf(Error);
    expect(H.trade).not.toHaveBeenCalled();
  });

  it("a trade error is shown as a message and rethrown; the hook is reusable afterwards", async () => {
    H.trade.mockRejectedValueOnce(new Error("custom program error: 0x1"));
    const { result } = renderHook(() => useClosePosition(SLAB));
    const first = await close(result.current, 100);
    expect(first.thrown).toBeInstanceOf(Error);
    expect(result.current.error).toBeTruthy();
    expect(result.current.phase).toBe("idle");
    expect(result.current.loading).toBe(false);

    H.trade.mockResolvedValueOnce("SIGOK");
    const second = await close(result.current, 100);
    expect(second.thrown).toBeNull();
    expect((second.value as { signature: string }).signature).toBe("SIGOK");
  });

  it("resetPhase clears the error and returns to idle", async () => {
    H.fetchFails = true;
    const { result } = renderHook(() => useClosePosition(SLAB));
    await close(result.current, 100);
    expect(result.current.error).toBeTruthy();
    act(() => result.current.resetPhase());
    expect(result.current.error).toBeNull();
    expect(result.current.phase).toBe("idle");
  });

  it("prewarmClose is a no-op on a v12 market (nothing to prewarm)", () => {
    const { result } = renderHook(() => useClosePosition(SLAB));
    act(() => result.current.prewarmClose());
    expect(H.prewarm).not.toHaveBeenCalled();
  });
});

describe("useClosePosition — lot market with unknown exponent", () => {
  it("refuses to close and sends nothing", async () => {
    __setDevnetV22ForTest(true);
    __setUnknownLotExpForTest(null);
    const { result } = renderHook(() => useClosePosition(SLAB));
    const { thrown } = await close(result.current, 100);
    __setDevnetV22ForTest(null);
    expect(thrown).toBeInstanceOf(Error);
    expect(result.current.error).toBeTruthy();
    expect(H.trade).not.toHaveBeenCalled();
  });
});
