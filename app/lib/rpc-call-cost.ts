/**
 * S3-C4: the /api/rpc per-IP limit counts JSON-RPC CALLS, not HTTP requests.
 * A batch of N entries costs N units, so batching can no longer multiply the
 * per-IP budget by the batch size (previously up to 40x).
 * Anything that is not a non-empty array costs 1 (a single call or a malformed body).
 */
export function rpcCallCost(body: unknown): number {
  if (Array.isArray(body) && body.length > 0) return body.length;
  return 1;
}
