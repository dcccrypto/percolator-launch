import { describe, expect, it, vi } from "vitest";
import { isRateLimitedRpcError, RATE_LIMITED_COPY, RPC_RETRY_BACKOFF_MS, withRateLimitRetry } from "@/lib/rpc-rate-limit";
import { parseMarketCreationError } from "@/lib/parseMarketError";
import { RETRY_BLOCKED_COPY, retryBlockedReason } from "@/lib/retry-blocked";

describe("what counts as a rate-limited RPC", () => {
  it.each([
    "429 Too Many Requests",
    "failed to get info about account: 429",
    "RPC error -32005: Node is behind",
    '{"code":-32429,"message":"max usage reached"}',
    "Too many requests for a specific RPC call",
    "request was rate-limited",
    "rate limit exceeded",
  ])("%s", (m) => expect(isRateLimitedRpcError(new Error(m))).toBe(true));

  it.each([
    "custom program error: 0x429",
    "custom program error: 0x15",
    "insufficient funds for transfer",
    "User rejected the request",
    "Blockhash not found",
    "slot 14290 was skipped",
  ])("not: %s", (m) => expect(isRateLimitedRpcError(new Error(m))).toBe(false));
});

describe("the launch error says the request was rate-limited and that Retry is safe", () => {
  it("maps every pattern, with and without a step label, before the generic fallbacks", () => {
    expect(parseMarketCreationError(new Error("429 Too Many Requests"))).toBe(RATE_LIMITED_COPY);
    expect(parseMarketCreationError(new Error("RPC error -32429"))).toBe(RATE_LIMITED_COPY);
    expect(parseMarketCreationError(new Error("rate limit"), { step: "lp-init", stepLabel: "Adding liquidity" })).toBe(`Adding liquidity failed: ${RATE_LIMITED_COPY}`);
    expect(RATE_LIMITED_COPY).toBe("The network is busy and the request was rate-limited. Nothing was sent. Click Retry.");
  });
  it("CONTROL: other failures keep their own messages", () => {
    expect(parseMarketCreationError(new Error("User rejected the request"))).toMatch(/you rejected the signing request/);
    expect(parseMarketCreationError(new Error("insufficient funds for transfer"))).toMatch(/Insufficient token balance/);
    expect(parseMarketCreationError(new Error("Blockhash not found"))).toMatch(/expired before confirmation/);
  });
});

describe("withRateLimitRetry", () => {
  const rl = () => new Error("429 Too Many Requests");
  it("retries three times with backoff and returns the first success", async () => {
    const fn = vi.fn().mockRejectedValueOnce(rl()).mockRejectedValueOnce(rl()).mockRejectedValueOnce(rl()).mockResolvedValue("ok");
    const sleep = vi.fn(async () => {});
    await expect(withRateLimitRetry(fn, sleep)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([...RPC_RETRY_BACKOFF_MS]);
  });
  it("gives up after three retries and throws the rate-limit error", async () => {
    const fn = vi.fn().mockRejectedValue(rl());
    await expect(withRateLimitRetry(fn, async () => {})).rejects.toThrow(/429/);
    expect(fn).toHaveBeenCalledTimes(4);
  });
  it("a different failure is thrown at once, never delayed", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("account not found"));
    const sleep = vi.fn(async () => {});
    await expect(withRateLimitRetry(fn, sleep)).rejects.toThrow("account not found");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("why Retry can't run", () => {
  it("names each reason, and is null when it can", () => {
    expect(retryBlockedReason({ hasWallet: false, configValid: true, step: 2, hasSlab: true })).toBe(RETRY_BLOCKED_COPY.noWallet);
    expect(retryBlockedReason({ hasWallet: true, configValid: false, step: 2, hasSlab: true })).toBe(RETRY_BLOCKED_COPY.invalidConfig);
    expect(retryBlockedReason({ hasWallet: true, configValid: true, step: 2, hasSlab: false })).toBe(RETRY_BLOCKED_COPY.noSlab);
    expect(retryBlockedReason({ hasWallet: true, configValid: true, step: 0, hasSlab: false })).toBeNull(); // step 0 needs no slab
    expect(retryBlockedReason({ hasWallet: true, configValid: true, step: 3, hasSlab: true })).toBeNull();
  });
});
