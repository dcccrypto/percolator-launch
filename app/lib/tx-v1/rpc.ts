/**
 * v1 send/simulate transport for the app, so a FORMAT rejection reaches `isTxV1FormatRejection` with its
 * JSON-RPC code and nothing else ever does.
 *
 * Why not the SDK defaults:
 *  - `sendV1(connection, wire)` without options goes through `connection.sendRawTransaction`. web3.js 1.99
 *    turns a JSON-RPC error there into a `SendTransactionError` that keeps only the MESSAGE (no `.code`), so
 *    the code-based classifier (`isTxV1FormatRejection`, SDK-3) can never see a -32602/-32015 and a v1 format
 *    rejection would surface as a hard error instead of the safe pre-acceptance fallback.
 *  - Passing `fetchImpl` selects the SDK's raw JSON-RPC path, which throws `V1RpcError` carrying the node's
 *    code. On the client the Connection's endpoint is the app's `/api/rpc` proxy, and the app's batching
 *    fetch sends `sendTransaction`/`simulateTransaction` straight to `globalThis.fetch` anyway
 *    (lib/batchRpc.ts UNBATCHABLE_METHODS), so this is the same transport the Connection would use.
 *
 * What classifies as a format rejection (fallback allowed, nothing was accepted):
 *  - a JSON-RPC error object whose code is -32602 (invalid params: undecodable / too large / sanitize) or
 *    -32015 (version not supported), relayed by the proxy from the node.
 * What never does:
 *  - fetch/network failures (`TypeError: Failed to fetch`, aborts), non-JSON bodies, proxy errors
 *    (-32600 forbidden, -32005 rate limit, -32603 "Upstream RPC request failed"), program errors (-32002),
 *    and any error whose TEXT merely mentions a code or "not supported": text is never classified.
 */
import type { Connection } from "@solana/web3.js";
import {
  V1RpcError,
  isTxV1FormatRejection,
  sendV1 as sdkSendV1,
  simulateV1 as sdkSimulateV1,
  type V1SimulationResult,
} from "@/lib/v21/sdk";

/** Error for a transport failure (no JSON-RPC answer). Deliberately has no numeric `code`. */
export class V1TransportError extends Error {
  constructor(method: string, cause: unknown) {
    super(`RPC ${method} transport failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause: stripCode(cause) });
    this.name = "V1TransportError";
  }
}

/** A cause that cannot leak a numeric code into the classifier's `.cause` walk. */
function stripCode(e: unknown): unknown {
  if (e instanceof Error) return new Error(e.message);
  return typeof e === "string" ? e : String(e);
}

type FetchLike = typeof fetch;

/** `globalThis.fetch`, called unbound-safe (some browsers throw "Illegal invocation" on a detached fetch). */
const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

async function run<R>(method: string, f: () => Promise<R>): Promise<R> {
  try {
    return await f();
  } catch (e) {
    // A JSON-RPC answer keeps its code (only these may classify); anything else is a transport failure.
    if (e instanceof V1RpcError) throw e;
    throw new V1TransportError(method, e);
  }
}

/**
 * Send signed v1 wire bytes through the app's RPC endpoint (preflight on, `confirmed`).
 *
 * @throws V1RpcError on a JSON-RPC error (code preserved); V1TransportError on anything else.
 */
export async function sendV1ViaProxy(connection: Connection, wire: Uint8Array, fetchImpl: FetchLike = defaultFetch): Promise<string> {
  const sig: unknown = await run("sendTransaction", () => sdkSendV1(connection, wire, { fetchImpl, skipPreflight: false, preflightCommitment: "confirmed" }));
  // No signature and no JSON-RPC error: we cannot tell whether the node accepted it, so it is a transport
  // failure (never a format rejection, never a fallback).
  if (typeof sig !== "string" || sig.length === 0) throw new V1TransportError("sendTransaction", new Error("response carried no signature"));
  return sig;
}

/**
 * Simulate v1 wire bytes through the app's RPC endpoint (read-only).
 *
 * @throws V1RpcError on a JSON-RPC error (code preserved); V1TransportError on anything else.
 */
export function simulateV1ViaProxy(connection: Connection, wire: Uint8Array, fetchImpl: FetchLike = defaultFetch): Promise<V1SimulationResult> {
  return run("simulateTransaction", () => sdkSimulateV1(connection, wire, { fetchImpl }));
}

/** Re-exported so callers classify with the same function the transport is built for. */
export { V1RpcError, isTxV1FormatRejection };
