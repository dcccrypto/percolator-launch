/**
 * Server-side read of ONE market slab owned by the CURRENT wrapper (lib/program-ids via getConfig).
 * Used by the in-app replacements of the retired percolator-api routes (/api/funding/:slab,
 * /api/insurance/:slab): they read the chain directly instead of proxying to a dead service.
 */
import { PublicKey } from "@solana/web3.js";
import { getConfig } from "@/lib/config";
import { getServerConnection } from "@/lib/server-rpc";
import { isWrapperAccount, isUnknownWrapperVersion } from "@/lib/v22/layout";

export type SlabRead =
  | { ok: true; data: Uint8Array }
  /** No account, another program's account, or not a market: the route answers 404. */
  | { ok: false; reason: "not-found" }
  /** RPC trouble: the route answers 503 (retryable). */
  | { ok: false; reason: "rpc" }
  /** v2.2 flag on: a wrapper account of a VERSION this build does not decode. The route answers 422. */
  | { ok: false; reason: "unsupported-layout"; version: number };

export async function readCurrentWrapperSlab(slab: string): Promise<SlabRead> {
  let info;
  try {
    info = await getServerConnection("confirmed").getAccountInfo(new PublicKey(slab));
  } catch {
    return { ok: false, reason: "rpc" };
  }
  if (!info || info.owner.toBase58() !== getConfig().programId) return { ok: false, reason: "not-found" };
  const data = new Uint8Array(info.data);
  if (isUnknownWrapperVersion(data)) return { ok: false, reason: "unsupported-layout", version: new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(8, true) };
  if (!isWrapperAccount(data)) return { ok: false, reason: "not-found" };
  return { ok: true, data };
}
