/**
 * Devnet v2.1: the Custom(121) EngineLossStale retry state machine (lib/v21/loss-stale-retry.ts).
 * An order refused 121 is sent again after ~1-2 s, a bounded number of times, never bundled with
 * refreshes. Every other error passes straight through.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setDevnetV21ForTest } from "@/lib/v21/flag";
import {
  LOSS_STALE_RETRY_DELAYS_MS,
  isLossStaleError,
  withLossStaleRetry,
} from "@/lib/v21/loss-stale-retry";

const WRAPPER = "WrapperProgram1111111111111111111111111111";

/** The shape lib/tx.ts SimulationRefusal carries (message + programId). */
function refusal(code: number, programId: string | null = WRAPPER): Error & { programId: string | null } {
  const e = new Error(`Transaction simulation failed: {"InstructionError":[2,{"Custom":${code}}]}`) as Error & { programId: string | null };
  e.programId = programId;
  return e;
}

const noSleep = vi.fn(async () => false);

beforeEach(() => {
  __setDevnetV21ForTest(true);
  noSleep.mockClear();
});
afterEach(() => __setDevnetV21ForTest(null));

describe("isLossStaleError", () => {
  it("is the wrapper's Custom(121), in every message form", () => {
    expect(isLossStaleError(refusal(121), WRAPPER)).toBe(true);
    expect(isLossStaleError(new Error("custom program error: 0x79"), WRAPPER)).toBe(true);
    expect(isLossStaleError('{"InstructionError":[0,{"Custom":121}]}', WRAPPER)).toBe(true);
  });

  it("is not another code, another program's 121, or anything with the flag off", () => {
    expect(isLossStaleError(refusal(21), WRAPPER)).toBe(false);
    expect(isLossStaleError(refusal(120), WRAPPER)).toBe(false);
    expect(isLossStaleError(refusal(121, "SomeOtherProgram111111111111111111111111111"), WRAPPER)).toBe(false);
    expect(isLossStaleError(new Error("User rejected the request."), WRAPPER)).toBe(false);
    expect(isLossStaleError(null, WRAPPER)).toBe(false);
    __setDevnetV21ForTest(false);
    expect(isLossStaleError(refusal(121), WRAPPER)).toBe(false);
  });
});

describe("withLossStaleRetry", () => {
  it("passes a clean send straight through, never entering the refreshing state", async () => {
    const onRefreshing = vi.fn();
    const send = vi.fn(async () => "sig");
    await expect(withLossStaleRetry(send, { wrapperProgramId: WRAPPER, onRefreshing, sleep: noSleep })).resolves.toBe("sig");
    expect(send).toHaveBeenCalledTimes(1);
    expect(onRefreshing).not.toHaveBeenCalled();
    expect(noSleep).not.toHaveBeenCalled();
  });

  it("121 -> refreshing -> resend -> lands: one true, one false, the same order sent again", async () => {
    const onRefreshing = vi.fn();
    const send = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(refusal(121))
      .mockRejectedValueOnce(refusal(121))
      .mockResolvedValueOnce("sig");
    await expect(withLossStaleRetry(send, { wrapperProgramId: WRAPPER, onRefreshing, sleep: noSleep })).resolves.toBe("sig");
    expect(send).toHaveBeenCalledTimes(3);
    expect(onRefreshing.mock.calls).toEqual([[true], [false]]);
    expect(noSleep.mock.calls.map((c) => c[0])).toEqual([LOSS_STALE_RETRY_DELAYS_MS[0], LOSS_STALE_RETRY_DELAYS_MS[1]]);
  });

  it("the default schedule is ~1-2 s apart and bounded", () => {
    expect(LOSS_STALE_RETRY_DELAYS_MS.length).toBeGreaterThan(0);
    for (const d of LOSS_STALE_RETRY_DELAYS_MS) {
      expect(d).toBeGreaterThanOrEqual(1_000);
      expect(d).toBeLessThanOrEqual(2_000);
    }
    expect(LOSS_STALE_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(20_000);
  });

  it("bounded: after the last delay the 121 itself is thrown (the resolver's calm loss-stale line)", async () => {
    const onRefreshing = vi.fn();
    const last = refusal(121);
    const send = vi.fn<() => Promise<string>>().mockRejectedValue(last);
    const delays = [10, 20, 30];
    await expect(withLossStaleRetry(send, { wrapperProgramId: WRAPPER, onRefreshing, delaysMs: delays, sleep: noSleep })).rejects.toBe(last);
    expect(send).toHaveBeenCalledTimes(delays.length + 1);
    expect(onRefreshing.mock.calls).toEqual([[true], [false]]);
  });

  it("any other error is thrown at once, unchanged, with no retry", async () => {
    for (const e of [refusal(21), refusal(9), new Error("User rejected the request."), new Error("confirmation timeout: may still land")]) {
      const onRefreshing = vi.fn();
      const send = vi.fn<() => Promise<string>>().mockRejectedValue(e);
      await expect(withLossStaleRetry(send, { wrapperProgramId: WRAPPER, onRefreshing, sleep: noSleep })).rejects.toBe(e);
      expect(send).toHaveBeenCalledTimes(1);
      expect(onRefreshing).not.toHaveBeenCalled();
    }
    expect(noSleep).not.toHaveBeenCalled();
  });

  it("a different error after a 121 ends the wait and is thrown as is", async () => {
    const onRefreshing = vi.fn();
    const other = new Error("User rejected the request.");
    const send = vi.fn<() => Promise<string>>().mockRejectedValueOnce(refusal(121)).mockRejectedValueOnce(other);
    await expect(withLossStaleRetry(send, { wrapperProgramId: WRAPPER, onRefreshing, sleep: noSleep })).rejects.toBe(other);
    expect(send).toHaveBeenCalledTimes(2);
    expect(onRefreshing.mock.calls).toEqual([[true], [false]]);
  });

  it("Stop (abort) during the wait throws the 121 without sending again", async () => {
    const ctl = new AbortController();
    const onRefreshing = vi.fn();
    const e121 = refusal(121);
    const send = vi.fn<() => Promise<string>>().mockRejectedValue(e121);
    const sleep = vi.fn(async () => {
      ctl.abort();
      return true;
    });
    await expect(withLossStaleRetry(send, { wrapperProgramId: WRAPPER, onRefreshing, abortSignal: ctl.signal, sleep })).rejects.toBe(e121);
    expect(send).toHaveBeenCalledTimes(1);
    expect(onRefreshing.mock.calls).toEqual([[true], [false]]);
  });

  it("flag off: a 121 is not retried (today's programs never raise it)", async () => {
    __setDevnetV21ForTest(false);
    const e121 = refusal(121);
    const send = vi.fn<() => Promise<string>>().mockRejectedValue(e121);
    await expect(withLossStaleRetry(send, { wrapperProgramId: WRAPPER, sleep: noSleep })).rejects.toBe(e121);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("the real sleep waits the delay (fake timers)", async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn<() => Promise<string>>().mockRejectedValueOnce(refusal(121)).mockResolvedValueOnce("sig");
      const p = withLossStaleRetry(send, { wrapperProgramId: WRAPPER, delaysMs: [1_500] });
      await vi.advanceTimersByTimeAsync(1_499);
      expect(send).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(p).resolves.toBe("sig");
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
