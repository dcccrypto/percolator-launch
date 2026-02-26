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
  } = config;

  let queue: PendingRequest[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let nextId = 1;
  let backoffUntil = 0;

  /** Cache for deduplication within the current batch window */
  const dedupeCache = new Map<string, Promise<string>>();

  function dedupeKey(method: string, params: unknown): string {
    return `${method}:${JSON.stringify(params)}`;
  }

  async function flush() {
    flushTimer = null;

    if (queue.length === 0) return;

    // Grab the current batch
    const batch = queue.splice(0);
    dedupeCache.clear();

    // Wait for backoff if needed
    const now = Date.now();
    if (backoffUntil > now) {
      await new Promise((r) => setTimeout(r, backoffUntil - now));
    }

    // Build the JSON-RPC batch payload
    const payload = batch.map((p) => ({
      jsonrpc: "2.0",
      id: p.id,
      method: p.method,
      params: p.params,
    }));

    let attempt = 0;
    let currentBackoff = initialBackoffMs;

    while (attempt <= maxRetries) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
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
            backoffUntil = Date.now() + currentBackoff;
            return;
          }
          const retryAfter = response.headers.get("Retry-After");
          const retryMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : currentBackoff;
          const jitter = Math.random() * 0.3 * retryMs;
          await new Promise((r) => setTimeout(r, retryMs + jitter));
          currentBackoff = Math.min(currentBackoff * 2, maxBackoffMs);
          continue;
        }

        // Reset backoff on success
        backoffUntil = 0;

        const results = await response.json();

        if (Array.isArray(results)) {
          // Map results back by id
          const resultById = new Map<number, unknown>();
          for (const r of results) {
            if (r && r.id != null) {
              resultById.set(r.id, r);
            }
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
        return;
      } catch (error) {
        attempt++;
        if (attempt > maxRetries) {
          for (const p of batch) {
            p.reject(error instanceof Error ? error : new Error(String(error)));
          }
          return;
        }
        const jitter = Math.random() * 0.3 * currentBackoff;
        await new Promise((r) => setTimeout(r, currentBackoff + jitter));
        currentBackoff = Math.min(currentBackoff * 2, maxBackoffMs);
      }
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
    const key = dedupeKey(method, params);
    const existing = dedupeCache.get(key);
    if (existing) return existing;

    const id = nextId++;
    const promise = new Promise<string>((resolve, reject) => {
      queue.push({ id, method, params, resolve, reject });
    });

    dedupeCache.set(key, promise);

    // Schedule flush, or flush immediately if batch is full
    if (queue.length >= maxBatchSize) {
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

    let parsed: { method?: string; params?: unknown };
    try {
      const bodyStr = typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body as BufferSource);
      parsed = JSON.parse(bodyStr);
    } catch {
      return globalThis.fetch(input, init);
    }

    if (!parsed.method || Array.isArray(parsed)) {
      return globalThis.fetch(input, init);
    }

    const resultJson = await enqueue(parsed.method, parsed.params ?? []);

    return new Response(resultJson, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  return { batchFetch, enqueue };
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
      batchWindowMs: 50,
      maxBatchSize: 30,
    });
  }
  return _batchRpc;
}
