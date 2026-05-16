import { NextResponse } from "next/server";
import { getWaitlistServiceSupabase } from "@/lib/waitlist/supabase";
import { requireAdminSession } from "@/lib/admin-session";

export const runtime = "nodejs";
// Admin dashboard: always fresh on each visit, no caching. The leaderboard
// is the operator's view of viral attribution and needs to reflect the
// actual current state (e.g. when investigating a sudden spike).
export const dynamic = "force-dynamic";

interface LeaderboardRow {
  referral_code: string | null;
  owner_pubkey: string | null;
  owner_email: string | null;
  twitter_handle: string | null;
  signups_referred: number | string;
  joined_at: string;
  tier: number | null;
}

interface AdminLeaderboardEntry {
  rank: number;
  referralCode: string;
  ownerPubkey: string | null;
  ownerEmail: string | null;
  twitterHandle: string | null;
  signupsReferred: number;
  joinedAt: string;
  tier: number;
}

/**
 * GET /api/admin/waitlist/leaderboard
 *
 * Admin-only. Returns the full referral leaderboard including PII
 * (email, pubkey) for attribution review. Backed by the SECURITY
 * DEFINER `waitlist_referral_leaderboard()` RPC which is itself
 * service-role-only at the DB layer — this route adds the operator-
 * identity check on top.
 *
 * Why this isn't public:
 *  - emails and full pubkeys are PII
 *  - even a sanitised public version creates a competitive surface
 *    (people gaming for visibility) before we want that loop running
 *  - the leaderboard is an operator tool for now, not a user-facing one
 */
export async function GET() {
  const auth = await requireAdminSession();
  if (!auth.ok) return auth.response;

  try {
    const supabase = getWaitlistServiceSupabase();
    const { data, error } = await supabase.rpc("waitlist_referral_leaderboard");
    if (error) {
      console.error("[admin/waitlist/leaderboard] rpc error", error);
      return NextResponse.json({ error: "Failed to load leaderboard" }, { status: 500 });
    }
    if (!Array.isArray(data)) {
      return NextResponse.json({ leaderboard: [] });
    }
    const rows = (data as LeaderboardRow[])
      .filter((r) => {
        const n = typeof r.signups_referred === "string"
          ? Number.parseInt(r.signups_referred, 10)
          : r.signups_referred;
        return r.referral_code && Number.isFinite(n) && n > 0;
      })
      .map((r, i): AdminLeaderboardEntry => {
        const n = typeof r.signups_referred === "string"
          ? Number.parseInt(r.signups_referred, 10)
          : r.signups_referred;
        return {
          rank: i + 1,
          referralCode: r.referral_code as string,
          ownerPubkey: r.owner_pubkey,
          ownerEmail: r.owner_email,
          twitterHandle: r.twitter_handle,
          signupsReferred: Number.isFinite(n) ? Number(n) : 0,
          joinedAt: r.joined_at,
          tier: typeof r.tier === "number" ? r.tier : 0,
        };
      });

    return NextResponse.json({ leaderboard: rows });
  } catch (err) {
    console.error("[admin/waitlist/leaderboard] unexpected", err);
    return NextResponse.json({ error: "Unexpected error" }, { status: 500 });
  }
}
