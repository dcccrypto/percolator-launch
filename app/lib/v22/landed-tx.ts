/**
 * Shared per-signature landed-transaction reader. After an order lands the ticket reads the same signature twice (the effective fill
 * price, readExecFill, and the clipped-fill statement, readClippedFill). Each used to run its own getTransaction retry loop, so one
 * order cost up to 8 reads on the rate-limited devnet RPC. Readers that start while a read of the same (connection, signature, tries)
 * is in flight now share that one retry loop. The memo lives only while the read is in flight: nothing is cached afterwards, so a
 * later reader always sees fresh chain state, and a single reader keeps the exact retry count and 700 ms sleeps.
 */
import type { Connection, VersionedTransactionResponse } from "@solana/web3.js";

export type LandedTx = VersionedTransactionResponse;

const inflight = new WeakMap<object, Map<string, Promise<LandedTx | null>>>();

async function fetchLoop(
  connection: Pick<Connection, "getTransaction">,
  sig: string,
  sleep: (ms: number) => Promise<void>,
  tries: number,
): Promise<LandedTx | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const tx = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (tx?.meta) return tx;
    } catch { /* retry */ }
    if (i < tries - 1) await sleep(700);
  }
  return null;
}

/**
 * The landed transaction (with meta) or null after `tries` attempts. Concurrent calls for the same signature share one fetch loop;
 * a caller that joins late uses the first caller's `sleep` and gets only the tries that loop has left.
 */
export function readLandedTx(
  connection: Pick<Connection, "getTransaction">,
  sig: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  tries = 4,
): Promise<LandedTx | null> {
  let byKey = inflight.get(connection);
  if (!byKey) inflight.set(connection, (byKey = new Map()));
  const key = `${sig}|${tries}`;
  const hit = byKey.get(key);
  if (hit) return hit;
  const m = byKey;
  const p = fetchLoop(connection, sig, sleep, tries).finally(() => { m.delete(key); });
  m.set(key, p);
  return p;
}
