/**
 * Batching JSON-RPC transport for Solana Connection.
 *
 * Problem: Solana web3.js Connection fires individual HTTP POST for every RPC call.
 * On a page with multiple hooks (SlabProvider, useStakePool, useInsuranceLP, etc.)
 * this generates 30-80+ requests per page load, overwhelming the rate-limited /api/rpc proxy.
 *
 * Solution: This module intercepts fetch calls to /api/rpc and batches them:
 * 1. Individual JSON-RPC requests are queued in a microtask-based batch window (50ms)
 * 2. Queued requests are sent as a single JSON-RPC batch array
 * 3. Responses are routed back to individual callers
 *
 * Features:
 * - Request deduplication (same method+params within batch window → shared response)
 * - Exponential backoff on 429 errors
 * - Configurable batch size limits
 * - Transparent to callers — each gets their own Response object
 */

import { reportRpcOutcome, rpcErrorCode } from "@/lib/rpc-health";
import { RPC_MAX_BATCH_SIZE } from "@/lib/rpc-limits";

/** Default cap on queued (not yet sent) reads; beyond it the oldest are rejected. */
const DEFAULT_MAX_QUEUE_SIZE = 500;
/** Default timeout for one batch HTTP request (ms). */
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

/**
 * Methods that must NOT be batched or deduplicated.
 *
 * Mutating methods (sendTransaction, simulateTransaction) are excluded to prevent
 * "Missing response from batch" errors when the upstream RPC returns a response with
 * a null/mismatched id for write operations.
 *
 * Confirmation/status polling methods (getSignatureStatuses) are also excluded because
 * the superstruct validator in @solana/web3.js v1 rejects responses with wrong id types
 * when they pass through the batch layer — causing "Expected the value to satisfy a
 * union of type | type, but received: [object Object]" errors in the Token Factory
 * confirmation flow (GH#1310).
 */
const UNBATCHABLE_METHODS = new Set([
  "sendTransaction",
  "simulateTransaction",
  // Confirmation polling — must bypass batch to avoid superstruct id-type validation errors
  "getSignatureStatuses",
]);

/**
 * Latency-critical methods flushed IMMEDIATELY instead of waiting out the
 * coalescing window. These sit on the transaction-submission critical path
 * (confirm click → wallet popup), where the batch window is pure added
 * latency: they fire as one-off calls at click time, so there is nothing to
 * coalesce them with — but each still paid the full window before its batch
 * flushed. They still ride the normal batch pipeline (dedupe, retry,
 * backoff); only the timer wait is skipped. Anything already queued flushes
 * with them, so no other request is ever delayed by this.
 */
const FAST_FLUSH_METHODS = new Set([
  "getLatestBlockhash",
  "getRecentPrioritizationFees",
  "getBalance",
]);

/**
 * Methods whose result must never be handed to a caller that asked AFTER the
 * original batch left the browser. They keep the original same-window-only dedupe
 * (a blockhash joined onto a slow in-flight retry loop could already be stale).
 * Every other read joins an identical request until that request settles.
 */
const WINDOW_ONLY_DEDUPE_METHODS = new Set([
  "getLatestBlockhash",
  "getRecentPrioritizationFees",
  "getFeeForMessage",
  "isBlockhashValid",
  "requestAirdrop",
]);

/** Retries for a non-429 transport failure (5xx / network). 429 keeps `maxRetries`. */
const DEFAULT_MAX_SERVER_ERROR_RETRIES = 2;

/** Pending request waiting to be batched */
interface PendingRequest {
  id: number;
  method: string;
  params: unknown;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

/** Configuration for the batch transport */
export interface BatchRpcConfig {
  /** URL to send batched requests to (default: /api/rpc) */
  endpoint: string;
  /** Max time to wait before flushing a batch (ms, default: 50) */
  batchWindowMs?: number;
  /** Max requests per batch (default: 30) */
  maxBatchSize?: number;
  /** Initial backoff delay on 429 (ms, default: 1000) */
  initialBackoffMs?: number;
  /** Max backoff delay (ms, default: 30000) */
  maxBackoffMs?: number;
  /** Max retries on 429 (default: 5) */
  maxRetries?: number;
  /** Max retries on 5xx / network failure (default: 2). A dead RPC must not be hammered 6x per batch. */
  maxServerErrorRetries?: number;
  /** Max queued reads while backing off; the oldest are rejected beyond it (default: 500). */
  maxQueueSize?: number;
  /** Abort a batch HTTP request after this long (ms, default: 20000). */
  requestTimeoutMs?: number;
}

/**
 * Create a batching RPC manager.
 * Returns a `fetchMiddleware` compatible with @solana/web3.js Connection options.
 */
export function createBatchRpc(config: BatchRpcConfig) {
  const {
    endpoint,
    batchWindowMs = 50,
    maxBatchSize = 30,
    initialBackoffMs = 1000,
    maxBackoffMs = 30_000,
    maxRetries = 5,
    maxServerErrorRetries = DEFAULT_MAX_SERVER_ERROR_RETRIES,
    maxQueueSize = DEFAULT_MAX_QUEUE_SIZE,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = config;
  /** Never send more entries per request than /api/rpc accepts, whatever maxBatchSize says. */
  const chunkSize = Math.max(1, Math.min(maxBatchSize, RPC_MAX_BATCH_SIZE));

  let queue: PendingRequest[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let nextId = 1;
  let backoffUntil = 0;
  /** Consecutive fully-failed batches. Drives the exponential, capped inter-batch cooldown. */
  let consecutiveFailures = 0;

  /**
   * Cooldown after a batch has failed for good. Doubles per consecutive failed batch from
   * `initialBackoffMs`, capped at `maxBackoffMs`; cleared by the first success. While it is
   * active every new read just queues (and dedupes) instead of each firing its own request.
   */
  function noteBatchFailure() {
    consecutiveFailures++;
    const cooldown = Math.min(initialBackoffMs * 2 ** (consecutiveFailures - 1), maxBackoffMs);
    backoffUntil = Date.now() + cooldown;
  }

  /** Dedupe cache: a key stays until its request settles (or, for window-only methods, until flush). */
  const dedupeCache = new Map<string, Promise<string>>();

  function dedupeKey(method: string, params: unknown): string {
    return `${method}:${JSON.stringify(params)}`;
  }

  /** Outcome of sending one chunk: ok, transport failure (counts toward backoff), or rejected by shape (does not). */
  type ChunkOutcome = "ok" | "transport-failure" | "rejected";

  /** Send ONE chunk (<= maxBatchSize entries) and settle every caller in it. Never throws. */
  async function sendChunk(batch: PendingRequest[]): Promise<ChunkOutcome> {
    const payload = batch.map((p) => ({
      jsonrpc: "2.0",
      id: p.id,
      method: p.method,
      params: p.params,
    }));

    let attempt = 0;
    let currentBackoff = initialBackoffMs;

    while (attempt <= maxRetries) {
      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timeout = controller ? setTimeout(() => controller.abort(), requestTimeoutMs) : null;
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          ...(controller ? { signal: controller.signal } : {}),
        });

        if (response.status === 429) {
          attempt++;
          if (attempt > maxRetries) {
            // Give up — return error to all callers
            const errJson = JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32005, message: "Rate limited after retries" },
              id: null,
            });
            for (const p of batch) {
              p.resolve(errJson);
            }
            return "transport-failure";
          }
          const retryAfter = response.headers.get("Retry-After");
          const retryMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : currentBackoff;
          const jitter = Math.random() * 0.3 * retryMs;
          await new Promise((r) => setTimeout(r, retryMs + jitter));
          currentBackoff = Math.min(currentBackoff * 2, maxBackoffMs);
          continue;
        }

        // Other 4xx = the request itself was refused (shape/size/forbidden), not an RPC outage.
        // Retrying the identical body cannot help and it must not lengthen the outage backoff
        // or poison other chunks: reject only this chunk's callers.
        if (response.status >= 400 && response.status < 500) {
          const err = new Error(`RPC batch request rejected: HTTP ${response.status}`);
          for (const p of batch) p.reject(err);
          return "rejected";
        }

        // 5xx: throw so the retry loop catches it (an empty 5xx body would otherwise surface
        // as "SyntaxError: Unexpected end of JSON input", masking the real HTTP error).
        if (!response.ok) {
          throw new Error(`RPC batch request failed: HTTP ${response.status}`);
        }

        const results = await response.json();

        if (Array.isArray(results)) {
          // Map results back by id
          const resultById = new Map<number, unknown>();
          for (const r of results) {
            if (r && r.id != null) {
              resultById.set(r.id, r);
            }
          }

          // Validate that all requested IDs are present in the response
          const requestedIds = new Set(batch.map((p) => p.id));
          const receivedIds = new Set(resultById.keys());
          const missingIds = Array.from(requestedIds).filter(
            (id) => !receivedIds.has(id)
          );

          if (missingIds.length > 0) {
            console.warn(
              `[batchRpc] Missing responses for IDs: ${missingIds.join(", ")} (sent ${requestedIds.size}, received ${receivedIds.size})`
            );
          }

          for (const p of batch) {
            const result = resultById.get(p.id);
            p.resolve(JSON.stringify(result ?? {
              jsonrpc: "2.0",
              error: { code: -32603, message: "Missing response from batch" },
              id: p.id,
            }));
          }
        } else if (batch.length === 1) {
          // Single-item batch may get non-array response
          batch[0].resolve(JSON.stringify(results));
        } else {
          for (const p of batch) {
            p.resolve(JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: "Unexpected non-array response" },
              id: p.id,
            }));
          }
        }
        return "ok";
      } catch (error) {
        attempt++;
        if (attempt > maxServerErrorRetries) {
          for (const p of batch) {
            p.reject(error instanceof Error ? error : new Error(String(error)));
          }
          return "transport-failure";
        }
        const jitter = Math.random() * 0.3 * currentBackoff;
        await new Promise((r) => setTimeout(r, currentBackoff + jitter));
        currentBackoff = Math.min(currentBackoff * 2, maxBackoffMs);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
    return "transport-failure";
  }

  async function flush() {
    flushTimer = null;

    if (queue.length === 0) return;

    // Cooling down after a failed batch: leave the queue in place (it keeps deduping and
    // absorbing new reads) and flush when the cooldown ends, instead of every
    // 100ms window sleeping on its own and then firing separately.
    const now = Date.now();
    if (backoffUntil > now) {
      if (!flushTimer) flushTimer = setTimeout(flush, backoffUntil - now);
      return;
    }

    // Grab the whole queue, then split it so no request exceeds the /api/rpc cap
    // (the queue can legitimately outgrow it while cooling down after an outage).
    const all = queue.splice(0);
    for (const p of all) {
      if (WINDOW_ONLY_DEDUPE_METHODS.has(p.method)) dedupeCache.delete(dedupeKey(p.method, p.params));
    }
    const chunks: PendingRequest[][] = [];
    for (let i = 0; i < all.length; i += chunkSize) chunks.push(all.slice(i, i + chunkSize));

    // Chunks are independent: one failing must not affect the others.
    const outcomes = await Promise.all(chunks.map(sendChunk));

    if (outcomes.includes("ok")) {
      backoffUntil = 0;
      consecutiveFailures = 0;
    } else if (outcomes.includes("transport-failure")) {
      noteBatchFailure();
    }
    // All "rejected" (request-shape 4xx): neither an outage nor a recovery; backoff unchanged.
  }

  /**
   * Stop later identical reads from joining a request that has ALREADY LEFT (or is on the wire).
   * Call after a confirmed transaction: a getBalance issued right after it must not share a
   * response that was sent before the tx landed. Queued-but-unsent reads keep deduping (they
   * have not been sent yet, so they will observe post-tx state anyway).
   */
  function invalidateInflightDedupe() {
    const queued = new Set(queue.map((p) => dedupeKey(p.method, p.params)));
    for (const key of Array.from(dedupeCache.keys())) {
      if (!queued.has(key)) dedupeCache.delete(key);
    }
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, batchWindowMs);
  }

  /**
   * Enqueue a JSON-RPC call for batching.
   * Returns a Promise that resolves with the JSON string of the response.
   */
  function enqueue(method: string, params: unknown): Promise<string> {
    const canDedupe = !UNBATCHABLE_METHODS.has(method);
    const key = dedupeKey(method, params);

    if (canDedupe) {
      const existing = dedupeCache.get(key);
      if (existing) return existing;
    }

    const id = nextId++;
    const promise = new Promise<string>((resolve, reject) => {
      queue.push({ id, method, params, resolve, reject });
    });

    if (canDedupe) {
      dedupeCache.set(key, promise);
      // Window-only methods are removed at flush; everything else when this request settles,
      // so identical reads arriving while it is on the wire join it rather than re-sending.
      if (!WINDOW_ONLY_DEDUPE_METHODS.has(method)) {
        const release = () => {
          if (dedupeCache.get(key) === promise) dedupeCache.delete(key);
        };
        promise.then(release, release);
      }
    }

    // Schedule flush — immediately when the batch is full or the method is
    // latency-critical (tx-submission path, see FAST_FLUSH_METHODS).
    // Bound the queue (it grows while cooling down after an outage): reject the oldest.
    while (queue.length > maxQueueSize) {
      const dropped = queue.shift()!;
      dedupeCache.delete(dedupeKey(dropped.method, dropped.params));
      dropped.reject(new Error("RPC read dropped: request queue full while RPC is unavailable"));
    }

    if (queue.length >= chunkSize || FAST_FLUSH_METHODS.has(method)) {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flush();
    } else {
      scheduleFlush();
    }

    return promise;
  }

  /**
   * `fetchMiddleware` compatible with @solana/web3.js Connection.
   *
   * web3.js calls:
   *   fetchMiddleware(url, options, (modifiedUrl, modifiedOptions) => void)
   *
   * We intercept the request, batch it, and call the callback with a
   * modified fetch function that returns the batched response.
   */
  function fetchMiddleware(
    url: string,
    options: Record<string, unknown>,
    fetch: (url: string, options: Record<string, unknown>) => void
  ): void {
    // Parse the JSON-RPC body to extract method and params
    const body = options.body as string;
    let parsed: { method?: string; params?: unknown };
    try {
      parsed = JSON.parse(body);
    } catch {
      // Can't parse — pass through unmodified
      fetch(url, options);
      return;
    }

    if (!parsed.method) {
      fetch(url, options);
      return;
    }

    // Enqueue for batching, then reconstruct the response
    enqueue(parsed.method, parsed.params ?? []).then((resultJson) => {
      // We need to call the original fetch to satisfy the callback pattern,
      // but we want to return our batched result.
      // Unfortunately, fetchMiddleware expects us to call the callback which
      // then does a real fetch. We can't prevent that.
      //
      // Instead, we'll use the customFetch approach.
      // See createBatchConnection() below.
      fetch(url, options);
    });
  }

  /**
   * Custom fetch function for use with Connection's internal RPC client.
   * This replaces the standard fetch and batches all RPC calls.
   */
  async function batchFetch(
    input: string | Request | URL,
    init?: RequestInit
  ): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    // Only intercept POST requests to our RPC endpoint
    const isRpc = url.endsWith("/api/rpc") || url.includes("/api/rpc?") || url === endpoint;
    const isPost = !init?.method || init.method.toUpperCase() === "POST";

    if (!isRpc || !isPost || !init?.body) {
      return globalThis.fetch(input, init);
    }

    let parsed: { id?: unknown; method?: string; params?: unknown };
    try {
      const bodyStr = typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body as BufferSource);
      parsed = JSON.parse(bodyStr);
    } catch {
      return globalThis.fetch(input, init);
    }

    if (!parsed.method || Array.isArray(parsed)) {
      return globalThis.fetch(input, init);
    }

    // Bypass batching for mutating methods — send directly to avoid id-mismatch
    // errors ("Missing response from batch") when the upstream RPC returns a
    // response with a null or unexpected id for write operations.
    if (UNBATCHABLE_METHODS.has(parsed.method)) {
      return globalThis.fetch(input, init);
    }

    // Preserve the caller's original request id (e.g. jayson sends UUID strings).
    // Our internal batch uses numeric ids, but @solana/web3.js v1 validates
    // that response.id is a string via superstruct — so we must restore it.
    const originalId = parsed.id;
    let resultJson: string;
    try {
      resultJson = await enqueue(parsed.method, parsed.params ?? []);
    } catch (e) {
      // UX WP-10 (RP-1): a transport failure counts toward the connection bar.
      reportRpcOutcome(false);
      throw e;
    }
    const code = rpcErrorCode(resultJson);
    // Only transport-level trouble (rate limit / internal) marks the connection; an ordinary
    // RPC answer, including a program error, is a reachable Solana.
    reportRpcOutcome(code === null || (code !== -32005 && code !== -32603 && code !== 429), code);

    // Replace the internal batch id with the caller's original id
    let finalJson = resultJson;
    if (originalId !== undefined) {
      try {
        const resultObj = JSON.parse(resultJson);
        resultObj.id = originalId;
        finalJson = JSON.stringify(resultObj);
      } catch {
        // If parse fails, return as-is
      }
    }

    return new Response(finalJson, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  return { batchFetch, enqueue, invalidateInflightDedupe };
}

/** Singleton batch RPC instance for the client-side */
let _batchRpc: ReturnType<typeof createBatchRpc> | null = null;

export function getBatchRpc(): ReturnType<typeof createBatchRpc> {
  if (!_batchRpc) {
    if (typeof window === "undefined") {
      throw new Error("getBatchRpc() is only available on the client");
    }
    _batchRpc = createBatchRpc({
      endpoint: new URL("/api/rpc", window.location.origin).toString(),
      // 100ms window (up from 50ms) gives more time for concurrent hook mounts
      // on the trade page to coalesce into fewer batch requests. The wider window
      // reduces the ~6 sequential batch flushes per render cycle to ~3.
      batchWindowMs: 100,
      // 40 slots (up from 30) accommodates the ~40 RPC calls per trade page mount
      // in a single batch when they all arrive within the 100ms window. Must not
      // exceed RPC_MAX_BATCH_SIZE (lib/rpc-limits.ts, shared with app/api/rpc/route.ts);
      // batchRpc also chunks any larger queue to that cap.
      maxBatchSize: RPC_MAX_BATCH_SIZE,
    });
  }
  return _batchRpc;
}

/**
 * Call after a transaction confirms (or the user otherwise changed on-chain state): reads issued
 * from now on will not join an identical request that was sent before the change. No-op when no
 * client batcher exists (server / not yet created).
 */
export function invalidateRpcReadDedupe(): void {
  _batchRpc?.invalidateInflightDedupe();
}
