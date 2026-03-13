/**
 * PERC-532: Resilient RPC client with exponential backoff and endpoint rotation.
 *
 * Wraps @solana/web3.js Connection to handle HTTP 429 (rate limit) responses
 * gracefully instead of crashing. Supports multiple RPC endpoints that are
 * rotated on persistent failures.
 *
 * Usage:
 *   const rpc = new ResilientRpc(endpoints, "confirmed");
 *   const connection = rpc.connection;  // use like a normal Connection
 *   await rpc.sendAndConfirmTx(tx, signers, opts);  // with retry logic
 */

import {
  Connection,
  type Commitment,
  type SendOptions,
  type ConfirmOptions,
  type Keypair,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { log, logError } from "./logger.js";

// ═══════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════

export interface RpcConfig {
  /** RPC endpoint URLs (first is primary, rest are fallbacks) */
  endpoints: string[];
  /** Commitment level */
  commitment: Commitment;
  /** Max retries per operation before rotating endpoint */
  maxRetries: number;
  /** Base delay for exponential backoff in ms */
  baseDelayMs: number;
  /** Max delay cap in ms */
  maxDelayMs: number;
  /** Jitter factor (0–1) — randomizes delay to avoid thundering herd */
  jitterFactor: number;
}

const DEFAULT_CONFIG: Omit<RpcConfig, "endpoints"> = {
  commitment: "confirmed",
  maxRetries: 5,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  jitterFactor: 0.3,
};

// ═══════════════════════════════════════════════════════════════
// Rate limit detection
// ═══════════════════════════════════════════════════════════════

function isRateLimitError(error: unknown): boolean {
  if (!error) return false;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes("429") ||
    msg.includes("Too Many Requests") ||
    msg.includes("rate limit") ||
    msg.includes("Rate limit") ||
    msg.includes("server responded with 429")
  );
}

function isTransientError(error: unknown): boolean {
  if (isRateLimitError(error)) return true;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes("503") ||
    msg.includes("502") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("socket hang up") ||
    msg.includes("fetch failed") ||
    msg.includes("getaddrinfo") ||
    msg.includes("Transaction was not confirmed")
  );
}

// ═══════════════════════════════════════════════════════════════
// Backoff calculation
// ═══════════════════════════════════════════════════════════════

function backoffDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  jitter: number,
): number {
  // Exponential: base * 2^attempt
  const expDelay = Math.min(maxMs, baseMs * Math.pow(2, attempt));
  // Add jitter: ±jitter%
  const jitterRange = expDelay * jitter;
  const randomJitter = (Math.random() * 2 - 1) * jitterRange;
  return Math.max(baseMs, Math.floor(expDelay + randomJitter));
}

// ═══════════════════════════════════════════════════════════════
// Resilient RPC Client
// ═══════════════════════════════════════════════════════════════

export class ResilientRpc {
  private readonly endpoints: string[];
  private readonly config: RpcConfig;
  private currentIdx: number = 0;
  private _connection: Connection;
  private consecutiveFailures: number = 0;
  private lastRotationTime: number = 0;

  // Stats
  readonly stats = {
    totalRequests: 0,
    totalRetries: 0,
    totalRotations: 0,
    rateLimitHits: 0,
  };

  constructor(endpoints: string | string[], commitment?: Commitment, overrides?: Partial<RpcConfig>) {
    this.endpoints = Array.isArray(endpoints) ? endpoints : [endpoints];
    if (this.endpoints.length === 0) {
      throw new Error("ResilientRpc: at least one endpoint is required");
    }

    this.config = {
      ...DEFAULT_CONFIG,
      ...overrides,
      endpoints: this.endpoints,
      commitment: commitment ?? overrides?.commitment ?? DEFAULT_CONFIG.commitment,
    };

    this._connection = new Connection(this.endpoints[0], this.config.commitment);
    log("rpc", `Initialized with ${this.endpoints.length} endpoint(s), primary: ${this.maskUrl(this.endpoints[0])}`);
  }

  /** Current active Connection — use for read-only queries. */
  get connection(): Connection {
    return this._connection;
  }

  /** Current endpoint URL (masked). */
  get currentEndpoint(): string {
    return this.maskUrl(this.endpoints[this.currentIdx]);
  }

  /**
   * Execute an async RPC operation with exponential backoff retry on transient errors.
   * Rotates to the next endpoint after exhausting retries on the current one.
   */
  async withRetry<T>(
    operation: (conn: Connection) => Promise<T>,
    label: string,
  ): Promise<T> {
    this.stats.totalRequests++;
    let lastError: unknown;

    // Try each endpoint at most once (rotate on exhaust)
    for (let rotation = 0; rotation < this.endpoints.length; rotation++) {
      for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
        try {
          const result = await operation(this._connection);
          // Success — reset failure counter
          this.consecutiveFailures = 0;
          return result;
        } catch (error) {
          lastError = error;

          if (isRateLimitError(error)) {
            this.stats.rateLimitHits++;
            this.consecutiveFailures++;
          }

          if (!isTransientError(error)) {
            // Non-transient (program error, etc.) — don't retry
            throw error;
          }

          this.stats.totalRetries++;
          const delay = backoffDelay(
            attempt,
            isRateLimitError(error) ? this.config.baseDelayMs * 2 : this.config.baseDelayMs,
            this.config.maxDelayMs,
            this.config.jitterFactor,
          );

          const errType = isRateLimitError(error) ? "429" : "transient";
          log("rpc", `${label}: ${errType} error (attempt ${attempt + 1}/${this.config.maxRetries}), retrying in ${delay}ms`);
          await sleep(delay);
        }
      }

      // Exhausted retries on this endpoint — rotate
      if (this.endpoints.length > 1) {
        this.rotate(label);
      }
    }

    // All endpoints exhausted
    throw lastError;
  }

  /**
   * Send and confirm a transaction with retry logic on 429/transient errors.
   * Non-transient program errors (0x4, insufficient funds, etc.) are NOT retried.
   */
  async sendAndConfirmTx(
    tx: Transaction,
    signers: Keypair[],
    opts?: ConfirmOptions,
    label?: string,
  ): Promise<string> {
    return this.withRetry(
      async (conn) => {
        return await sendAndConfirmTransaction(conn, tx, signers, {
          commitment: this.config.commitment,
          ...opts,
          skipPreflight: false,
        });
      },
      label ?? "sendAndConfirmTx",
    );
  }

  /**
   * Rotate to the next RPC endpoint.
   */
  private rotate(label: string): void {
    const prevIdx = this.currentIdx;
    this.currentIdx = (this.currentIdx + 1) % this.endpoints.length;
    this._connection = new Connection(this.endpoints[this.currentIdx], this.config.commitment);
    this.stats.totalRotations++;
    this.lastRotationTime = Date.now();

    log("rpc", `${label}: rotated endpoint ${this.maskUrl(this.endpoints[prevIdx])} → ${this.maskUrl(this.endpoints[this.currentIdx])}`);
  }

  /** Mask API keys in URLs for safe logging.
   *
   * Handles:
   *  - Query-param keys: `?api-key=xxx` → `?***`
   *  - Path-based keys (QuickNode, Alchemy): `host.com/abcdef123` → `host.com/***`
   *  - Keeps scheme + hostname visible for debugging.
   */
  private maskUrl(url: string): string {
    try {
      const u = new URL(url);
      // Strip query string entirely
      u.search = "";
      // If pathname has a segment that looks like an API key (hex/alphanum 16+ chars), mask it
      u.pathname = u.pathname.replace(/\/[a-zA-Z0-9_-]{16,}(\/|$)/g, "/***$1");
      return u.origin + u.pathname;
    } catch {
      // Fallback for malformed URLs: just show hostname-ish prefix
      return url.replace(/(:\/\/[^/]+).*/, "$1/***");
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Parse RPC_URLS env var (comma-separated) with RPC_URL as primary fallback.
 */
export function parseRpcEndpoints(rpcUrl: string): string[] {
  const extra = process.env.RPC_URLS;
  if (!extra) return [rpcUrl];

  const urls = extra
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Primary goes first, then extras (deduplicated)
  const all = [rpcUrl, ...urls];
  return [...new Set(all)];
}
