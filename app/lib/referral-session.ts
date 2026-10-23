/**
 * The caller's own referral code, bound to the Privy login the gate verified (server only).
 *
 * Shared by GET /api/playground/referrals (Portfolio > Referrals) and GET /api/playground/me (the Account and
 * Security window), so neither shows a code to whoever merely holds the `pg_access` cookie:
 *   1. the `pg_access` session (HttpOnly, HMAC-signed) carries the code the gate read from the visitor's own
 *      waitlist row, plus `uid`, a keyed tag of the Privy login the gate verified;
 *   2. this request's Privy access token is verified, and its tag must equal the session's `uid`.
 * Anything short of that (no session, a team/judge session, an older session without `uid`, another Privy
 * login) is `unavailable`. The cheap session checks run first, so a request without a usable session never
 * costs a Privy verification.
 */
import type { NextRequest } from "next/server";
import {
  JUDGE_SUB_PREFIX,
  SESSION_COOKIE,
  TEAM_SUB_PREFIX,
  accessSecret,
  constantTimeEqual,
  privyUserTag,
  readSession,
} from "@/lib/playground-access";
import { verifyPrivyAuth } from "@/lib/privy-auth";

export type BoundReferral = { kind: "ok"; code: string } | { kind: "signed-out" } | { kind: "unavailable" };

export async function boundReferralCode(req: NextRequest): Promise<BoundReferral> {
  if (!(req.headers.get("authorization") ?? "").startsWith("Bearer ")) return { kind: "signed-out" };

  const secret = accessSecret();
  if (!secret) return { kind: "unavailable" };
  const claims = await readSession(req.cookies.get(SESSION_COOKIE)?.value, secret);
  if (!claims || claims.sub.startsWith(TEAM_SUB_PREFIX) || claims.sub.startsWith(JUDGE_SUB_PREFIX)) return { kind: "unavailable" };
  if (!claims.ref || !claims.uid) return { kind: "unavailable" };

  const auth = await verifyPrivyAuth(req);
  if (!auth.ok) return auth.status === 401 ? { kind: "signed-out" } : { kind: "unavailable" };
  if (!constantTimeEqual(await privyUserTag(auth.userId, secret), claims.uid)) return { kind: "unavailable" };
  return { kind: "ok", code: claims.ref };
}
