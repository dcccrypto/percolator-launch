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

/**
 * Rate-limit / connection-cap key for a caller behind the platform proxy (#3514).
 *
 * - The RIGHTMOST X-Forwarded-For entry, not the leftmost: the edge proxy (Railway) appends the
 *   address it saw, so the last entry is the only one a client cannot write. The leftmost is
 *   whatever the client sent, so keying on it let one caller rotate its limiter bucket per request.
 * - IPv6 is bucketed by /64. One host is routinely given a whole /64, so a per-/128 key let it
 *   rotate through 2^64 buckets. IPv4-mapped IPv6 (::ffff:a.b.c.d) keys as the IPv4 address.
 */
export function clientKey(xForwardedFor: string | string[] | undefined, remote: string | undefined): string {
  const joined = Array.isArray(xForwardedFor) ? xForwardedFor.join(",") : xForwardedFor;
  const hops = (joined ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  const addr = hops.length > 0 ? hops[hops.length - 1] : remote?.trim();
  return addr ? normalizeAddress(addr) : "unknown";
}

/** IPv4 as-is (port stripped); IPv6 to its /64 prefix; anything unparseable as-is. */
export function normalizeAddress(raw: string): string {
  let a = raw.trim();
  // "[v6]:port" / "[v6]"
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(a);
  if (bracket) a = bracket[1];
  // "a.b.c.d:port"
  const v4port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(a);
  if (v4port) return v4port[1];
  if (!a.includes(":")) return a;
  a = a.replace(/%.*$/, "").toLowerCase();
  const mapped = /^[0:]*:ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) return mapped[1];
  const groups = expandIpv6(a);
  if (!groups) return a;
  return `${groups.slice(0, 4).join(":")}::/64`;
}

function expandIpv6(a: string): string[] | null {
  const parts = a.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  // A trailing dotted IPv4 counts as two groups.
  const last = tail.length ? tail[tail.length - 1] : head[head.length - 1];
  const v4Groups = last && last.includes(".") ? 1 : 0;
  const missing = 8 - (head.length + tail.length + v4Groups);
  if (parts.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;
  const all = [...head, ...Array<string>(parts.length === 2 ? missing : 0).fill("0"), ...tail];
  if (!all.every((g) => /^[0-9a-f]{1,4}$/.test(g) || g.includes("."))) return null;
  return all.map((g) => (g.includes(".") ? g : g.replace(/^0+(?=.)/, "")));
}

/** Open sockets allowed per caller key (several tabs, a NAT'd office) and in total (#3514). */
export const MAX_WS_CONNECTIONS_PER_CLIENT = 20;
export const MAX_WS_CONNECTIONS_TOTAL = 5_000;

/**
 * Counts open sockets per caller key and in total. `acquire` checks and reserves in one synchronous
 * step (no check-then-act gap between concurrent upgrades); every successful `acquire` must be
 * matched by exactly one `release`.
 */
export class ConnectionLimiter {
  private readonly perKey = new Map<string, number>();
  private open = 0;
  constructor(
    private readonly perKeyMax: number = MAX_WS_CONNECTIONS_PER_CLIENT,
    private readonly totalMax: number = MAX_WS_CONNECTIONS_TOTAL,
  ) {}

  /** Reserve a slot for `key`. False (nothing reserved) when the key or the server is full. */
  acquire(key: string): boolean {
    if (this.open >= this.totalMax) return false;
    const n = this.perKey.get(key) ?? 0;
    if (n >= this.perKeyMax) return false;
    this.perKey.set(key, n + 1);
    this.open++;
    return true;
  }

  release(key: string): void {
    const n = this.perKey.get(key);
    if (n === undefined) return;
    if (n <= 1) this.perKey.delete(key);
    else this.perKey.set(key, n - 1);
    this.open = Math.max(0, this.open - 1);
  }

  get total(): number { return this.open; }
  countFor(key: string): number { return this.perKey.get(key) ?? 0; }
}

/** The parts of an upgrade request the gate reads (node:http IncomingMessage satisfies it). */
export interface UpgradeRequestLike {
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress?: string | undefined; once(event: "close", fn: () => void): unknown };
}

/**
 * `verifyClient` for the price-ws WebSocketServer (#3514): refuse an upgrade with 429 when the
 * caller opens sockets too fast and 503 when it (or the server) is at the connection cap. The
 * slot is reserved synchronously and released once, when the underlying TCP socket closes, which
 * covers an upgrade that fails after this check as well as a socket that later closes.
 */
export function createUpgradeGate(opts: {
  upgrades: RateLimiter;
  connections: ConnectionLimiter;
  now?: () => number;
}): (info: { req: UpgradeRequestLike }, cb: (ok: boolean, code?: number, message?: string) => void) => void {
  const now = opts.now ?? Date.now;
  return (info, cb) => {
    const key = clientKey(info.req.headers["x-forwarded-for"], info.req.socket.remoteAddress);
    if (!opts.upgrades.allow(key, now())) { cb(false, 429, "Too Many Requests"); return; }
    if (!opts.connections.acquire(key)) { cb(false, 503, "Too Many Connections"); return; }
    let released = false;
    info.req.socket.once("close", () => {
      if (released) return;
      released = true;
      opts.connections.release(key);
    });
    cb(true);
  };
}
