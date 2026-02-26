import { NextRequest, NextResponse } from "next/server";
import { getRpcEndpoint } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * RPC proxy endpoint — forwards JSON-RPC requests to Helius while keeping the API key server-side.
 * This prevents exposing HELIUS_API_KEY in the client bundle.
 *
 * Supports both single requests and JSON-RPC batch requests (arrays).
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

      // Validate all requests in the batch
      const validRequests: Record<string, unknown>[] = [];
      const errorResponses: Map<number, { jsonrpc: string; error: { code: number; message: string }; id: unknown }> = new Map();

      for (let i = 0; i < body.length; i++) {
        const error = validateRequest(body[i]);
        if (error) {
          errorResponses.set(i, error);
        } else {
          validRequests.push(body[i]);
        }
      }

      // If all requests are invalid, return errors directly
      if (validRequests.length === 0) {
        return NextResponse.json(
          body.map((_: unknown, i: number) => errorResponses.get(i)),
          { status: 400 }
        );
      }

      // Forward valid requests as a batch to Helius
      const response = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validRequests),
      });

      const rpcResults = await response.json();

      // If there were rejected requests, merge error responses back in order
      if (errorResponses.size > 0) {
        // Build a map of id -> result from Helius response
        const resultById = new Map<unknown, unknown>();
        if (Array.isArray(rpcResults)) {
          for (const r of rpcResults) {
            resultById.set(r?.id, r);
          }
        }

        // Reconstruct full response in original order
        const fullResults = body.map((req: Record<string, unknown>, i: number) => {
          const err = errorResponses.get(i);
          if (err) return err;
          return resultById.get(req.id) ?? { jsonrpc: "2.0", error: { code: -32603, message: "Missing response" }, id: req.id };
        });
        return NextResponse.json(fullResults, { status: 200 });
      }

      return NextResponse.json(rpcResults, { status: response.status });
    }

    // --- Single request handling ---
    const error = validateRequest(body);
    if (error) {
      const status = error.error.code === -32601 ? 403 : 400;
      return NextResponse.json(error, { status });
    }

    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
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
