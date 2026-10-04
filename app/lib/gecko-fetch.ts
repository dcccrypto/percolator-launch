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

/** Keyless GeckoTerminal endpoint (30 calls/min per IP, shared by the whole deployment). */
export const GECKO_FREE_BASE = "https://api.geckoterminal.com/api/v2/networks/solana";
/** CoinGecko on-chain API (same data/shape as GeckoTerminal), documented at
 *  docs.coingecko.com: Demo = api.coingecko.com + `x-cg-demo-api-key`,
 *  Pro = pro-api.coingecko.com + `x-cg-pro-api-key`; on-chain endpoints add `/onchain`. */
export const GECKO_DEMO_BASE = "https://api.coingecko.com/api/v3/onchain/networks/solana";
export const GECKO_PRO_BASE = "https://pro-api.coingecko.com/api/v3/onchain/networks/solana";

export interface GeckoConfig {
  base: string;
  /** Extra auth header; empty on the free path. SERVER-ONLY — never forward to a client. */
  authHeaders: Record<string, string>;
}

/**
 * #2578: optional server-side API key. `COINGECKO_API_KEY` set -> authenticated
 * CoinGecko on-chain API (higher quota); unset/blank -> the free keyless endpoint,
 * exactly the previous behaviour. `COINGECKO_API_TIER` = "pro" selects the Pro
 * host/header; anything else (default) is "demo". Read per call so env changes and
 * tests apply without a module reload.
 */
export function getGeckoConfig(env: Record<string, string | undefined> = process.env): GeckoConfig {
  const key = (env.COINGECKO_API_KEY ?? "").trim();
  if (!key) return { base: GECKO_FREE_BASE, authHeaders: {} };
  const tier = (env.COINGECKO_API_TIER ?? "").trim().toLowerCase();
  return tier === "pro"
    ? { base: GECKO_PRO_BASE, authHeaders: { "x-cg-pro-api-key": key } }
    : { base: GECKO_DEMO_BASE, authHeaders: { "x-cg-demo-api-key": key } };
}

export const GECKO_ATTEMPTS = 3; // 1 initial + 2 retries
export const GECKO_ATTEMPT_TIMEOUT_MS = 5_000;
export const GECKO_MAX_BACKOFF_MS = 1_500;
export const GECKO_DEADLINE_MS = 9_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Backoff before the next attempt: honor a numeric Retry-After (seconds) when
 *  present, else exponential 300ms·2^n — with ±20% jitter, both capped, and
 *  never sleeping past the overall deadline. The jitter matters because all
 *  chart requests share Vercel's single outbound IP, so without it every
 *  concurrent request retries on the SAME schedule and triples outbound volume
 *  to GeckoTerminal in the exact instant it's already signaling back-off. `rng`
 *  is injectable so unit tests stay deterministic. Exported for unit testing. */
export function geckoBackoffMs(
  res: Response | null,
  attempt: number,
  startedAt: number,
  rng: () => number = Math.random,
): number {
  const ra = res?.headers.get("retry-after");
  const base = ra && /^\d+$/.test(ra) ? Number(ra) * 1000 : 300 * 2 ** attempt;
  const jittered = base * (0.8 + 0.4 * rng()); // ±20%
  const remaining = GECKO_DEADLINE_MS - (Date.now() - startedAt);
  return Math.max(0, Math.min(jittered, GECKO_MAX_BACKOFF_MS, remaining));
}

/**
 * Fetch a GeckoTerminal URL with the bounded retry described above. Returns the
 * first usable Response, the last failed Response when out of attempts, or
 * null on a network/timeout error with no attempts left. Never throws.
 */
export async function geckoFetch(url: string, opts: { attempts?: number } = {}): Promise<Response | null> {
  const headers = { ...GECKO_HEADERS, ...getGeckoConfig().authHeaders };
  const startedAt = Date.now();
  // `attempts: 1` is for background backfill: a 429 must not be retried into the shared IP's limit.
  const attempts = Math.max(1, Math.min(opts.attempts ?? GECKO_ATTEMPTS, GECKO_ATTEMPTS));
  for (let attempt = 0; attempt < attempts; attempt++) {
    // Hard-bound each attempt's timeout by the remaining total budget so the
    // whole call can never exceed ~GECKO_DEADLINE_MS, no matter how the
    // attempts time out. Attempt 0 always gets the full per-attempt timeout
    // (the budget is fresh).
    const remaining = GECKO_DEADLINE_MS - (Date.now() - startedAt);
    if (attempt > 0 && remaining <= 0) break;
    const attemptTimeout = Math.min(GECKO_ATTEMPT_TIMEOUT_MS, Math.max(1, remaining));
    try {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(attemptTimeout),
      });
      // Success, or a non-retryable 4xx (400/404/…): hand back as-is.
      if (res.ok || (res.status < 500 && res.status !== 429)) return res;
      // 429 / 5xx: back off and retry if we still can, else return the failure.
      if (attempt < attempts - 1) {
        await sleep(geckoBackoffMs(res, attempt, startedAt));
        continue;
      }
      return res;
    } catch {
      // Network error / timeout — retry if attempts and time budget remain.
      if (attempt < attempts - 1 && Date.now() - startedAt < GECKO_DEADLINE_MS) {
        await sleep(geckoBackoffMs(null, attempt, startedAt));
        continue;
      }
      return null;
    }
  }
  return null;
}
