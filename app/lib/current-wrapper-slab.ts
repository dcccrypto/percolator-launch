/**
 * Server-side read of ONE market slab owned by the CURRENT wrapper (lib/program-ids via getConfig).
 * Used by the in-app replacements of the retired percolator-api routes (/api/funding/:slab,
 * /api/insurance/:slab): they read the chain directly instead of proxying to a dead service.
 */
import { isAcceptedWrapper } from "@/lib/v21/worlds";
import { PublicKey } from "@solana/web3.js";
import { isV17Account } from "@percolatorct/sdk";
import { getServerConnection } from "@/lib/server-rpc";

export type SlabRead =
  | { ok: true; data: Uint8Array }
  /** No account, another program's account, or not a market: the route answers 404. */
  | { ok: false; reason: "not-found" }
  /** RPC trouble: the route answers 503 (retryable). */
  | { ok: false; reason: "rpc" };

export async function readCurrentWrapperSlab(slab: string): Promise<SlabRead> {
  let info;
  try {
    info = await getServerConnection("confirmed").getAccountInfo(new PublicKey(slab));
  } catch {
    return { ok: false, reason: "rpc" };
  }
  if (!info || !isAcceptedWrapper(info.owner.toBase58())) return { ok: false, reason: "not-found" };
  const data = new Uint8Array(info.data);
  if (!isV17Account(data)) return { ok: false, reason: "not-found" };
  return { ok: true, data };
}
