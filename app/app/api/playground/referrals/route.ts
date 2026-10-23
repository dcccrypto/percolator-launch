/**
 * GET /api/playground/referrals — the caller's own referral link and how many people joined with it.
 *
 * The code is served only to the Privy login the gate verified (lib/referral-session.ts: the `pg_access`
 * session's `uid` tag must match this request's verified Privy token). Anything short of that answers
 * `unavailable` and the tab links to the gate's playground page to enter again.
 *
 * The joined count comes from lib/referral-count.ts (the waitlist's public count endpoint, cached per
 * code). A failed read is `joined: null`, never an error and never 0.
 */
import { NextResponse, type NextRequest } from "next/server";
import { boundReferralCode } from "@/lib/referral-session";
import { referralJoinedCount } from "@/lib/referral-count";
import { referralLink, waitlistOrigin, type ReferralsResponse } from "@/lib/referrals";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

function reply(body: ReferralsResponse): NextResponse {
  return NextResponse.json(body, { headers: NO_STORE });
}

export async function GET(req: NextRequest) {
  const origin = waitlistOrigin();
  const bound = await boundReferralCode(req);
  if (bound.kind === "signed-out") return reply({ status: "signed-out" });
  if (bound.kind === "unavailable") return reply({ status: "unavailable", enterUrl: `${origin}/playground` });
  return reply({
    status: "ok",
    code: bound.code,
    link: referralLink(bound.code, origin),
    joined: await referralJoinedCount(bound.code, origin),
  });
}
