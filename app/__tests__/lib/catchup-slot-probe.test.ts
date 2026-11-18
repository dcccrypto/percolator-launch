// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetSlotCacheForTest, BAND_SWEEP_SLOTS, bandWalkEstimate, KEEPER_SWEEP_MS, measureSlotMs, SHORT_LAG_MS, SLOT_MS_DEFAULT,
} from "@/lib/limits/catchup-estimate";

type Conn = Parameters<typeof measureSlotMs>[0];
const conn = (fn: () => Promise<{ numSlots: number; samplePeriodSecs: number }[]>): Conn =>
  ({ getRecentPerformanceSamples: vi.fn(fn) }) as unknown as Conn;
const never = () => new Promise<never>(() => {});

beforeEach(() => { vi.useFakeTimers(); __resetSlotCacheForTest(); });
afterEach(() => { vi.useRealTimers(); });

describe("measureSlotMs probe", () => {
  it("10 calls against a never-resolving probe: one 1.5 s wait, then cached; no live timers left", async () => {
    const c = conn(never);
    let waited = 0;
    for (let i = 0; i < 10; i++) {
      let done = false;
      const p = measureSlotMs(c).then((v) => { done = true; return v; });
      await vi.advanceTimersByTimeAsync(0);
      if (!done) { await vi.advanceTimersByTimeAsync(1_500); waited += 1_500; } // the caller sits through the probe timeout
      expect(await p).toBe(SLOT_MS_DEFAULT);
    }
    // before the fix: 10 x 1500 = 15000 ms and 10 timers; after: the first call only.
    expect(waited).toBeLessThanOrEqual(1_500);
    expect((c.getRecentPerformanceSamples as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a fast success clears the timeout timer", async () => {
    const c = conn(async () => [{ numSlots: 100, samplePeriodSecs: 24 }]);
    expect(await measureSlotMs(c)).toBe(240);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a failure is cached only briefly: retried after the negative TTL", async () => {
    const f = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue([{ numSlots: 100, samplePeriodSecs: 24 }]);
    const c = { getRecentPerformanceSamples: f } as unknown as Conn;
    expect(await measureSlotMs(c, 0)).toBe(SLOT_MS_DEFAULT);
    expect(await measureSlotMs(c, 1_000)).toBe(SLOT_MS_DEFAULT);
    expect(f).toHaveBeenCalledTimes(1);
    expect(await measureSlotMs(c, 60_000)).toBe(240);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("the cache is per connection: a new connection (cluster switch) is probed afresh", async () => {
    const a = conn(async () => [{ numSlots: 100, samplePeriodSecs: 24 }]);
    const b = conn(async () => [{ numSlots: 100, samplePeriodSecs: 40 }]);
    expect(await measureSlotMs(a, 0)).toBe(240);
    expect(await measureSlotMs(b, 1_000)).toBe(400);
    expect(await measureSlotMs(a, 2_000)).toBe(240);
  });

  it("concurrent calls share one probe", async () => {
    const c = conn(async () => [{ numSlots: 100, samplePeriodSecs: 24 }]);
    const r = await Promise.all([measureSlotMs(c), measureSlotMs(c), measureSlotMs(c)]);
    expect(r).toEqual([240, 240, 240]);
    expect((c.getRecentPerformanceSamples as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});

describe("bandWalkEstimate at the one-sweep boundary (decision: intended, no extra KEEPER_SWEEP_MS)", () => {
  // cap 4 bps/slot, band 130: step per sweep = min(104, 130) = 104 bps. Effective price E6 = 1e6 so gap bps = diff / 100.
  const E6 = 1_000_000n;
  const step = 104;
  const at = (gap: number, slotMs: number) => bandWalkEstimate({ effectiveE6: E6, targetE6: E6 + BigInt(gap) * 100n, capBpsPerSlot: 4n, bandBps: 130, slotMs })!;
  const rows: [number, number, number, number][] = [
    // gap, slotMs, sweeps, expected ms
    [step - 1, 240, 1, 26 * 240],
    [step, 240, 1, 26 * 240],
    [step + 1, 240, 2, 52 * 240],
    [step - 1, 400, 1, 26 * 400],
    [step, 400, 1, 26 * 400],
    [step + 1, 400, 2, 52 * 400],
  ];
  it.each(rows)("gap %i bps @ %i ms/slot -> %i sweep(s), %i ms", (gap, slotMs, sweeps, ms) => {
    const e = at(gap, slotMs);
    expect(e.gapBps).toBe(gap);
    expect(e.slots).toBe(sweeps * BAND_SWEEP_SLOTS);
    expect(e.ms).toBe(ms);
  });
  it("a one-sweep gap is a full sweep of slots (the first step lands at the next sweep, so the sweep wait is already in `ms`)", () => {
    // 26 slots x 400 ms = 10.4 s, deliberately without KEEPER_SWEEP_MS: adding 6 s would double-count the sweep.
    expect(at(step, 400).ms).toBe(10_400);
    expect(at(step, 400).ms).toBeLessThan(SHORT_LAG_MS); // so a one-sweep gap still gets the single silent retry
    expect(at(step, 240).ms).toBe(6_240); // ~ one real sweep on devnet
    expect(at(step, 240).ms).toBeLessThan(KEEPER_SWEEP_MS + 1_000);
    // two sweeps exceed the short-lag threshold at both slot times: no silent retry, the wait copy is shown.
    expect(at(step + 1, 400).ms).toBeGreaterThan(SHORT_LAG_MS);
  });
});
