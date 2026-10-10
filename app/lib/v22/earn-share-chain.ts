/**
 * Chain reads for the Earn share endpoints. SERVER-ONLY (takes a server Connection). Two accounts per market: the LP vault registry PDA
 * (`["lp_vault", market]` under the wrapper: it must exist and be owned by the wrapper, which is what makes a market parameter a market) and
 * the Metaplex record of the share mint (read-only data, trusted only through {@link shareIdentityFromChain}).
 */
import type { Connection, PublicKey } from "@solana/web3.js";
import { deriveInsuranceLpMint, deriveLpVaultRegistry } from "@percolatorct/sdk";
import { METAPLEX_TOKEN_METADATA_PROGRAM_ID_V22, deriveLpShareMetadataPdaV22, parseLpShareMetadataRecordV22, type LpShareMetadataRecordV22 } from "./sdk";

export type EarnShareChainState =
  | { kind: "none" }
  | { kind: "ok"; registry: PublicKey; mint: PublicKey; record: LpShareMetadataRecordV22 | null };

const TTL_MS = 60_000;
const MAX_ENTRIES = 500;
const cache = new Map<string, { at: number; v: EarnShareChainState }>();

/** Test seam. */
export function __clearEarnShareCacheForTest(): void {
  cache.clear();
}

/**
 * @throws on an RPC failure (the route answers 503 and caches nothing). Absence is `{ kind: "none" }`, never an error.
 */
export async function loadEarnShareChainState(connection: Pick<Connection, "getMultipleAccountsInfo">, programId: PublicKey, market: PublicKey): Promise<EarnShareChainState> {
  const key = `${programId.toBase58()}:${market.toBase58()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v;
  const [registry] = deriveLpVaultRegistry(programId, market);
  const [mint] = deriveInsuranceLpMint(programId, market);
  const [meta] = deriveLpShareMetadataPdaV22(mint);
  const [reg, rec] = await connection.getMultipleAccountsInfo([registry, meta]);
  let v: EarnShareChainState;
  if (!reg || !reg.owner.equals(programId)) {
    v = { kind: "none" };
  } else {
    const record = rec && rec.owner.equals(METAPLEX_TOKEN_METADATA_PROGRAM_ID_V22) ? parseLpShareMetadataRecordV22(rec.data) : null;
    v = { kind: "ok", registry, mint, record };
  }
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), v });
  return v;
}
