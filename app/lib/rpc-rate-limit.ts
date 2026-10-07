/**
 * Rate-limited RPC (HTTP 429, JSON-RPC -32005 / -32429, "rate limit", "too many requests").
 *
 * The launch's LP and funding steps open with a getProgramAccounts scan to find the LP portfolio
 * (idempotency on resume). On a shared devnet RPC that scan is the call most often refused, and a refusal
 * there happens BEFORE anything is signed or sent: the launch failed with an opaque message and nothing
 * retried it. This module is the one place that names the condition, so the error text and the retry
 * agree on what counts.
 */
export const RATE_LIMITED_COPY = "The network is busy and the request was rate-limited. Nothing was sent. Click Retry.";

/** HTTP 429 (not as part of a longer number), JSON-RPC -32005 / -32429, and the usual phrases. */
const RATE_LIMIT_RE = /(?<![0-9a-zA-Z])429(?![0-9a-zA-Z])|-32005|-32429|rate[\s-]?limit|too many requests/i;

export function isRateLimitedRpcError(error: unknown): boolean {
  const msg = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? "");
  return RATE_LIMIT_RE.test(msg);
}

export const RPC_RETRY_BACKOFF_MS = [600, 1_800, 4_000] as const;

/**
 * Run `fn`, retrying up to three times with backoff while it fails with a rate-limit error. Any other
 * error is thrown at once (a real failure must not be delayed), and the last rate-limit error is thrown if
 * every retry is refused. Only for idempotent reads.
 */
export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimitedRpcError(err) || attempt >= RPC_RETRY_BACKOFF_MS.length) throw err;
      await sleep(RPC_RETRY_BACKOFF_MS[attempt] ?? 0);
    }
  }
}
