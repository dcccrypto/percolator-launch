import { PublicKey } from "@solana/web3.js";

/**
 * The pubkey the playground co-sign backend signs as, from
 * `GET /api/playground/keeper-cosign`.
 *
 * Never throws, never rejects, and never hangs: the request is bounded by
 * `timeoutMs`. The caller uses this to sharpen a check it
 * can still make without it (see `isOracleDelegationApplied`), so an
 * unreachable backend, a non-devnet deployment (403) or an unconfigured keeper
 * (503) must degrade to "unknown" rather than fail a launch that would
 * otherwise succeed.
 */
function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(ms)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchKeeperCosignPubkey(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5_000,
): Promise<PublicKey | null> {
  try {
    const res = await fetchImpl("/api/playground/keeper-cosign", {
      method: "GET",
      // Bounded: this GET sharpens a check the caller can make without it, so a
      // server that accepts the connection and never answers must reach the null
      // fallback. Unbounded, the awaited call would hold step 1 open and the
      // launch could never finish - a worse failure than the one it prevents.
      signal: timeoutSignal(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { keeperPubkey?: unknown };
    if (typeof body.keeperPubkey !== "string") return null;
    return new PublicKey(body.keeperPubkey);
  } catch {
    return null;
  }
}
