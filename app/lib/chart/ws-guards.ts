/**
 * Abuse bounds for the public price-ws socket and its HTTP side. Pure (clock injected) so the
 * limits are unit-tested instead of living untested inside the server script.
 */

const BASE58_SLAB = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Hard ceilings. */
export const MAX_SUBSCRIPTIONS_PER_CLIENT = 16;
/** Largest legitimate client message is `{"type":"subscribe","slabAddress":"<44 chars>"}` (~70 bytes). */
export const WS_MAX_PAYLOAD_BYTES = 1024;
/** Most slabs the trades poll will watch at once (one ANY($1) query). */
export const MAX_WATCHED_SLABS = 64;

export type SubscribeVerdict = { ok: true } | { ok: false; reason: "bad-slab" | "unknown-slab" | "limit" };

/**
 * May a client with `current` subscriptions subscribe to `slab`?
 * `known` is the market set (database / registry minus blocked). While the set is not loaded yet
 * (`marketsLoaded` false) only the address FORMAT is enforced, because refusing everything during
 * boot would break the feed; the per-client cap still bounds the damage.
 */
export function checkSubscribe(opts: {
  slab: unknown;
  current: ReadonlySet<string>;
  known: ReadonlySet<string>;
  marketsLoaded: boolean;
  isBlocked(slab: string): boolean;
}): SubscribeVerdict {
  const { slab } = opts;
  if (typeof slab !== "string" || !BASE58_SLAB.test(slab)) return { ok: false, reason: "bad-slab" };
  if (opts.isBlocked(slab)) return { ok: false, reason: "unknown-slab" };
  if (opts.marketsLoaded && !opts.known.has(slab)) return { ok: false, reason: "unknown-slab" };
  if (!opts.current.has(slab) && opts.current.size >= MAX_SUBSCRIPTIONS_PER_CLIENT) return { ok: false, reason: "limit" };
  return { ok: true };
}

/** Same rule for the keeper ingest: a tick for a market we do not serve is dropped, not stored. */
export function isKnownSlab(slab: string, known: ReadonlySet<string>, marketsLoaded: boolean, isBlocked: (s: string) => boolean): boolean {
  if (!BASE58_SLAB.test(slab) || isBlocked(slab)) return false;
  return !marketsLoaded || known.has(slab);
}

/** Sliding-window limiter keyed by caller (e.g. client IP). */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly max: number, private readonly windowMs: number, private readonly maxKeys = 5_000) {}

  /** True when the call is allowed (and counted). */
  allow(key: string, nowMs: number): boolean {
    const floor = nowMs - this.windowMs;
    const arr = (this.hits.get(key) ?? []).filter((t) => t > floor);
    if (arr.length >= this.max) { this.hits.set(key, arr); return false; }
    arr.push(nowMs);
    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) this.hits.delete(this.hits.keys().next().value as string);
    this.hits.set(key, arr);
    return true;
  }
}

/** Client address behind a proxy: the first X-Forwarded-For hop, else the socket address. */
export function clientKey(xForwardedFor: string | string[] | undefined, remote: string | undefined): string {
  const h = Array.isArray(xForwardedFor) ? xForwardedFor[0] : xForwardedFor;
  const first = h?.split(",")[0]?.trim();
  return first || remote || "unknown";
}
