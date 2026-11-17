/**
 * Is a cache entry stamped at `stampedAt` (ms, Date.now() clock) still fresh at `now`?
 *
 * `now - stampedAt < ttl` alone treats a NEGATIVE age (wall clock stepped back after a sleep /
 * NTP resync) as fresh, so the entry would be served until the clock catches up again. A negative
 * age is untrustworthy: treat it as stale and re-read.
 */
export function isFresh(now: number, stampedAt: number, ttlMs: number): boolean {
  const age = now - stampedAt;
  return age >= 0 && age < ttlMs;
}
