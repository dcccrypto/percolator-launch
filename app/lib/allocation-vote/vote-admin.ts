/**
 * Admin authentication for the one-click vote start. The ONLY env read on the
 * vote surface lives here.
 *
 *   VOTE_ADMIN_SECRET  server-only, >= 32 chars. Absent/short => the start
 *                      endpoint does not exist (404). Secure inactive default.
 *
 * The secret travels only in the Authorization header (never a URL or query
 * string, never a cookie), is compared in constant time on SHA-256 digests,
 * and is never logged or echoed.
 */
import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

export const MIN_ADMIN_SECRET_LENGTH = 32;

export function readVoteAdminSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const s = env.VOTE_ADMIN_SECRET;
  return typeof s === "string" && s.length >= MIN_ADMIN_SECRET_LENGTH && s.length <= 512 ? s : null;
}

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** true only for `Authorization: Bearer <exact secret>`. */
export function isAdminAuthorized(authorization: string | null, secret: string): boolean {
  if (typeof authorization !== "string" || authorization.length > 600) return false;
  const m = /^Bearer ([\x21-\x7e]+)$/.exec(authorization);
  if (!m) return false;
  return timingSafeEqual(digest(m[1]!), digest(secret));
}
