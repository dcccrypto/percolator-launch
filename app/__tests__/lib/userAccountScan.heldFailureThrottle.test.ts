/** A held-NFT key whose FIRST scan failed must still be throttled (with backoff), not re-fired on every raw change. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey, type Connection } from "@solana/web3.js";
import { triggerHeldNftScan, SCAN_MIN_INTERVAL_MS } from "@/lib/userAccountScan";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "debug").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("held-NFT scan failure throttle", () => {
  it("throttles after a failed first scan and backs off while it keeps failing", async () => {
    const getProgramAccounts = vi.fn(async () => {
      throw new Error("RPC down");
    });
    const connection = { getProgramAccounts } as unknown as Connection;
    const nftProgramId = new PublicKey(new Uint8Array(32).fill(7));
    const wallet = new PublicKey(new Uint8Array(32).fill(9));
    const fire = (n: number) => triggerHeldNftScan({ connection, nftProgramId, wallet, raw: new Uint8Array([n]), minIntervalMs: SCAN_MIN_INTERVAL_MS });

    await fire(0);
    const afterFirst = getProgramAccounts.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    // Many raw changes inside the interval must not fire any further scan now.
    for (let n = 1; n <= 20; n++) await fire(n);
    expect(getProgramAccounts.mock.calls.length).toBe(afterFirst);

    // One trailing scan once the failure-stretched interval (2x after 1 failure) elapses; it fails again -> 4x.
    await vi.advanceTimersByTimeAsync(2 * SCAN_MIN_INTERVAL_MS + 100);
    const afterSecond = getProgramAccounts.mock.calls.length;
    expect(afterSecond).toBeGreaterThan(afterFirst);
    for (let n = 21; n <= 40; n++) await fire(n);
    await vi.advanceTimersByTimeAsync(2 * SCAN_MIN_INTERVAL_MS + 100); // < 4x interval: still backed off
    expect(getProgramAccounts.mock.calls.length).toBe(afterSecond);
    await vi.advanceTimersByTimeAsync(2 * SCAN_MIN_INTERVAL_MS);
    expect(getProgramAccounts.mock.calls.length).toBeGreaterThan(afterSecond);
  });
});
