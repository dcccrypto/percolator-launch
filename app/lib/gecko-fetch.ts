/**
 * Bounded retry wrapper for GeckoTerminal calls (used by the chart route).
 *
 * All users' chart requests exit through Vercel's SHARED IP, so GeckoTerminal
 * rate-limits (429) that IP under load — and a brand-new market's FIRST fetch
 * has no previously-cached good batch to fall back on, so a single 429 returns
 * an empty chart. A small retry lets that first fetch survive a transient
 * 429 / 5xx / network blip.
 *
 * Hard-bounded so a waiting client is never left hanging: at most
 * GECKO_ATTEMPTS tries, each timeout clamped to the remaining total budget,
 * backoff capped at GECKO_MAX_BACKOFF_MS, and the whole call abandoned once
 * GECKO_DEADLINE_MS elapses. Retries ONLY transient failures (429, 5xx, thrown
 * network/timeout) — never a genuine 4xx (e.g. 404 "no such token"), where
 * retrying can't help.
 */
const GECKO_HEADERS = { Accept: "application/json", "User-Agent": "percolator-chart-proxy/1.0" };

export const GECKO_ATTEMPTS = 3; // 1 initial + 2 retries
export const GECKO_ATTEMPT_TIMEOUT_MS = 5_000;
export const GECKO_MAX_BACKOFF_MS = 1_500;
export const GECKO_DEADLINE_MS = 9_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Backoff before the next attempt: honor a numeric Retry-After (seconds) when
 *  present, else exponential 300ms·2^n — both capped, and never sleeping past
 *  the overall deadline. Exported for unit testing. */
export function geckoBackoffMs(res: Response | null, attempt: number, startedAt: number): number {
  const ra = res?.headers.get("retry-after");
  const base = ra && /^\d+$/.test(ra) ? Number(ra) * 1000 : 300 * 2 ** attempt;
  const remaining = GECKO_DEADLINE_MS - (Date.now() - startedAt);
  return Math.max(0, Math.min(base, GECKO_MAX_BACKOFF_MS, remaining));
}

/**
 * Fetch a GeckoTerminal URL with the bounded retry described above. Returns the
 * first usable Response, the last failed Response when out of attempts, or
 * null on a network/timeout error with no attempts left. Never throws.
 */
export async function geckoFetch(url: string): Promise<Response | null> {
  const startedAt = Date.now();
  for (let attempt = 0; attempt < GECKO_ATTEMPTS; attempt++) {
    // Hard-bound each attempt's timeout by the remaining total budget so the
    // whole call can never exceed ~GECKO_DEADLINE_MS, no matter how the
    // attempts time out. Attempt 0 always gets the full per-attempt timeout
    // (the budget is fresh).
    const remaining = GECKO_DEADLINE_MS - (Date.now() - startedAt);
    if (attempt > 0 && remaining <= 0) break;
    const attemptTimeout = Math.min(GECKO_ATTEMPT_TIMEOUT_MS, Math.max(1, remaining));
    try {
      const res = await fetch(url, {
        headers: GECKO_HEADERS,
        signal: AbortSignal.timeout(attemptTimeout),
      });
      // Success, or a non-retryable 4xx (400/404/…): hand back as-is.
      if (res.ok || (res.status < 500 && res.status !== 429)) return res;
      // 429 / 5xx: back off and retry if we still can, else return the failure.
      if (attempt < GECKO_ATTEMPTS - 1) {
        await sleep(geckoBackoffMs(res, attempt, startedAt));
        continue;
      }
      return res;
    } catch {
      // Network error / timeout — retry if attempts and time budget remain.
      if (attempt < GECKO_ATTEMPTS - 1 && Date.now() - startedAt < GECKO_DEADLINE_MS) {
        await sleep(geckoBackoffMs(null, attempt, startedAt));
        continue;
      }
      return null;
    }
  }
  return null;
}
