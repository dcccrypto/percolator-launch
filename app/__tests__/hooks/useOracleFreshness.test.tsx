/**
 * useOracleFreshness — leads from J-20261115-APP-BUG-FRESHSLOT, measured with
 * fake timers. Cluster slot + slab are mocked so every number is exact.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";

let slabState: Record<string, unknown> = {};
let observation: { slot: bigint; observedAtMs: number } | null = null;
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => slabState }));
vi.mock("@/hooks/useClusterSlot", () => ({ useClusterSlotObservation: () => observation }));

import { measureSlotMs, useOracleFreshness } from "@/hooks/useOracleFreshness";

const NOW = 1_800_000_000_000;
const PUSH_SLOT = 1_000_000n;

function slab(pushSlot: bigint) {
  return {
    config: {
      oracleAuthority: new PublicKey("Sysvar1111111111111111111111111111111111112"),
      indexFeedId: PublicKey.default,
      authorityTimestamp: 0n,
      authorityPriceE6: 100_000_000n,
      lastEffectivePriceE6: 100_000_000n,
    },
    engine: null,
    wrapperConfigV17: { oracleMode: 3, markEwmaLastSlot: 1n, lastGoodOracleSlot: pushSlot },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  slabState = slab(PUSH_SLOT);
  observation = null;
});
afterEach(() => vi.useRealTimers());

describe("lead 1: SLOT_MS fixed at 400", () => {
  // Push is `slots` behind the cluster slot; true slot time is `slotSec`.
  // true age = slots * slotSec; hook age = slots * 0.4.
  const cases: Array<[number, number]> = [
    [0.4, 150],
    [0.45, 150],
    [0.55, 150],
  ];
  for (const [slotSec, slots] of cases) {
    it(`${slots} slots @ ${slotSec}s: measured hook age vs true age`, () => {
      observation = { slot: PUSH_SLOT + BigInt(slots), observedAtMs: NOW };
      const { result } = renderHook(() => useOracleFreshness({ trackSeconds: true }));
      const trueAge = slots * slotSec;
      const hookAge = result.current.elapsedSecs;
      // eslint-disable-next-line no-console
      console.log(`slot=${slotSec}s slots=${slots} true=${trueAge.toFixed(1)}s hook=${hookAge}s err=${(trueAge - hookAge).toFixed(1)}s level=${result.current.level}`);
      expect(hookAge).toBe(60); // 150 * 400ms
    });
  }

  it("a push 150 slots old at 0.55 s/slot (82 s) is STALE once the slot rate is measured", () => {
    observation = { slot: PUSH_SLOT + 95n, observedAtMs: NOW - 30_000 };
    const { result, rerender } = renderHook(() => useOracleFreshness({ trackSeconds: true }));
    observation = { slot: PUSH_SLOT + 150n, observedAtMs: NOW }; // 55 slots / 30 s = 545 ms
    rerender();
    expect(result.current.elapsedSecs).toBeGreaterThanOrEqual(81);
    expect(result.current.level).toBe("stale");
  });

  it("0.45 s/slot: 150 slots (67.5 s) is STALE once measured", () => {
    observation = { slot: PUSH_SLOT + 95n, observedAtMs: NOW - 24_750 };
    const { result, rerender } = renderHook(() => useOracleFreshness({ trackSeconds: true }));
    observation = { slot: PUSH_SLOT + 150n, observedAtMs: NOW }; // 55 slots / 24.75 s = 450 ms
    rerender();
    expect(result.current.level).toBe("stale");
  });

  it("0.40 s/slot is unchanged: 150 slots reads 60 s", () => {
    observation = { slot: PUSH_SLOT + 95n, observedAtMs: NOW - 22_000 };
    const { result, rerender } = renderHook(() => useOracleFreshness({ trackSeconds: true }));
    observation = { slot: PUSH_SLOT + 150n, observedAtMs: NOW };
    rerender();
    expect(result.current.elapsedSecs).toBe(60);
  });

  it("measureSlotMs clamps to [400, 600] and refuses short windows", () => {
    const o = (slot: number, ms: number) => ({ slot: BigInt(slot), observedAtMs: ms });
    expect(measureSlotMs(o(0, 0), o(100, 30_000))).toBe(400); // 300 ms -> clamp up
    expect(measureSlotMs(o(0, 0), o(100, 90_000))).toBe(600); // 900 ms -> clamp down
    expect(measureSlotMs(o(0, 0), o(10, 30_000))).toBeNull(); // < 50 slots
    expect(measureSlotMs(o(0, 0), o(100, 5_000))).toBeNull(); // < 20 s
  });

  it("a cluster slot that moves backwards re-anchors the rate instead of corrupting it", () => {
    observation = { slot: PUSH_SLOT + 100n, observedAtMs: NOW - 30_000 };
    const { result, rerender } = renderHook(() => useOracleFreshness({ trackSeconds: true }));
    observation = { slot: PUSH_SLOT + 50n, observedAtMs: NOW };
    rerender();
    expect(result.current.elapsedSecs).toBe(20); // 50 * 400
  });
});

describe("lead 2: cluster slot trails the push slot", () => {
  it("first load with no cluster observation reads fresh (optimistic) and then ages by wall clock", () => {
    observation = null;
    const { result } = renderHook(() => useOracleFreshness({ trackSeconds: true }));
    expect(result.current.level).toBe("fresh");
    act(() => { vi.advanceTimersByTime(61_000); });
    expect(result.current.level).toBe("stale");
  });

  it("a stale cluster observation behind a NEW push slot reads fresh; the same slot re-rendered does not refresh", () => {
    observation = { slot: PUSH_SLOT - 5n, observedAtMs: NOW - 600_000 };
    const { result, rerender } = renderHook(() => useOracleFreshness({ trackSeconds: true }));
    expect(result.current.level).toBe("fresh");
    act(() => { vi.advanceTimersByTime(45_000); });
    rerender(); // same push slot: must not reset the clock
    expect(result.current.level).toBe("aging");
    slabState = slab(PUSH_SLOT + 1n); // genuinely new push
    rerender();
    expect(result.current.level).toBe("fresh");
  });
});

describe("lead 3: 1 s keep-previous rule", () => {
  it("holds the previous timestamp when the new derivation is <1 s newer (bounded <1 s)", () => {
    observation = { slot: PUSH_SLOT + 10n, observedAtMs: NOW };
    const { result, rerender } = renderHook(() => useOracleFreshness({ trackSeconds: true }));
    const first = result.current.lastUpdateMs!;
    observation = { slot: PUSH_SLOT + 10n, observedAtMs: NOW + 900 };
    rerender();
    expect(result.current.lastUpdateMs).toBe(first);
    observation = { slot: PUSH_SLOT + 10n, observedAtMs: NOW + 1000 };
    rerender();
    expect(result.current.lastUpdateMs).toBe(first + 1000);
  });
});

describe("lead 4: shared 1 s timer across unmount/remount", () => {
  it("restarts after all listeners unmount, and clears its interval", () => {
    observation = { slot: PUSH_SLOT + 10n, observedAtMs: NOW };
    const a = renderHook(() => useOracleFreshness({ trackSeconds: true }));
    const b = renderHook(() => useOracleFreshness({ trackSeconds: true }));
    expect(vi.getTimerCount()).toBe(1); // one shared timer for two hooks
    a.unmount();
    expect(vi.getTimerCount()).toBe(1);
    b.unmount();
    expect(vi.getTimerCount()).toBe(0);
    const c = renderHook(() => useOracleFreshness({ trackSeconds: true }));
    expect(vi.getTimerCount()).toBe(1);
    const before = c.result.current.elapsedSecs;
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(c.result.current.elapsedSecs).toBe(before + 5);
    c.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
