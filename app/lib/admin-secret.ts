import { timingSafeEqual, createHash } from "node:crypto";
import type { NextRequest } from "next/server";

/**
 * Timing-safe `x-admin-secret` check for maintainer-only routes.
 *
 * Fixes two issues the previous inline checks shared:
 *  1. Length leak — `a.length === b.length && timingSafeEqual(a, b)` short-circuits
 *     on a length mismatch, so response timing revealed the secret's length. Both
 *     sides are now hashed to a fixed 32 bytes before the compare (mirrors
 *     lib/api-auth `checkInternalSecret`), so the compare is constant-shape.
 *  2. Single shared secret — one `ADMIN_API_SECRET` gated every admin action, so one
 *     leaked secret granted all of them. Callers pass a `capability`; the check uses
 *     `ADMIN_<CAPABILITY>_SECRET` when set, falling back to `ADMIN_API_SECRET`.
 *     Deployments can therefore set distinct per-capability secrets to separate the
 *     blast radius, with no behavior change when only `ADMIN_API_SECRET` is set.
 *
 * Empty/unset resolved secret always denies (fail closed).
 */
export function checkAdminSecret(req: NextRequest, capability?: string): boolean {
  const perCapability = capability
    ? (process.env[`ADMIN_${capability.toUpperCase()}_SECRET`] ?? "").trim()
    : "";
  const secret = perCapability || (process.env.ADMIN_API_SECRET ?? "").trim();
  if (!secret) return false;

  const provided = req.headers.get("x-admin-secret") ?? "";
  // Hash both to a fixed 32 bytes so timingSafeEqual never sees unequal lengths.
  const expected = createHash("sha256").update(secret).digest();
  const got = createHash("sha256").update(provided).digest();
  return timingSafeEqual(expected, got);
}
