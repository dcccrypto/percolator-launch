/**
 * Small key/value store for the bot API (keys, idempotency, weighted limits).
 *
 * Upstash Redis when UPSTASH_REDIS_REST_URL / _TOKEN are set (already used by the app's rate limiter, no new service);
 * otherwise an in-process map (local dev, tests). A Redis error marks the store degraded and opens a 30 s circuit breaker.
 * Limits and idempotency fall back to the per-instance map meanwhile (weaker, the same choice lib/upstash-rate-limit.ts
 * makes). API key lookups never do: they throw KvUnavailableError (a retryable 503 kv_unavailable), because an empty
 * answer would tell a valid key it is invalid. /api/v1/health reports the degraded state.
 */
import { Redis } from "@upstash/redis";
import { sharedKvConfigured } from "./config";

/** The shared store failed and the caller needs the real answer (a key lookup): never answered from the fallback map. */
export class KvUnavailableError extends Error {
  constructor() {
    super("bot-api KV unavailable");
    this.name = "KvUnavailableError";
  }
}

/** While the store is failing, skip it for this long (circuit breaker); the next call after that probes it again. */
export const BREAKER_MS = 30_000;
/** Per-call ceiling for the Upstash REST call. A key lookup must answer in about this time, not in 13 s. */
export const KV_TIMEOUT_MS = 1_500;

export interface Kv {
  get(key: string): Promise<string | null>;
  /** Returns false when `nx` is set and the key exists. */
  set(key: string, value: string, opts?: { ttlSec?: number; nx?: boolean }): Promise<boolean>;
  del(key: string): Promise<void>;
  /** Adds `by` and returns the new value; the TTL is set when the key is created. */
  incrBy(key: string, by: number, ttlSec: number): Promise<number>;
  /**
   * Like get, but a store failure throws KvUnavailableError instead of answering from a per-instance fallback.
   * Used where an empty answer would be wrong (API key records).
   */
  getAuthoritative?(key: string): Promise<string | null>;
  /**
   * Like set, but a store failure throws KvUnavailableError instead of writing to a per-instance fallback. Used where a write
   * that did not reach the shared store must fail loudly (issuing and revoking API keys).
   */
  setAuthoritative?(key: string, value: string, opts?: { ttlSec?: number; nx?: boolean }): Promise<boolean>;
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

export class UpstashKv implements Kv {
  readonly backend = "upstash" as const;
  private failedAt = 0;
  constructor(private r: Redis, private fallback: MemoryKv, private now: () => number = Date.now) {}
  private open(): boolean {
    return this.failedAt > 0 && this.now() - this.failedAt < BREAKER_MS;
  }
  private fail(): void {
    if (!this.open()) console.warn(JSON.stringify({ svc: "bot-api", event: "kv_degraded", backend: "upstash" }));
    this.failedAt = this.now();
  }
  private async run<T>(f: () => Promise<T>, g: () => Promise<T>): Promise<T> {
    if (this.open()) return g();
    try {
      return await f();
    } catch {
      this.fail();
      return g();
    }
  }
  private async read(key: string): Promise<string | null> {
    const v = await this.r.get<string>(key);
    return v === null || v === undefined ? null : typeof v === "string" ? v : JSON.stringify(v);
  }
  get(key: string) {
    return this.run(() => this.read(key), () => this.fallback.get(key));
  }
  async getAuthoritative(key: string): Promise<string | null> {
    if (this.open()) throw new KvUnavailableError();
    try {
      return await this.read(key);
    } catch {
      this.fail();
      throw new KvUnavailableError();
    }
  }
  set(key: string, value: string, opts: { ttlSec?: number; nx?: boolean } = {}) {
    return this.run(async () => {
      const o = opts.ttlSec ? (opts.nx ? { ex: opts.ttlSec, nx: true as const } : { ex: opts.ttlSec }) : opts.nx ? { nx: true as const } : undefined;
      const r = await this.r.set(key, value, o as never);
      return r === "OK";
    }, () => this.fallback.set(key, value, opts));
  }
  async setAuthoritative(key: string, value: string, opts: { ttlSec?: number; nx?: boolean } = {}): Promise<boolean> {
    if (this.open()) throw new KvUnavailableError();
    try {
      const o = opts.ttlSec ? (opts.nx ? { ex: opts.ttlSec, nx: true as const } : { ex: opts.ttlSec }) : opts.nx ? { nx: true as const } : undefined;
      return (await this.r.set(key, value, o as never)) === "OK";
    } catch {
      this.fail();
      throw new KvUnavailableError();
    }
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
    return this.open();
  }
}

let kv: Kv | null = null;
export function getKv(): Kv {
  if (kv) return kv;
  const mem = new MemoryKv();
  if (sharedKvConfigured()) {
    // Fail fast: at most one quick retry and a hard per-call timeout, so an outage costs ~KV_TIMEOUT_MS, not the client default (~13 s).
    const redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL as string,
      token: process.env.UPSTASH_REDIS_REST_TOKEN as string,
      retry: { retries: 1, backoff: () => 100 },
      signal: () => AbortSignal.timeout(KV_TIMEOUT_MS),
    });
    kv = new UpstashKv(redis, mem);
  } else {
    kv = mem;
  }
  return kv;
}
/** Test seam. */
export function __setKvForTest(v: Kv | null): void {
  kv = v;
}
