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

/** The request this signature is for. #2476: without it, one signature is valid
 *  for the same body sent to any endpoint sharing the secret. */
export interface KeeperRequestBinding {
  /** HTTP method, any casing — normalised below. */
  method: string;
  /** Path only: no origin, no query string. */
  path: string;
}

/**
 * The exact string both ends HMAC.
 *
 * Newline-separated rather than dot-separated: a dot can appear in a path, so
 * `"POST./a.b"` and `"POST./a" + ".b"` would be ambiguous under the old
 * delimiter. A newline cannot appear in a method or a URL path.
 */
function signedString(timestamp: string, rawBody: string, b: KeeperRequestBinding): string {
  return [timestamp, b.method.toUpperCase(), b.path, rawBody].join("\n");
}

/**
 * #2476: the signed string now covers the HTTP METHOD and PATH, not just the
 * timestamp and body.
 *
 * Without them a signature is valid for the same body sent to a DIFFERENT
 * endpoint — every route sharing KEEPER_REGISTER_SECRET accepted each other's
 * signatures, so the credential authenticated "someone who knows the secret"
 * rather than "this request". Binding the target makes a captured signature
 * usable only against the endpoint it was issued for.
 *
 * NOT fixed here, and #2476 is right that it remains: there is still no nonce, so
 * a captured signature is replayable against that same endpoint within
 * MAX_SIGNATURE_AGE_MS. A nonce needs a store shared across serverless instances
 * — the same constraint that shaped the keeper-register proof (#2505) — so it is
 * a separate design problem, not a line change.
 *
 * `method` is upper-cased and `path` is taken WITHOUT query or origin, so the two
 * ends cannot disagree over casing or a trailing host.
 */
export function signKeeperRequest(
  secret: string,
  rawBody: string,
  binding: KeeperRequestBinding,
): { timestamp: string; signature: string } {
  const timestamp = Date.now().toString();
  const signature = createHmac("sha256", secret)
    .update(signedString(timestamp, rawBody, binding))
    .digest("hex");
  return { timestamp, signature };
}

/**
 * Verify a signed request. Timing-safe comparison prevents a signature-length/byte
 * timing oracle; the timestamp bound prevents replay of a captured signature.
 */
/**
 * @param allowLegacyUnbound  Accept the pre-#2476 `"<timestamp>.<rawBody>"` form
 *   as well as the bound one.
 *
 *   Set this ONLY where the signer is outside this repo and therefore cannot be
 *   updated in the same commit. It keeps such a hop working across the rollout,
 *   and it is NOT a fix — an unbound signature is still valid for any endpoint
 *   sharing the secret, which is the whole of #2476. Each acceptance is logged so
 *   the transition can actually be finished rather than forgotten; once the logs
 *   go quiet for a caller, drop the flag at that call site.
 */
export function verifyKeeperSignature(
  secret: string,
  timestamp: string | null,
  rawBody: string,
  signature: string | null,
  binding: KeeperRequestBinding,
  allowLegacyUnbound = false,
): boolean {
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_SIGNATURE_AGE_MS) return false;

  const matches = (expected: string): boolean => {
    const aBytes = Buffer.from(signature, "utf8");
    const bBytes = Buffer.from(expected, "utf8");
    return aBytes.length === bBytes.length && timingSafeEqual(aBytes, bBytes);
  };

  const bound = createHmac("sha256", secret)
    .update(signedString(timestamp, rawBody, binding))
    .digest("hex");
  if (matches(bound)) return true;

  if (!allowLegacyUnbound) return false;

  // Pre-#2476 form. Deliberately checked SECOND, so a caller that has migrated is
  // never evaluated against the weaker string.
  const legacy = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  if (matches(legacy)) {
    console.warn(
      "[keeper-hmac] Accepted a LEGACY unbound signature (#2476). The caller has not " +
        `migrated; it is not bound to ${binding.method.toUpperCase()} ${binding.path}. ` +
        "Remove allowLegacyUnbound at this call site once these stop appearing.",
    );
    return true;
  }
  return false;
}
