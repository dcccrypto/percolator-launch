/**
 * Rate-limited RPC (HTTP 429, JSON-RPC -32005 / -32429, "rate limit", "too many requests").
 *
 * The launch's LP and funding steps open with a getProgramAccounts scan to find the LP portfolio
 * (idempotency on resume). On a shared devnet RPC that scan is the call most often refused, and a refusal
 * there happens BEFORE anything is signed or sent: the launch failed with an opaque message and nothing
 * retried it. This module is the one place that names the condition, so the error text and the retry
 * agree on what counts.
 */
/**
 * Strict copy: only for a rate limit that provably hit BEFORE anything was sent (an idempotent read wrapped
 * by withRateLimitRetry, which marks its final error). Every other rate limit may have followed landed
 * transactions, so it gets the neutral copy.
 */
export const RATE_LIMITED_COPY = "The network is busy and the request was rate-limited. Nothing was sent. Click Retry.";
export const RATE_LIMITED_NEUTRAL_COPY =
  "The network is busy and a request was rate-limited. Click Retry; anything already signed is kept and the launch resumes where it stopped.";
/** `name` of the error withRateLimitRetry throws when every retry of a pre-send read was refused. */
export const RATE_LIMITED_BEFORE_SEND = "RateLimitedBeforeSend";

/**
 * A bare "429" is only a rate limit in an HTTP context ("HTTP 429", "status: 429", "responded with 429",
 * "429 Too Many Requests"), never an amount, a slot or an address fragment. -32005 / -32429 and the usual
 * phrases match on their own.
 */
const RATE_LIMIT_RE =
  /(?:\b(?:http|status|code|responded with|error)\b[\s:=/]*(?:\d\.\d\s*)?429(?![0-9a-zA-Z.]))|(?<![0-9a-zA-Z.])429\s+too\s+many|-32005|-32429|rate[\s-]?limit|too many requests/i;

export function isRateLimitedBeforeSend(error: unknown): boolean {
  return error instanceof Error && error.name === RATE_LIMITED_BEFORE_SEND;
}

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
      if (!isRateLimitedRpcError(err)) throw err;
      if (attempt >= RPC_RETRY_BACKOFF_MS.length) {
        // Every retry of this read was refused. It is a pre-send read, so say so: the marker is what lets
        // the launch error use the strict "Nothing was sent" copy (any other rate limit may follow landed txs).
        const marked = new Error(err instanceof Error ? err.message : String(err), { cause: err });
        marked.name = RATE_LIMITED_BEFORE_SEND;
        throw marked;
      }
      await sleep(RPC_RETRY_BACKOFF_MS[attempt] ?? 0);
    }
  }
}
