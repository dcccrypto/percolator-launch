/**
 * useOracleFreshness — future admin timestamp handling and shared timer.
 */
import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";

let slabState: Record<string, unknown> = {};
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => slabState }));
vi.mock("@/hooks/useClusterSlot", () => ({ useClusterSlotObservation: () => null }));

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
});
afterEach(() => vi.useRealTimers());

describe("admin authorityTimestamp in the future", () => {
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

describe("future stamp pin is shared across mounts", () => {
  it("a remount after the stamp aged out does not re-freshen it", () => {
    const future = BigInt(NOW / 1000 + 7200);
    slabState = adminSlab(future);
    const first = renderHook(() => useOracleFreshness({ trackSeconds: true }));
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(first.result.current.level).toBe("stale");
    const second = renderHook(() => useOracleFreshness({ trackSeconds: true }));
    expect(second.result.current.level).toBe("stale");
    first.unmount();
    second.unmount();
  });

  it("a new past stamp after a future one ages from the new stamp", () => {
    slabState = adminSlab(BigInt(NOW / 1000 + 9000));
    const { result, rerender } = renderHook(() => useOracleFreshness({ trackSeconds: true }));
    slabState = adminSlab(BigInt(NOW / 1000 - 10));
    rerender();
    expect(result.current.elapsedSecs).toBe(10);
  });
});

describe("shared 1s timer", () => {
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
