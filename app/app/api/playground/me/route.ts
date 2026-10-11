/**
 * GET /api/playground/me
 *
 * The signed-in visitor's own referral code, read from their `pg_access` session (the gate on
 * percolator.trade puts it in the handoff, /enter carries it into the session). The playground has
 * no waitlist DB access; this is the only place the code reaches it. HttpOnly cookie, so the
 * client can't read it itself.
 *
 * `{ ref: null }` when there's no session (gate off, team bypass) or the session predates the
 * gate sending the code; the Account and Security window then links to percolator.trade/waitlist.
 */
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, TEAM_SUB_PREFIX, accessSecret, readSession } from "@/lib/playground-access";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const secret = accessSecret();
  const claims = secret ? await readSession(req.cookies.get(SESSION_COOKIE)?.value, secret) : null;
  const ref = claims && !claims.sub.startsWith(TEAM_SUB_PREFIX) ? (claims.ref ?? null) : null;
  return NextResponse.json({ ref }, { headers: { "Cache-Control": "private, no-store" } });
}
