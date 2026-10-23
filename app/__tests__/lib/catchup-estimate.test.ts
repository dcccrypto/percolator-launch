// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  CATCHUP_COPY, catchUpBudgetMs, catchUpEstimate, catchUpLine, exceedsBudgetCap, KEEPER_SWEEP_MS, MAX_WAIT_BUDGET_MS, MIN_WAIT_BUDGET_MS,
  retryOnceAfterShortLag, SHORT_LAG_MS, SILENT_RETRY_DELAY_MS, waitWords,
} from "@/lib/limits/catchup-estimate";

describe("estimate arithmetic (swordcat numbers from the diagnosis)", () => {
  it("a 542 bps gap at cap 1 is 542 bps -> 542 slots (+ sweep); at 4.19 slots/s that is ~129 s", () => {
    const eff = 10_000_000n;
    const target = eff + (eff * 542n) / 10_000n; // +5.42 %
    const e = catchUpEstimate({ effectiveE6: eff, targetE6: target, capBpsPerSlot: 1n, slotMs: 1000 / 4.19 })!;
    expect(e.gapBps).toBe(542);
    expect(e.slots).toBe(542);
    expect(Math.round((e.ms - KEEPER_SWEEP_MS) / 1000)).toBe(129);
  });
  it("a higher cap divides (ceil); equal prices are 0; no cap / no price is null", () => {
    const eff = 10_000_000n;
    expect(catchUpEstimate({ effectiveE6: eff, targetE6: eff + (eff * 542n) / 10_000n, capBpsPerSlot: 4n, slotMs: 400 })!.slots).toBe(136); // ceil(542/4)
    expect(catchUpEstimate({ effectiveE6: eff, targetE6: eff, capBpsPerSlot: 1n })).toEqual({ gapBps: 0, slots: 0, ms: 0 });
    expect(catchUpEstimate({ effectiveE6: eff, targetE6: eff + 1n, capBpsPerSlot: 0n })).toBeNull();
    expect(catchUpEstimate({ effectiveE6: 0n, targetE6: 5n, capBpsPerSlot: 1n })).toBeNull();
  });
  it("direction does not matter (target below effective)", () => {
    expect(catchUpEstimate({ effectiveE6: 10_000_000n, targetE6: 9_900_000n, capBpsPerSlot: 1n, slotMs: 400 })!.gapBps).toBe(100);
  });
});

describe("budget rule", () => {
  it("max(2 min, 1.5 x estimate), at most 10 min; no estimate = 2 min", () => {
    expect(catchUpBudgetMs(null)).toBe(MIN_WAIT_BUDGET_MS);
    expect(catchUpBudgetMs(0)).toBe(MIN_WAIT_BUDGET_MS);
    expect(catchUpBudgetMs(60_000)).toBe(MIN_WAIT_BUDGET_MS);
    expect(catchUpBudgetMs(131_000)).toBe(196_500);
    expect(catchUpBudgetMs(10 * 60_000)).toBe(MAX_WAIT_BUDGET_MS);
    expect(exceedsBudgetCap(300_000)).toBe(false);
    expect(exceedsBudgetCap(500_000)).toBe(true);
  });
});

describe("copy branches", () => {
  it("plain-words estimate, and the honest long line when it exceeds the cap", () => {
    expect(waitWords(4_000)).toBe("a few seconds");
    expect(waitWords(38_000)).toBe("about 40 seconds");
    expect(waitWords(131_000)).toBe("about 3 minutes");
    expect(catchUpLine(38_000)).toBe("Price is catching up — about 40 seconds. Goes through automatically.");
    expect(catchUpLine(500_000)).toBe(CATCHUP_COPY.long(500_000));
    expect(CATCHUP_COPY.long(500_000)).toBe("Price is catching up after a big move — about 9 minutes. You can stop and try again later.");
    expect(catchUpLine(2_700_000)).toBe("Price is catching up after a big move — about 45 minutes. You can stop and try again later.");
    expect(catchUpLine(null)).toBeNull();
    expect(catchUpLine(0)).toBeNull();
  });
});

describe("one silent retry", () => {
  const lag = new Error("21");
  const isLag = (e: unknown) => e === lag;
  it("a lag refusal with a tiny gap: waits ~7 s (line shown FIRST), runs again once, no message", async () => {
    const calls: string[] = [];
    const run = vi.fn().mockRejectedValueOnce(lag).mockResolvedValueOnce("sig");
    const out = await retryOnceAfterShortLag(run, {
      isLagRefusal: isLag, estimateMs: () => 0,
      onWaiting: (w) => calls.push(`waiting:${w}`),
      sleep: async (ms) => { calls.push(`sleep:${ms}`); },
    });
    expect(out).toBe("sig");
    expect(run).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(["waiting:true", `sleep:${SILENT_RETRY_DELAY_MS}`, "waiting:false"]);
  });
  it("NEGATIVE: a second refusal is thrown (only ONE retry); a long gap, other errors and Stop are thrown at once", async () => {
    const sleep = async () => {};
    const twice = vi.fn().mockRejectedValue(lag);
    await expect(retryOnceAfterShortLag(twice, { isLagRefusal: isLag, estimateMs: () => 0, sleep })).rejects.toBe(lag);
    expect(twice).toHaveBeenCalledTimes(2);
    const long = vi.fn().mockRejectedValue(lag);
    await expect(retryOnceAfterShortLag(long, { isLagRefusal: isLag, estimateMs: () => SHORT_LAG_MS + 1, sleep })).rejects.toBe(lag);
    expect(long).toHaveBeenCalledTimes(1);
    const other = vi.fn().mockRejectedValue(new Error("User rejected"));
    await expect(retryOnceAfterShortLag(other, { isLagRefusal: isLag, estimateMs: () => 0, sleep })).rejects.toThrow("User rejected");
    expect(other).toHaveBeenCalledTimes(1);
    const stopped = vi.fn().mockRejectedValue(lag);
    await expect(retryOnceAfterShortLag(stopped, { isLagRefusal: isLag, estimateMs: () => 0, sleep, aborted: () => true })).rejects.toBe(lag);
    expect(stopped).toHaveBeenCalledTimes(1);
  });
});
