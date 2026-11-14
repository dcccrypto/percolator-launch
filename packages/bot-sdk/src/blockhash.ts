/**
 * Blockhash expiry. A built transaction carries a recent blockhash and can land only until `lastValidBlockHeight` (the build
 * response says which). The SDK never sends, so YOU decide when a built transaction is too old to send.
 *
 * Pattern: build, sign, check `isExpiring` right before sending, and if it is (or `waitForTx` says `expired`) build AGAIN with
 * a NEW Idempotency-Key. Reusing the key would return the same old bytes (the API replays a key for 120 s), with the same
 * dead blockhash. Never re-send an expired transaction.
 *
 *   let built = await client.buildOrder(req);
 *   // ... sign ...
 *   const { blockHeight } = await client.health();
 *   if (isExpiring(built.lastValidBlockHeight, blockHeight)) built = await client.buildOrder(req, { idempotencyKey: newIdempotencyKey() });
 */

/** Blocks of headroom the default `margin` keeps: about 8 s at 400 ms per slot, enough to sign and send. */
export const DEFAULT_EXPIRY_MARGIN = 20;

/**
 * true when the transaction can no longer be relied on to land: the cluster's block height is within `margin` blocks of
 * `lastValidBlockHeight`, or already past it. A height that is not a finite number counts as expiring (rebuild, never guess).
 */
export function isExpiring(lastValidBlockHeight: number, currentBlockHeight: number, margin: number = DEFAULT_EXPIRY_MARGIN): boolean {
  if (!Number.isFinite(lastValidBlockHeight) || !Number.isFinite(currentBlockHeight) || !Number.isFinite(margin)) return true;
  return currentBlockHeight + Math.max(0, margin) >= lastValidBlockHeight;
}
