import { PublicKey } from "@solana/web3.js";

/**
 * The pubkey the playground co-sign backend signs as, from
 * `GET /api/playground/keeper-cosign`.
 *
 * Never throws and never rejects. The caller uses this to sharpen a check it
 * can still make without it (see `isOracleDelegationApplied`), so an
 * unreachable backend, a non-devnet deployment (403) or an unconfigured keeper
 * (503) must degrade to "unknown" rather than fail a launch that would
 * otherwise succeed.
 */
export async function fetchKeeperCosignPubkey(
  fetchImpl: typeof fetch = fetch,
): Promise<PublicKey | null> {
  try {
    const res = await fetchImpl("/api/playground/keeper-cosign", { method: "GET" });
    if (!res.ok) return null;
    const body = (await res.json()) as { keeperPubkey?: unknown };
    if (typeof body.keeperPubkey !== "string") return null;
    return new PublicKey(body.keeperPubkey);
  } catch {
    return null;
  }
}
