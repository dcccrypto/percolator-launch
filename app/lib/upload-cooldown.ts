/**
 * Per-key upload cooldown (in-memory, per process) for the logo upload routes.
 *
 * Clock policy: stamps come only from the server's own clock, never from a client.
 * - age < 0 (wall clock stepped backwards, stamp is in the future): the stamp is
 *   unusable, so we RESET (not limited). Failing closed would lock the creator out
 *   for as long as the step, and the cooldown is anti-spam, not a security boundary
 *   (uploads are already authenticated).
 * - non-finite stamp (NaN/Infinity, should be impossible): treated as LIMITED, so a
 *   corrupt value can never silently disable the limit.
 * - Map is bounded: expired entries are swept on record, plus a hard size cap.
 */
export interface UploadCooldown {
  isLimited(key: string): boolean;
  record(key: string): void;
  /** Test hook: store an explicit stamp. */
  recordAt(key: string, stamp: number): void;
  size(): number;
}

export function createUploadCooldown(
  windowMs: number,
  now: () => number = Date.now,
  maxEntries = 1000,
): UploadCooldown {
  const stamps = new Map<string, number>();

  function sweep(t: number) {
    for (const [k, v] of stamps) {
      const age = t - v;
      if (Number.isFinite(age) && (age < 0 || age >= windowMs)) stamps.delete(k);
    }
    // Hard cap: evict oldest-inserted until under the limit.
    while (stamps.size > maxEntries) {
      const first = stamps.keys().next();
      if (first.done) break;
      stamps.delete(first.value);
    }
  }

  return {
    isLimited(key) {
      const last = stamps.get(key);
      if (last === undefined) return false;
      const age = now() - last;
      if (!Number.isFinite(age)) return true;
      if (age < 0) return false;
      return age < windowMs;
    },
    record(key) {
      this.recordAt(key, now());
    },
    recordAt(key, stamp) {
      stamps.delete(key); // refresh insertion order
      stamps.set(key, stamp);
      sweep(now());
    },
    size: () => stamps.size,
  };
}
