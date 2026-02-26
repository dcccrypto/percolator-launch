import { NextRequest, NextResponse } from "next/server";
import { getRpcEndpoint } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * RPC proxy endpoint — forwards JSON-RPC requests to Helius while keeping the API key server-side.
 * This prevents exposing HELIUS_API_KEY in the client bundle.
 *
 * Supports both single requests and JSON-RPC batch requests (arrays).
 * Includes response caching for read-only methods to reduce upstream load.
 *
 * Single request:
 *   POST { jsonrpc: "2.0", id: 1, method: "getHealth", params: [] }
 *
 * Batch request:
 *   POST [
 *     { jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [...] },
 *     { jsonrpc: "2.0", id: 2, method: "getBalance", params: [...] },
 *   ]
 */

const RPC_URL = getRpcEndpoint();

/**
 * Allowlist of JSON-RPC methods that may be proxied to Helius.
 * Prevents abuse of the API key for unauthorized operations.
 */
const ALLOWED_RPC_METHODS = new Set([
  // Health & cluster
  "getHealth",
  "getVersion",
  "getSlot",
  "getBlockHeight",
  "getEpochInfo",
  // Account queries
  "getAccountInfo",
  "getMultipleAccounts",
  "getBalance",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getProgramAccounts",
  // Transaction queries
  "getTransaction",
  "getSignaturesForAddress",
  "getSignatureStatuses",
  "getLatestBlockhash",
  "getRecentPrioritizationFees",
  "getFeeForMessage",
  "isBlockhashValid",
  // Misc read
  "getMinimumBalanceForRentExemption",
  "getSupply",
  // Helius DAS API — token metadata resolution (PERC-198)
  "getAsset",
  "getAssetBatch",
]);

/** Maximum number of requests allowed in a single batch */
const MAX_BATCH_SIZE = 40;

/**
 * Methods whose responses can be cached briefly (read-only, non-user-specific).
 * Cache TTL varies by method — slot/blockhash change every ~400ms, account data less often.
 */
const CACHEABLE_METHODS: Record<string, number> = {
  getHealth: 5_000,
  getVersion: 60_000,
  getSlot: 2_000,
  getBlockHeight: 2_000,
  getEpochInfo: 10_000,
  getAccountInfo: 3_000,
  getMultipleAccounts: 3_000,
  getBalance: 3_000,
  getTokenAccountBalance: 3_000,
  getProgramAccounts: 5_000,
  getMinimumBalanceForRentExemption: 60_000,
  getSupply: 10_000,
  getRecentPrioritizationFees: 5_000,
};

/** Simple in-memory cache with TTL */
const cache = new Map<string, { data: unknown; expiresAt: number }>();
const MAX_CACHE_SIZE = 500;

function getCacheKey(method: string, params: unknown): string {
  return `${method}:${JSON.stringify(params ?? [])}`;
}

function getCached(key: string): unknown | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.data;
}

function setCache(key: string, data: unknown, ttlMs: number): void {
  // Evict oldest entries if cache is too large
  if (cache.size >= MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

/** Methods that mutate state — never cache, never deduplicate */
const MUTATING_METHODS = new Set(["sendTransaction", "simulateTransaction"]);

/**
 * In-flight request deduplication — if the same read request is already being
 * fetched upstream, return the same promise instead of sending a duplicate.
 */
const inflightRequests = new Map<string, Promise<unknown>>();

interface JsonRpcRequest {
  jsonrpc: string;
  id: unknown;
  method: string;
  params?: unknown;
}

/** Validate a single JSON-RPC request, return error response or null if valid */
function validateRequest(req: Record<string, unknown>): { jsonrpc: string; error: { code: number; message: string }; id: unknown } | null {
  const method = req?.method;
  if (!method || typeof method !== "string") {
    return {
      jsonrpc: "2.0",
      error: { code: -32600, message: "Invalid request: missing method" },
      id: req?.id ?? null,
    };
  }
  if (!ALLOWED_RPC_METHODS.has(method)) {
    console.warn(`[/api/rpc] Blocked disallowed method: ${method}`);
    return {
      jsonrpc: "2.0",
      error: { code: -32601, message: `Method not allowed: ${method}` },
      id: req?.id ?? null,
    };
  }
  return null;
}

/**
 * Process a single validated JSON-RPC request with caching and deduplication.
 */
async function processSingleRequest(req: JsonRpcRequest): Promise<unknown> {
  const method = req.method;
  const isMutating = MUTATING_METHODS.has(method);
  const ttl = CACHEABLE_METHODS[method];
  const cacheKey = !isMutating ? getCacheKey(method, req.params) : "";

  // Check cache for read-only methods
  if (ttl && !isMutating) {
    const cached = getCached(cacheKey);
    if (cached !== undefined) {
      // Return cached response with the correct request id
      return { ...(cached as Record<string, unknown>), id: req.id };
    }
  }

  // Deduplicate in-flight requests for read-only methods
  if (!isMutating && inflightRequests.has(cacheKey)) {
    const result = await inflightRequests.get(cacheKey)!;
    return { ...(result as Record<string, unknown>), id: req.id };
  }

  const fetchPromise = (async () => {
    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    return await response.json();
  })();

  // Register in-flight for dedup
  if (!isMutating) {
    inflightRequests.set(cacheKey, fetchPromise);
  }

  try {
    const data = await fetchPromise;

    // Cache successful responses
    if (ttl && !isMutating && !data.error) {
      setCache(cacheKey, data, ttl);
    }

    return data;
  } finally {
    inflightRequests.delete(cacheKey);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const isBatch = Array.isArray(body);

    if (isBatch) {
      // --- Batch request handling ---
      if (body.length === 0) {
        return NextResponse.json(
          { jsonrpc: "2.0", error: { code: -32600, message: "Empty batch" }, id: null },
          { status: 400 }
        );
      }

      if (body.length > MAX_BATCH_SIZE) {
        return NextResponse.json(
          { jsonrpc: "2.0", error: { code: -32600, message: `Batch too large (max ${MAX_BATCH_SIZE})` }, id: null },
          { status: 400 }
        );
      }

      // Validate all requests, process valid ones with caching/dedup
      const results = await Promise.all(
        body.map(async (item: Record<string, unknown>) => {
          const error = validateRequest(item);
          if (error) return error;
          return processSingleRequest(item as unknown as JsonRpcRequest);
        })
      );

      return NextResponse.json(results, { status: 200 });
    }

    // --- Single request handling ---
    const error = validateRequest(body);
    if (error) {
      const status = error.error.code === -32601 ? 403 : 400;
      return NextResponse.json(error, { status });
    }

    const result = await processSingleRequest(body as JsonRpcRequest);
    const hasError = (result as Record<string, unknown>).error;
    return NextResponse.json(result, { status: hasError ? 400 : 200 });
  } catch (error) {
    console.error("[/api/rpc] Error:", error);
    return NextResponse.json(
      { jsonrpc: "2.0", error: { code: -32603, message: "Internal RPC proxy error" }, id: null },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json(
    { error: "RPC proxy only accepts POST requests" },
    { status: 405 }
  );
}
