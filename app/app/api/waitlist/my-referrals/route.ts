import { NextResponse } from "next/server";
import { getWaitlistServiceSupabase } from "@/lib/waitlist/supabase";
import { isValidReferralCodeShape } from "@/lib/waitlist/referralCode";

export const runtime = "nodejs";
// Short cache — users will be refreshing this after sharing to watch
// the count tick up. 15s balances "feels live" with "doesn't melt the
// DB if a thousand people open the page".
export const revalidate = 15;

/**
 * GET /api/waitlist/my-referrals?code=AB23XYZ9
 *
 * Returns { count: number } — the number of waitlist signups that listed
 * this referral_code as their referred_by_code.
 *
 * Public by design: referral codes are publicly shared (that's the
 * entire point), and the only signal exposed here is a count of how
 * many people used a given code. No PII, no membership oracle on
 * arbitrary identifiers — just a count keyed on a value the holder
 * has already broadcast.
 *
 * Failure mode is { count: 0 } rather than 500 so the ReferralCard
 * can degrade silently if the API is briefly unavailable.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = url.searchParams.get("code");
  if (!raw) {
    return NextResponse.json({ count: 0, reason: "missing" }, { status: 400 });
  }
  const code = raw.trim().toUpperCase();
  if (!isValidReferralCodeShape(code)) {
    return NextResponse.json({ count: 0, reason: "shape" });
  }
  try {
    const supabase = getWaitlistServiceSupabase();
    const { count, error } = await supabase
      .from("waitlist")
      .select("id", { count: "exact", head: true })
      .eq("referred_by_code", code);
    if (error) {
      console.error("[my-referrals] query error", error);
      return NextResponse.json({ count: 0, reason: "query" });
    }
    return NextResponse.json({ count: count ?? 0 });
  } catch (err) {
    console.error("[my-referrals] unexpected", err);
    return NextResponse.json({ count: 0, reason: "unexpected" });
  }
}
