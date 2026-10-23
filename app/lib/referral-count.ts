/**
 * How many waitlist signups used a referral code, read from the waitlist's public count endpoint
 * (`GET ${origin}/api/waitlist/my-referrals?code=`, which returns only a number).
 *
 * Every playground user's lookup leaves through the same few server addresses, and the waitlist site rate
 * limits each address, so a count is reused per code for COUNT_TTL_MS. A failed read keeps the last good
 * count for that code, or is null when there is none; a failure is never cached and never shows as 0.
 */
const COUNT_TIMEOUT_MS = 4_000;
/** How long one code's count is reused before asking the waitlist again. */
export const COUNT_TTL_MS = 60_000;
/** Bound on cached codes, so a long-lived server instance cannot grow the cache without limit. */
const COUNT_CACHE_MAX = 5_000;

const cache = new Map<string, { count: number; at: number }>();

/** Test hook: forget cached counts. */
export function resetReferralCountCache(): void {
  cache.clear();
}

async function fetchCount(code: string, origin: string): Promise<number | null> {
  try {
    const res = await fetch(`${origin}/api/waitlist/my-referrals?code=${encodeURIComponent(code)}`, {
      signal: AbortSignal.timeout(COUNT_TIMEOUT_MS),
      cache: "no-store",
      redirect: "error",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { count?: unknown; reason?: unknown };
    // The endpoint degrades to { count: 0, reason } on its own errors; only a clean answer is a count.
    if (json.reason !== undefined) return null;
    return typeof json.count === "number" && Number.isInteger(json.count) && json.count >= 0 ? json.count : null;
  } catch {
    return null;
  }
}

export async function referralJoinedCount(code: string, origin: string, nowMs = Date.now()): Promise<number | null> {
  const key = `${origin}|${code}`;
  const hit = cache.get(key);
  if (hit && nowMs - hit.at < COUNT_TTL_MS) return hit.count;
  const count = await fetchCount(code, origin);
  if (count === null) return hit ? hit.count : null;
  if (!hit && cache.size >= COUNT_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.delete(key); // re-insert so Map order stays oldest-first
  cache.set(key, { count, at: nowMs });
  return count;
}
