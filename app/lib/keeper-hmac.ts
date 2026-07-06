/**
 * LAUNCH-16: Shared HMAC-SHA256 request signing for keeper-service auth.
 *
 * Replaces plaintext KEEPER_REGISTER_SECRET forwarding (a raw shared-secret header)
 * with HMAC-SHA256("<timestamp>.<rawBody>", secret) — the credential itself never
 * appears on the wire, only a signature derived from it. Used by every call site
 * that authenticates to the keeper service (or, for the markets -> oracle-keeper
 * internal hop, to another route in this same app) using KEEPER_REGISTER_SECRET.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Reject signatures older than this — bounds the replay window. */
const MAX_SIGNATURE_AGE_MS = 5 * 60_000;

export function signKeeperRequest(
  secret: string,
  rawBody: string,
): { timestamp: string; signature: string } {
  const timestamp = Date.now().toString();
  const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return { timestamp, signature };
}

/**
 * Verify a signed request. Timing-safe comparison prevents a signature-length/byte
 * timing oracle; the timestamp bound prevents replay of a captured signature.
 */
export function verifyKeeperSignature(
  secret: string,
  timestamp: string | null,
  rawBody: string,
  signature: string | null,
): boolean {
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_SIGNATURE_AGE_MS) return false;

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const aBytes = Buffer.from(signature, "utf8");
  const bBytes = Buffer.from(expected, "utf8");
  return aBytes.length === bBytes.length && timingSafeEqual(aBytes, bBytes);
}
