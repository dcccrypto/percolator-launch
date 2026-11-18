/**
 * Age of a cache entry stamped with Date.now(). A negative age means the wall clock stepped
 * backwards since the entry was written; treat it as unknown/expired (Infinity), never fresh.
 */
export function cacheAgeMs(at: number, now: number = Date.now()): number {
  const age = now - at;
  return age >= 0 ? age : Infinity;
}
