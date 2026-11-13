/** r10 live check: a funding-counter read that fails (devnet RPC 429) is retried with backoff and gives null only after the retries fail. */
import { describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { readFundingSample, retryFundingRead } from "@/lib/funding-flow";

const PK = new PublicKey(new Uint8Array(32).fill(7));
const noSleep = vi.fn(async () => {});

describe("retryFundingRead", () => {
  it("retries a failed read with growing waits and returns the first good answer", async () => {
    const sleep = vi.fn(async () => {});
    const read = vi.fn<() => Promise<number | null>>().mockRejectedValueOnce(new Error("429")).mockResolvedValueOnce(null).mockResolvedValueOnce(5);
    expect(await retryFundingRead(read, [10, 20, 40], sleep)).toBe(5);
    expect(read).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([10, 20]);
  });
  it("gives null only after every retry failed", async () => {
    const read = vi.fn<() => Promise<number | null>>().mockRejectedValue(new Error("429"));
    expect(await retryFundingRead(read, [1, 2, 3], noSleep)).toBeNull();
    expect(read).toHaveBeenCalledTimes(4);
  });
  it("does not wait when the first read works", async () => {
    const sleep = vi.fn(async () => {});
    expect(await retryFundingRead(async () => 1, [5], sleep)).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("readFundingSample", () => {
  it("returns null after the retries when the account never arrives, and asks for the pinned slot each time", async () => {
    const getAccountInfo = vi.fn().mockRejectedValue(new Error("429 Too Many Requests"));
    expect(await readFundingSample({ getAccountInfo }, PK, 123, [1, 1], noSleep)).toBeNull();
    expect(getAccountInfo).toHaveBeenCalledTimes(3);
    expect(getAccountInfo.mock.calls.every((c) => c[1].minContextSlot === 123)).toBe(true);
  });
  it("a first 429 followed by a missing account is still retried, then null", async () => {
    const getAccountInfo = vi.fn().mockRejectedValueOnce(new Error("429")).mockResolvedValue(null);
    expect(await readFundingSample({ getAccountInfo }, PK, 9, [1, 1], noSleep)).toBeNull();
    expect(getAccountInfo).toHaveBeenCalledTimes(3);
  });
});
