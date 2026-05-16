import { NextResponse } from "next/server";
import { getWaitlistServiceSupabase } from "@/lib/waitlist/supabase";
import { requireAdminSession } from "@/lib/admin-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/waitlist/stats
 *
 * Comprehensive integrity report for the waitlist + referral system.
 * Designed to answer:
 *   - did the SQL backfill assign a code to every row?
 *   - are codes unique?
 *   - how many signups have / haven't been notified yet?
 *   - what does the wallet/email breakdown look like?
 *   - how many signups arrived via someone's invite link?
 *
 * Service-role reads only — anon path stays revoked. Admin session
 * required.
 */
export async function GET(req: Request) {
  const auth = await requireAdminSession(req);
  if (!auth.ok) return auth.response;

  try {
    const supabase = getWaitlistServiceSupabase();

    // Pull the whole table once. The waitlist is small (low thousands
    // at the upper bound for this product stage) and a single read is
    // far simpler than orchestrating six counts with `head: true` —
    // and lets us derive all the cross-cutting checks from one view.
    const { data: rows, error } = await supabase
      .from("waitlist")
      .select(
        "id, pubkey, email, referral_code, referred_by_code, referral_code_emailed_at, twitter_handle, created_at, tier",
      );
    if (error) {
      console.error("[admin/waitlist/stats] select error", error);
      return NextResponse.json(
        { error: "Failed to read waitlist" },
        { status: 500 },
      );
    }

    type Row = {
      id: string;
      pubkey: string | null;
      email: string | null;
      referral_code: string | null;
      referred_by_code: string | null;
      referral_code_emailed_at: string | null;
      twitter_handle: string | null;
      created_at: string;
      tier: number | null;
    };
    const all = (rows ?? []) as Row[];

    // ── Tier breakdown (A = 0, B = 1, ...) ────────────────────────────
    // Computed from the row data so it stays in sync with whatever the
    // table actually says. tier defaults to 0 in the DB, so pre-migration
    // rows count as A.
    const tierCounts = new Map<number, number>();
    for (const r of all) {
      const t = typeof r.tier === "number" ? r.tier : 0;
      tierCounts.set(t, (tierCounts.get(t) ?? 0) + 1);
    }
    const tierBreakdown = Array.from(tierCounts.entries())
      .sort(([a], [b]) => a - b)
      .map(([tier, count]) => ({
        tier,
        count,
        label: tier >= 0 && tier <= 25 ? String.fromCharCode(65 + tier) : `t${tier}`,
      }));

    // ── Totals + breakdown by signup method ────────────────────────────
    const totalSignups = all.length;
    let walletOnly = 0;
    let emailOnly = 0;
    let walletAndEmail = 0;
    let withTwitter = 0;
    for (const r of all) {
      const hasW = !!r.pubkey;
      const hasE = !!r.email;
      if (hasW && hasE) walletAndEmail++;
      else if (hasW) walletOnly++;
      else if (hasE) emailOnly++;
      if (r.twitter_handle && r.twitter_handle.trim() !== "") withTwitter++;
    }

    // ── Referral code assignment (was the backfill complete?) ──────────
    let withCode = 0;
    let withoutCode = 0;
    const codeSeen = new Map<string, number>();
    const malformedCodes: string[] = [];
    for (const r of all) {
      if (r.referral_code) {
        withCode++;
        codeSeen.set(r.referral_code, (codeSeen.get(r.referral_code) ?? 0) + 1);
        // Crockford base32, 8 chars, uppercase. Catches any drift.
        if (!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(r.referral_code)) {
          malformedCodes.push(r.referral_code);
        }
      } else {
        withoutCode++;
      }
    }
    const distinctCodes = codeSeen.size;
    const duplicateCodes: { code: string; count: number }[] = [];
    for (const [code, count] of codeSeen) {
      if (count > 1) duplicateCodes.push({ code, count });
    }

    // ── Attribution: did this row come in via someone's invite? ───────
    let withReferrer = 0;
    let withoutReferrer = 0;
    const referredByCount = new Map<string, number>();
    const orphanedReferrers: string[] = []; // referred_by_code that isn't anyone's referral_code
    const validCodes = new Set(codeSeen.keys());
    for (const r of all) {
      if (r.referred_by_code) {
        withReferrer++;
        referredByCount.set(
          r.referred_by_code,
          (referredByCount.get(r.referred_by_code) ?? 0) + 1,
        );
        if (!validCodes.has(r.referred_by_code)) {
          orphanedReferrers.push(r.referred_by_code);
        }
      } else {
        withoutReferrer++;
      }
    }
    // Top referrer
    let topReferrer: { code: string; count: number } | null = null;
    for (const [code, count] of referredByCount) {
      if (!topReferrer || count > topReferrer.count) {
        topReferrer = { code, count };
      }
    }

    // ── Email-notification state ───────────────────────────────────────
    let notifiedTotal = 0; // referral_code_emailed_at IS NOT NULL
    let pendingEmailable = 0; // has email AND code AND not yet emailed
    let walletOnlyNoEmail = 0; // no email column — nothing to send to
    for (const r of all) {
      if (r.referral_code_emailed_at) {
        notifiedTotal++;
        continue;
      }
      if (!r.email) {
        walletOnlyNoEmail++;
      } else if (r.referral_code) {
        pendingEmailable++;
      }
    }

    // ── Recency ───────────────────────────────────────────────────────
    const now = Date.now();
    const ms24h = 24 * 60 * 60 * 1000;
    const ms7d = 7 * 24 * 60 * 60 * 1000;
    let last24h = 0;
    let last7d = 0;
    for (const r of all) {
      const t = new Date(r.created_at).getTime();
      if (Number.isFinite(t)) {
        if (now - t <= ms24h) last24h++;
        if (now - t <= ms7d) last7d++;
      }
    }

    // ── Self-referral check (defense-in-depth, app prevents it but
    //    a DB-level CHECK constraint isn't in place yet). ─────────────
    let selfReferrals = 0;
    for (const r of all) {
      if (
        r.referral_code &&
        r.referred_by_code &&
        r.referral_code === r.referred_by_code
      ) {
        selfReferrals++;
      }
    }

    return NextResponse.json({
      totalSignups,
      byMethod: { walletOnly, emailOnly, walletAndEmail, withTwitter },
      codeAssignment: {
        withCode,
        withoutCode,
        distinctCodes,
        duplicateCodes,
        malformedCodes,
      },
      attribution: {
        withReferrer,
        withoutReferrer,
        topReferrer,
        orphanedReferrers,
      },
      emailNotification: {
        notifiedTotal,
        pendingEmailable,
        walletOnlyNoEmail,
      },
      recency: { last24h, last7d },
      tierBreakdown,
      integrity: {
        selfReferrals,
        backfillComplete: withoutCode === 0,
        codesUnique: duplicateCodes.length === 0,
        allCodesValidShape: malformedCodes.length === 0,
        noOrphanedReferrers: orphanedReferrers.length === 0,
      },
    });
  } catch (err) {
    console.error("[admin/waitlist/stats] unexpected", err);
    return NextResponse.json({ error: "Unexpected error" }, { status: 500 });
  }
}
