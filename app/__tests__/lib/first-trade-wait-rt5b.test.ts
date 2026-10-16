// @vitest-environment node
/**
 * v2.2 QA RT5b (reported as "U-1 regression?"): a swordcat open through DEPOSIT & LONG stopped with "Catching up …
 * Nothing was sent" after three re-checks (4.5 s). Measured on devnet: while the effective price trails the oracle
 * target the program refuses every new position with 21 (35 s and more on this band market), whatever is cranked in
 * the same tx. The deposit-and-trade path now waits within the ticket's budget, like the plain trade path.
 */
import { describe, expect, it, vi } from "vitest";
import { presignWait } from "@/lib/first-trade-wait";
import { SimulationRefusal, WaitExhaustedError, WaitStoppedError, WAIT_DELAYS_MS } from "@/lib/tx";

const refusal21 = () => Object.assign(Object.create(SimulationRefusal.prototype), { code: 21, message: "Transaction simulation failed: {\"InstructionError\":[3,{\"Custom\":21}]}" }) as SimulationRefusal;
const waitable = (e: unknown) => e instanceof SimulationRefusal && (e.code === 19 || e.code === 21);
const base = { waitable, legacyAttempts: 3, legacyDelayMs: 1_500 };

/** `send` refuses 21 for the first `n` calls (the catch-up window), then lands. */
function market(n: number) {
  let calls = 0;
  return { send: vi.fn(async () => { if (calls++ < n) throw refusal21(); return "sig"; }), calls: () => calls };
}

describe("RT5b: deposit-and-trade waits through a price catch-up window", () => {
  it("a window of 8 refusals (about 60 s of re-checks) ends in the trade, with the waiting state shown and cleared", async () => {
    const m = market(8);
    const slept: number[] = [];
    const onWaiting = vi.fn();
    const onWaitingLong = vi.fn();
    await expect(presignWait(m.send, { ...base, maxWaitMs: 120_000, onWaiting, onWaitingLong, sleep: async (ms) => { slept.push(ms); } })).resolves.toBe("sig");
    expect(m.calls()).toBe(9);
    expect(slept.slice(0, 5)).toEqual([...WAIT_DELAYS_MS]);
    expect(onWaiting.mock.calls[0]).toEqual([true]);
    expect(onWaiting.mock.calls.at(-1)).toEqual([false]);
    expect(onWaitingLong).toHaveBeenCalledTimes(1);
  });

  it("NEGATIVE CONTROL: without a budget (the old behaviour) the same window fails after three re-checks", async () => {
    const m = market(8);
    const slept: number[] = [];
    await expect(presignWait(m.send, { ...base, sleep: async (ms) => { slept.push(ms); } })).rejects.toBeInstanceOf(SimulationRefusal);
    expect(m.calls()).toBe(4);
    expect(slept).toEqual([1_500, 1_500, 1_500]);
  });

  it("a refusal that never clears ends at the budget with the time-limit error, not a hang", async () => {
    const m = market(1_000);
    let total = 0;
    await expect(presignWait(m.send, { ...base, maxWaitMs: 120_000, sleep: async (ms) => { total += ms; } })).rejects.toBeInstanceOf(WaitExhaustedError);
    expect(total).toBeGreaterThanOrEqual(120_000);
    expect(total).toBeLessThan(120_000 + 12_001);
  });

  it("Stop ends the wait; a settled / unpushed market is not waited on; other errors pass straight through", async () => {
    const ac = new AbortController();
    const m = market(1_000);
    await expect(presignWait(m.send, { ...base, maxWaitMs: 120_000, abortSignal: ac.signal, sleep: async () => { ac.abort(); } })).rejects.toBeInstanceOf(WaitStoppedError);
    const m2 = market(1_000);
    await expect(presignWait(m2.send, { ...base, maxWaitMs: 120_000, shouldWait: () => false, sleep: async () => {} })).rejects.toBeInstanceOf(SimulationRefusal);
    expect(m2.calls()).toBe(1);
    const boom = new Error("User rejected the request.");
    await expect(presignWait(async () => { throw boom; }, { ...base, maxWaitMs: 120_000, sleep: async () => {} })).rejects.toBe(boom);
  });
});
