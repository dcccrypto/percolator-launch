/**
 * Small key/value store for the bot API (keys, idempotency, weighted limits).
 *
 * Upstash Redis when UPSTASH_REDIS_REST_URL / _TOKEN are set (already used by the app's rate limiter, no new service);
 * otherwise an in-process map (local dev, tests). A Redis error falls back to the map for that call and marks the store
 * degraded, the same choice lib/upstash-rate-limit.ts makes: the API keeps answering, and /api/v1/health says so.
 */
import { Redis } from "@upstash/redis";

export interface Kv {
  get(key: string): Promise<string | null>;
  /** Returns false when `nx` is set and the key exists. */
  set(key: string, value: string, opts?: { ttlSec?: number; nx?: boolean }): Promise<boolean>;
  del(key: string): Promise<void>;
  /** Adds `by` and returns the new value; the TTL is set when the key is created. */
  incrBy(key: string, by: number, ttlSec: number): Promise<number>;
  readonly backend: "upstash" | "memory";
  degraded(): boolean;
}

export class MemoryKv implements Kv {
  readonly backend = "memory" as const;
  private m = new Map<string, { v: string; exp: number }>();
  constructor(private now: () => number = Date.now, private cap = 50_000) {}
  private live(key: string) {
    const e = this.m.get(key);
    if (!e) return undefined;
    if (e.exp && e.exp <= this.now()) {
      this.m.delete(key);
      return undefined;
    }
    return e;
  }
  private sweep() {
    if (this.m.size < this.cap) return;
    const t = this.now();
    for (const [k, e] of this.m) if (e.exp && e.exp <= t) this.m.delete(k);
    // Still full: drop the oldest inserts (Map keeps insertion order).
    for (const k of this.m.keys()) {
      if (this.m.size < this.cap) break;
      this.m.delete(k);
    }
  }
  async get(key: string) {
    return this.live(key)?.v ?? null;
  }
  async set(key: string, value: string, opts: { ttlSec?: number; nx?: boolean } = {}) {
    if (opts.nx && this.live(key)) return false;
    this.sweep();
    this.m.set(key, { v: value, exp: opts.ttlSec ? this.now() + opts.ttlSec * 1000 : 0 });
    return true;
  }
  async del(key: string) {
    this.m.delete(key);
  }
  async incrBy(key: string, by: number, ttlSec: number) {
    const e = this.live(key);
    const n = (e ? Number(e.v) : 0) + by;
    if (!e) this.sweep();
    this.m.set(key, { v: String(n), exp: e ? e.exp : this.now() + ttlSec * 1000 });
    return n;
  }
  degraded() {
    return false;
  }
}

class UpstashKv implements Kv {
  readonly backend = "upstash" as const;
  private failedAt = 0;
  constructor(private r: Redis, private fallback: MemoryKv) {}
  private async run<T>(f: () => Promise<T>, g: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch {
      if (!this.failedAt) console.warn(JSON.stringify({ svc: "bot-api", event: "kv_degraded", backend: "upstash" }));
      this.failedAt = Date.now();
      return g();
    }
  }
  get(key: string) {
    return this.run(async () => {
      const v = await this.r.get<string>(key);
      return v === null || v === undefined ? null : typeof v === "string" ? v : JSON.stringify(v);
    }, () => this.fallback.get(key));
  }
  set(key: string, value: string, opts: { ttlSec?: number; nx?: boolean } = {}) {
    return this.run(async () => {
      const o = opts.ttlSec ? (opts.nx ? { ex: opts.ttlSec, nx: true as const } : { ex: opts.ttlSec }) : opts.nx ? { nx: true as const } : undefined;
      const r = await this.r.set(key, value, o as never);
      return r === "OK";
    }, () => this.fallback.set(key, value, opts));
  }
  del(key: string) {
    return this.run(async () => void (await this.r.del(key)), () => this.fallback.del(key));
  }
  incrBy(key: string, by: number, ttlSec: number) {
    return this.run(async () => {
      const n = await this.r.incrby(key, by);
      if (n === by) await this.r.expire(key, ttlSec);
      return n;
    }, () => this.fallback.incrBy(key, by, ttlSec));
  }
  degraded() {
    return this.failedAt > 0 && Date.now() - this.failedAt < 60_000;
  }
}

let kv: Kv | null = null;
export function getKv(): Kv {
  if (kv) return kv;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const mem = new MemoryKv();
  kv = url && token ? new UpstashKv(new Redis({ url, token }), mem) : mem;
  return kv;
}
/** Test seam. */
export function __setKvForTest(v: Kv | null): void {
  kv = v;
}
