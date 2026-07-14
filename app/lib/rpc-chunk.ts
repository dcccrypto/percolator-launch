import type { AccountInfo, Commitment, Connection, GetMultipleAccountsConfig, PublicKey } from "@solana/web3.js";

/**
 * Solana's `getMultipleAccounts` JSON-RPC method caps out at 100 pubkeys per
 * call — and `@solana/web3.js`'s `Connection.getMultipleAccountsInfo` does
 * **not** chunk internally, it just forwards whatever array you give it. Call
 * it with 101+ keys and the RPC node throws (`Too many inputs provided...`),
 * which surfaces as a hard failure for the *entire* batch — e.g. one extra
 * registered market/pool bricking every LP position on the page, or every
 * stake pool 500ing the /stake route.
 *
 * This module is the ONE place that knows the 100-key cap. Every call site
 * that builds an unbounded-length key array (curated ∪ user-registered
 * markets, all stake pools, etc.) should go through
 * `getMultipleAccountsInfoChunked` instead of calling
 * `connection.getMultipleAccountsInfo` directly.
 */
export const MAX_ACCOUNTS_PER_RPC_CALL = 100;

/**
 * Chunked drop-in replacement for `connection.getMultipleAccountsInfo`.
 * Slices `keys` into batches of at most `MAX_ACCOUNTS_PER_RPC_CALL`, fetches
 * every batch in parallel, and concatenates the results — the returned array
 * is index-aligned 1:1 with `keys`, exactly like the underlying RPC call.
 *
 * Empty input short-circuits to `[]` without a network round-trip.
 */
export async function getMultipleAccountsInfoChunked(
  connection: Connection,
  keys: PublicKey[],
  commitmentOrConfig?: Commitment | GetMultipleAccountsConfig,
): Promise<(AccountInfo<Buffer> | null)[]> {
  if (keys.length === 0) return [];
  if (keys.length <= MAX_ACCOUNTS_PER_RPC_CALL) {
    return connection.getMultipleAccountsInfo(keys, commitmentOrConfig);
  }

  const chunks: PublicKey[][] = [];
  for (let i = 0; i < keys.length; i += MAX_ACCOUNTS_PER_RPC_CALL) {
    chunks.push(keys.slice(i, i + MAX_ACCOUNTS_PER_RPC_CALL));
  }
  const results = await Promise.all(
    chunks.map((chunk) => connection.getMultipleAccountsInfo(chunk, commitmentOrConfig)),
  );
  return results.flat();
}
