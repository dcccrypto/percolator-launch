/**
 * rpc-resilience.ts — PERC-532
 *
 * RPC rate-limit resilience: exponential backoff, jitter, and endpoint
 * rotation so bots never crash on 429 / transient RPC failures.
 *
 * Usage:
 *   const rpc = new ResilientConnection(buildEndpointList());
 *   const info = await rpc.getAccountInfo(pubkey);
 *   const sig  = await rpc.sendAndConfirm(tx, signers);
 */

import {
  Connection,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
  type ConnectionConfig,
  type SendOptions,
  type Commitment,
} from "@solana/web3.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_RETRIES = 7; // 7 attempts → max total backoff ≈ 1m 03s
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;

// ── Error classification ──────────────────────────────────────────────────────

export function isRateLimitError(err: unknown): boolean {
  if (!err) return false;
  const msg = String((err as any)?.message ?? "").toLowerCase();
  const status = (err as any)?.status ?? (err as any)?.statusCode;
  return (
    status === 429 ||
    msg.includes("429") ||
    msg.includes("too many requests") ||
    msg.includes("rate limit") ||
    msg.includes("ratelimit") ||
    msg.includes("exceeded") // Helius "requests exceeded"
  );
}

export function isTransientError(err: unknown): boolean {
  if (isRateLimitError(err)) return true;
  const msg = String((err as any)?.message ?? "").toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("fetch failed") ||
    msg.includes("network error") ||
    msg.includes("503") ||
    msg.includes("502")
  );
}

// ── Backoff ───────────────────────────────────────────────────────────────────

/** Exponential backoff with ±25% jitter. */
export function calcBackoff(attempt: number): number {
  const base = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
  const jitter = Math.random() * base * 0.25;
  return Math.floor(base + jitter);
}

// ── Generic retry helper ──────────────────────────────────────────────────────

export async function withRetry<T>(
  fn: () => Promise<T>,
  label = "rpc",
  maxRetries = MAX_RETRIES,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: unknown) {
      attempt++;
      if (attempt >= maxRetries) throw err;
      if (!isRateLimitError(err) && !isTransientError(err)) throw err;

      const wait = calcBackoff(attempt - 1);
      const reason = isRateLimitError(err) ? "429 rate-limit" : "transient";
      console.warn(
        `[rpc] ${reason} on ${label} (attempt ${attempt}/${maxRetries}) — retry in ${wait}ms`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// ── Token-bucket rate limiter ─────────────────────────────────────────────────

/**
 * Very lightweight per-connection request throttle.
 * Default: 8 req/s with burst of 12 — well under Helius free tier (10 req/s).
 */
export class RpcThrottle {
  private queue: Array<() => void> = [];
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillIntervalMs: number;

  constructor(maxRps = 8, burst = 12) {
    this.maxTokens = burst;
    this.tokens = burst;
    this.refillIntervalMs = Math.floor(1000 / maxRps);
    setInterval(() => this.refill(), this.refillIntervalMs).unref?.();
  }

  private refill() {
    if (this.tokens < this.maxTokens) {
      this.tokens++;
      const next = this.queue.shift();
      if (next) next();
    }
  }

  acquire(): Promise<void> {
    if (this.tokens > 0) {
      this.tokens--;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.tokens--;
        resolve();
      });
    });
  }
}

// ── Resilient Connection ──────────────────────────────────────────────────────

export class ResilientConnection {
  private readonly endpoints: string[];
  private readonly config: string | ConnectionConfig;
  private idx = 0;
  /** The active underlying Connection — use for functions that require
   *  a raw Connection (e.g. sendAndConfirmTransaction). */
  conn: Connection;
  private readonly throttle: RpcThrottle;

  constructor(
    endpoints: string[],
    config: string | ConnectionConfig = "confirmed",
    throttle?: RpcThrottle,
  ) {
    if (!endpoints.length) throw new Error("At least one RPC endpoint required");
    this.endpoints = endpoints;
    this.config = config;
    this.conn = new Connection(endpoints[0], config);
    this.throttle = throttle ?? new RpcThrottle();
  }

  currentEndpoint(): string {
    return this.endpoints[this.idx];
  }

  /** Rotate to the next RPC endpoint. */
  rotate(logFn?: (msg: string) => void): void {
    if (this.endpoints.length <= 1) return;
    this.idx = (this.idx + 1) % this.endpoints.length;
    this.conn = new Connection(this.endpoints[this.idx], this.config);
    const ep = this.endpoints[this.idx].replace(/api-key=([^&]+)/, "api-key=***");
    (logFn ?? console.warn)(
      `[rpc] Rotated to endpoint[${this.idx}]: ${ep.slice(0, 60)}`,
    );
  }

  /**
   * Execute an RPC call through the active connection with retry + rotation.
   * Throttles before each attempt to stay under rate limits.
   */
  async call<T>(
    fn: (c: Connection) => Promise<T>,
    opts: { label?: string; maxRetries?: number; logFn?: (msg: string) => void } = {},
  ): Promise<T> {
    const { label = "rpc", maxRetries = MAX_RETRIES, logFn } = opts;
    let attempt = 0;
    while (true) {
      await this.throttle.acquire();
      try {
        return await fn(this.conn);
      } catch (err: unknown) {
        attempt++;
        if (attempt >= maxRetries) throw err;
        if (!isRateLimitError(err) && !isTransientError(err)) throw err;

        const wait = calcBackoff(attempt - 1);
        const reason = isRateLimitError(err) ? "429" : "transient";
        const msg = `[rpc] ${reason} on ${label} (attempt ${attempt}/${maxRetries}) — ${wait}ms`;
        (logFn ?? console.warn)(msg);

        // Start rotating on the 2nd retry
        if (attempt >= 2) this.rotate(logFn);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  // ── Proxied Connection methods ──────────────────────────────────────────────

  getAccountInfo(
    ...args: Parameters<Connection["getAccountInfo"]>
  ) {
    return this.call((c) => c.getAccountInfo(...args), { label: "getAccountInfo" });
  }

  getBalance(...args: Parameters<Connection["getBalance"]>) {
    return this.call((c) => c.getBalance(...args), { label: "getBalance" });
  }

  getSlot(...args: Parameters<Connection["getSlot"]>) {
    return this.call((c) => c.getSlot(...args), { label: "getSlot" });
  }

  /**
   * Build + send a transaction with exponential backoff on 429.
   * Wraps sendAndConfirmTransaction.
   */
  async sendAndConfirm(
    tx: Transaction,
    signers: Keypair[],
    opts: { commitment?: Commitment; skipPreflight?: boolean; label?: string; logFn?: (msg: string) => void } = {},
  ): Promise<string> {
    const {
      commitment = "confirmed",
      skipPreflight = true,
      label = "sendAndConfirm",
      logFn,
    } = opts;
    return this.call(
      (c) =>
        sendAndConfirmTransaction(c, tx, signers, {
          commitment,
          skipPreflight,
        }),
      { label, logFn },
    );
  }
}

// ── Endpoint discovery ────────────────────────────────────────────────────────

/**
 * Build an ordered list of RPC endpoints from environment variables.
 *
 * Priority order:
 *   1. RPC_URLS (comma-separated, highest priority)
 *   2. RPC_URL
 *   3. Helius devnet (if HELIUS_DEVNET_API_KEY or HELIUS_API_KEY set)
 *   4. Public devnet fallback (always last)
 */
export function buildEndpointList(): string[] {
  const seen = new Set<string>();
  const endpoints: string[] = [];

  function add(url: string) {
    const u = url.trim();
    if (u && !seen.has(u)) {
      seen.add(u);
      endpoints.push(u);
    }
  }

  // 1. Comma-separated list
  const multi = process.env.RPC_URLS;
  if (multi) {
    for (const u of multi.split(",")) add(u);
  }

  // 2. Single primary
  if (process.env.RPC_URL) add(process.env.RPC_URL);

  // 3. Helius devnet
  const heliusKey =
    process.env.HELIUS_DEVNET_API_KEY ?? process.env.HELIUS_API_KEY;
  if (heliusKey) {
    add(`https://devnet.helius-rpc.com/?api-key=${heliusKey}`);
  }

  // 4. Public devnet fallback (rate-limited but works in a pinch)
  add("https://api.devnet.solana.com");

  return endpoints;
}
