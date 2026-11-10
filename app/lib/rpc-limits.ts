/**
 * Limits shared by the /api/rpc route (server) and the batching client (batchRpc.ts).
 * Dependency-free on purpose so the client bundle can import it without pulling in
 * any server-only code.
 */

/**
 * Maximum number of JSON-RPC calls /api/rpc accepts in one batch request. A larger
 * array is rejected with HTTP 400 "Batch too large". The client must never send more.
 * The route enforces no separate body-size limit, so count is the only cap.
 */
export const RPC_MAX_BATCH_SIZE = 40;
