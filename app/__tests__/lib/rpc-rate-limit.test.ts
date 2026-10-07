import { describe, expect, it, vi } from "vitest";
import { isRateLimitedBeforeSend, isRateLimitedRpcError, RATE_LIMITED_COPY, RATE_LIMITED_NEUTRAL_COPY, RPC_RETRY_BACKOFF_MS, withRateLimitRetry } from "@/lib/rpc-rate-limit";
import { parseMarketCreationError } from "@/lib/parseMarketError";
import { RETRY_BLOCKED_COPY, retryBlockedReason } from "@/lib/retry-blocked";

describe("what counts as a rate-limited RPC", () => {
  it.each([
    "429 Too Many Requests",
    "Server responded with 429 Too Many Requests. Retrying after 500ms delay...",
    "HTTP 429",
    "HTTP/1.1 429",
    "status: 429",
    "status code 429",
    "error 429",
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
    // a bare 429 outside an HTTP context: an amount, a slot, an address fragment
    "Sent 429 USDC",
    "balance is 429",
    "slot 429",
    "amount: 429",
    "Ab429xyz",
    "3SJ429Qm9r",
    "account 429.5 not found",
  ])("not: %s", (m) => expect(isRateLimitedRpcError(new Error(m))).toBe(false));
});

describe("the launch error: strict copy only for a pre-send read, neutral copy for any other rate limit", () => {
  const marked = async () => {
    const fn = async () => { throw new Error("429 Too Many Requests"); };
    try { await withRateLimitRetry(fn, async () => {}); } catch (e) { return e as Error; }
    throw new Error("expected a throw");
  };
  it("withRateLimitRetry marks the error it gives up on", async () => {
    const e = await marked();
    expect(isRateLimitedBeforeSend(e)).toBe(true);
    expect(e.message).toMatch(/429/);
    expect(isRateLimitedBeforeSend(new Error("429 Too Many Requests"))).toBe(false);
  });
  it("a marked (pre-send) error gets the strict 'Nothing was sent' copy, with and without a step label", async () => {
    const e = await marked();
    expect(parseMarketCreationError(e)).toBe(RATE_LIMITED_COPY);
    expect(parseMarketCreationError(e, { step: "lp-init", stepLabel: "Adding liquidity" })).toBe(`Adding liquidity failed: ${RATE_LIMITED_COPY}`);
    expect(RATE_LIMITED_COPY).toBe("The network is busy and the request was rate-limited. Nothing was sent. Click Retry.");
  });
  it("any other rate limit (it may follow landed transactions) gets the neutral copy, never 'Nothing was sent'", () => {
    for (const m of ["429 Too Many Requests", "RPC error -32429", "rate limit exceeded", "Too many requests for a specific RPC call"]) {
      const out = parseMarketCreationError(new Error(m), { step: "lp-init", stepLabel: "Adding liquidity" });
      expect(out).toBe(`Adding liquidity failed: ${RATE_LIMITED_NEUTRAL_COPY}`);
      expect(out).not.toMatch(/Nothing was sent/);
    }
    expect(RATE_LIMITED_NEUTRAL_COPY).toBe("The network is busy and a request was rate-limited. Click Retry; anything already signed is kept and the launch resumes where it stopped.");
  });
  it("CONTROL: other failures keep their own messages, and a non-rate-limit number is not mistaken for one", () => {
    expect(parseMarketCreationError(new Error("User rejected the request"))).toMatch(/you rejected the signing request/);
    expect(parseMarketCreationError(new Error("insufficient funds for transfer"))).toMatch(/Insufficient token balance/);
    expect(parseMarketCreationError(new Error("Blockhash not found"))).toMatch(/expired before confirmation/);
    expect(parseMarketCreationError(new Error("Sent 429 USDC but insufficient funds for transfer"))).toMatch(/Insufficient token balance/);
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
    await expect(withRateLimitRetry(fn, async () => {})).rejects.toMatchObject({ name: "RateLimitedBeforeSend", message: expect.stringMatching(/429/) });
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
