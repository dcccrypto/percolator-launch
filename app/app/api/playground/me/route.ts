/**
 * GET /api/playground/me
 *
 * The signed-in visitor's own referral code for the Account and Security window. It is served only to the
 * Privy login the gate verified (lib/referral-session.ts, shared with GET /api/playground/referrals): the
 * `pg_access` session's `uid` tag must match this request's verified Privy access token
 * (`Authorization: Bearer`). Holding the cookie alone is not enough, so a shared or stale browser never
 * shows someone else's code.
 *
 * `{ ref: null }` otherwise: no Privy token, no session (gate off), a shared team/judge session, a session
 * from before the gate sent the code or the login tag, or a different Privy login. The window then links
 * to percolator.trade/waitlist.
 */
import { NextResponse, type NextRequest } from "next/server";
import { boundReferralCode } from "@/lib/referral-session";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const bound = await boundReferralCode(req);
  const ref = bound.kind === "ok" ? bound.code : null;
  return NextResponse.json({ ref }, { headers: { "Cache-Control": "private, no-store" } });
}
