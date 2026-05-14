import { NextResponse } from "next/server";
import { getWaitlistSupabase } from "@/lib/waitlist/supabase";
import { isValidReferralCodeShape } from "@/lib/waitlist/referralCode";

export const runtime = "nodejs";

/**
 * GET /api/waitlist/check-code?code=AB23XYZ9
 *
 * Returns { valid: boolean }. The waitlist signup UI calls this on a
 * debounced input change so the user gets a green/red signal before
 * going through Privy OTP or wallet sign — without the round trip
 * they'd get a generic 400 only after submitting.
 *
 * Posture:
 *   • Shape pre-filter rejects garbage without burning a Supabase RPC
 *     call. The Crockford alphabet plus 8-char length means inputs
 *     that aren't even plausible (lowercase, wrong length, contains
 *     I/L/O/U) never reach the database.
 *   • Existence check goes through the SECURITY DEFINER RPC
 *     `waitlist_referral_code_exists(text)` which returns a boolean
 *     only — never returns the row, the owner, or any other field.
 *   • The endpoint is anon-callable. Brute-force enumeration is
 *     impractical (32^8 ≈ 1.1 trillion combinations) and Resend/
 *     Privy aren't reachable without a separately validated signup,
 *     so the worst an attacker can do here is learn that a specific
 *     8-char string is a real code — which is the same info anyone
 *     with the code already has.
 *   • Fail-closed: any RPC error returns valid:false. Better to
 *     under-validate a real code than to over-validate a fake one.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = url.searchParams.get("code");
  if (!raw) {
    return NextResponse.json({ valid: false, reason: "missing" }, { status: 400 });
  }
  const code = raw.trim().toUpperCase();
  if (!isValidReferralCodeShape(code)) {
    return NextResponse.json({ valid: false, reason: "shape" });
  }
  try {
    const supabase = getWaitlistSupabase();
    const { data, error } = await supabase.rpc(
      "waitlist_referral_code_exists",
      { p_code: code },
    );
    if (error) {
      console.error("[check-code] rpc error", error);
      return NextResponse.json({ valid: false, reason: "rpc" });
    }
    return NextResponse.json({ valid: data === true });
  } catch (err) {
    console.error("[check-code] unexpected", err);
    return NextResponse.json({ valid: false, reason: "unexpected" });
  }
}
