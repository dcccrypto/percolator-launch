import { PublicKey } from "@solana/web3.js";

/**
 * A signal that aborts after `ms`. `AbortSignal.timeout` where it exists, an
 * AbortController + timer where it does not — returning `undefined` for the
 * older environment would leave the request unbounded again, which is the very
 * failure this guards against.
 */
function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      return AbortSignal.timeout(ms);
    }
    if (typeof AbortController === "function") {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ms);
      // Node keeps the process alive for a pending timer; browsers have no unref.
      (timer as unknown as { unref?: () => void }).unref?.();
      return controller.signal;
    }
  } catch {
    /* fall through: an environment with neither is left unbounded by necessity */
  }
  return undefined;
}

/**
 * The pubkey the playground co-sign backend signs as, from
 * `GET /api/playground/keeper-cosign`.
 *
 * Never throws, never rejects, and never hangs: the request is bounded by
 * `timeoutMs`. The caller uses this to sharpen a check it can still make without it (see `isOracleDelegationApplied`), so an
 * unreachable backend, a non-devnet deployment (403) or an unconfigured keeper
 * (503) must degrade to "unknown" rather than fail a launch that would
 * otherwise succeed.
 */
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
