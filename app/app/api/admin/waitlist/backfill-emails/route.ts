import { NextResponse } from "next/server";
import { Resend } from "resend";
import { getWaitlistServiceSupabase } from "@/lib/waitlist/supabase";
import { requireAdminSession } from "@/lib/admin-session";
import { renderReferralCodeEmail } from "@/lib/waitlist/email-template";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Each request sends a bounded batch so a single click can't trip the
// function timeout. The UI loops on `remaining > 0`.
export const maxDuration = 60;

const FROM = "Percolator <waitlist@percolator.trade>";
const BATCH_SIZE = 80;
const SEND_DELAY_MS = 250;

interface Row {
  id: string;
  email: string;
  referral_code: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * GET — return the pending count without sending anything.
 * The admin UI uses this to decide whether to show the "Send emails" button.
 */
export async function GET(req: Request) {
  const auth = await requireAdminSession(req);
  if (!auth.ok) return auth.response;
  try {
    const supabase = getWaitlistServiceSupabase();
    const { count, error } = await supabase
      .from("waitlist")
      .select("id", { count: "exact", head: true })
      .not("email", "is", null)
      .not("referral_code", "is", null)
      .is("referral_code_emailed_at", null);
    if (error) {
      console.error("[backfill-emails GET] count error", error);
      return NextResponse.json({ pending: 0 });
    }
    return NextResponse.json({ pending: count ?? 0 });
  } catch (err) {
    console.error("[backfill-emails GET] unexpected", err);
    return NextResponse.json({ pending: 0 });
  }
}

/**
 * POST — send one batch (up to BATCH_SIZE rows) of referral-code emails.
 *
 * Returns:
 *   { processed, sent, failed, updateFailed, remaining }
 *
 * The UI loops on `remaining > 0` and stops on `updateFailed > 0`
 * (mirroring the CLI script's "DO NOT RE-RUN until flags are
 * reconciled" guard — a row that was sent but couldn't be flagged
 * as sent would get a second email on the next batch).
 *
 * Idempotent at the row level: the SELECT filters out
 * `referral_code_emailed_at IS NOT NULL` so already-emailed users
 * are never re-sent.
 */
export async function POST(req: Request) {
  const auth = await requireAdminSession(req);
  if (!auth.ok) return auth.response;

  const resendKey = process.env.RESEND_API_KEY?.trim();
  if (!resendKey) {
    return NextResponse.json(
      { error: "RESEND_API_KEY not configured" },
      { status: 503 },
    );
  }
  const resend = new Resend(resendKey);

  try {
    const supabase = getWaitlistServiceSupabase();
    const { data, error } = await supabase
      .from("waitlist")
      .select("id, email, referral_code")
      .not("email", "is", null)
      .not("referral_code", "is", null)
      .is("referral_code_emailed_at", null)
      .limit(BATCH_SIZE);

    if (error) {
      console.error("[backfill-emails POST] select error", error);
      return NextResponse.json({ error: "select failed" }, { status: 500 });
    }

    const rows = (data ?? []) as Row[];
    let sent = 0;
    let failed = 0;
    let updateFailed = 0;

    for (const row of rows) {
      try {
        const { html, text, subject } = renderReferralCodeEmail(row.referral_code);
        await resend.emails.send({
          from: FROM,
          to: row.email,
          subject,
          html,
          text,
        });
        sent++;
        const { error: updateError } = await supabase
          .from("waitlist")
          .update({ referral_code_emailed_at: new Date().toISOString() })
          .eq("id", row.id);
        if (updateError) {
          updateFailed++;
          console.error(
            `[backfill-emails] update flag FAILED for ${row.email}`,
            updateError,
          );
          // Stop early — re-running would email this user a second time.
          break;
        }
        await sleep(SEND_DELAY_MS);
      } catch (err) {
        failed++;
        console.error(`[backfill-emails] send failed for ${row.email}`, err);
      }
    }

    // Re-count remaining so the UI can decide to call again.
    const { count: remainingCount } = await supabase
      .from("waitlist")
      .select("id", { count: "exact", head: true })
      .not("email", "is", null)
      .not("referral_code", "is", null)
      .is("referral_code_emailed_at", null);

    return NextResponse.json({
      processed: rows.length,
      sent,
      failed,
      updateFailed,
      remaining: remainingCount ?? 0,
    });
  } catch (err) {
    console.error("[backfill-emails POST] unexpected", err);
    return NextResponse.json({ error: "unexpected" }, { status: 500 });
  }
}
