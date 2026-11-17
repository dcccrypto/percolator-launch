/**
 * useOracleFreshness — future-timestamp / slot-lag / shared-timer leads.
 */
import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";

let slabState: Record<string, unknown> = {};
let slotObs: { slot: bigint; observedAtMs: number } | null = null;
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => slabState }));
vi.mock("@/hooks/useClusterSlot", () => ({ useClusterSlotObservation: () => slotObs }));

import { useOracleFreshness } from "@/hooks/useOracleFreshness";

const NOW = 1_800_000_000_000;
const AUTH = new PublicKey("Sysvar1111111111111111111111111111111111112");

function adminSlab(authorityTimestamp: bigint) {
  return {
    config: {
      oracleAuthority: AUTH,
      indexFeedId: new PublicKey("SysvarC1ock11111111111111111111111111111111"),
      authorityTimestamp,
      authorityPriceE6: 100_000_000n,
      lastEffectivePriceE6: 100_000_000n,
      collateralMint: AUTH,
    },
    engine: null,
    wrapperConfigV17: null,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  slotObs = null;
});
afterEach(() => vi.useRealTimers());

describe("lead 1: admin authorityTimestamp in the future", () => {
  it("does not read fresh forever from a far-future stamp", () => {
    const future = BigInt(NOW / 1000 + 3600); // chain stamp 1h ahead of client clock
    slabState = adminSlab(future);
    const { result, rerender } = renderHook(() => useOracleFreshness({ trackSeconds: true }));
    expect(result.current.mode).toBe("admin");
    // lastUpdateMs must never be later than now
    expect(result.current.lastUpdateMs!).toBeLessThanOrEqual(Date.now());
    // slab re-polls (new config identity, same stamp) while time passes
    for (let i = 0; i < 5; i++) {
      act(() => {
        vi.advanceTimersByTime(20_000);
      });
      slabState = adminSlab(future);
      rerender();
    }
    expect(result.current.level).toBe("stale");
  });

  it("a past stamp still derives age from the stamp", () => {
    slabState = adminSlab(BigInt(NOW / 1000 - 45));
    const { result } = renderHook(() => useOracleFreshness({ trackSeconds: true }));
    expect(result.current.elapsedSecs).toBe(45);
    expect(result.current.level).toBe("aging");
  });
});

describe("leads 2/3: observed cluster slot lags the push slot", () => {
  it("never derives a push time newer than now", () => {
    slabState = {
      ...adminSlab(0n),
      wrapperConfigV17: { oracleMode: 3, lastGoodOracleSlot: 1000n, markEwmaLastSlot: 1000n },
    };
    slotObs = { slot: 900n, observedAtMs: NOW };
    const { result } = renderHook(() => useOracleFreshness({ trackSeconds: true }));
    if (result.current.lastUpdateMs !== null) {
      expect(result.current.lastUpdateMs).toBeLessThanOrEqual(Date.now());
    }
  });
});

describe("lead 4: shared 1s timer", () => {
  it("is cleared when the last subscriber unmounts", () => {
    slabState = adminSlab(BigInt(NOW / 1000 - 5));
    const a = renderHook(() => useOracleFreshness());
    const b = renderHook(() => useOracleFreshness());
    expect(vi.getTimerCount()).toBe(1);
    a.unmount();
    expect(vi.getTimerCount()).toBe(1);
    b.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
