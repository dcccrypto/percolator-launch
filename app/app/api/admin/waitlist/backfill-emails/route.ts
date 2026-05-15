import { NextResponse } from "next/server";
import { Resend } from "resend";
import { getWaitlistServiceSupabase } from "@/lib/waitlist/supabase";
import { requireAdminSession } from "@/lib/admin-session";

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

function renderText(code: string): string {
  return `Your Percolator referral code is ready.

You're already on the waitlist — we just shipped referral codes and here's yours:

  ${code}

Share your link: https://percolator.trade/r/${code}

When someone joins through your link, you get attribution. Mainnet opens after our external audit clears (targeting Q3 2026).

@percolatortrade · github.com/dcccrypto

—
You received this because you joined the Percolator waitlist. Reply "remove" to be removed.`;
}

function renderHtml(code: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Your referral code</title></head>
<body style="margin:0; padding:32px 16px; background:#F8F8FC; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #0D0E15;">
  <div style="max-width:560px; margin:0 auto; background:#FFFFFF; border:1px solid #E0E0EC; border-radius:8px; overflow:hidden;">
    <div style="padding: 28px 28px 0;">
      <div style="font-family: ui-monospace, SFMono-Regular, monospace; font-size: 11px; letter-spacing: 0.18em; color: #8A8BA8; text-transform: uppercase;">PERCOLATOR · WAITLIST</div>
    </div>
    <div style="padding: 18px 28px 28px;">
      <h1 style="margin: 0 0 12px; font-size: 22px; line-height: 1.2; font-weight: 700; color: #0D0E15;">Your referral code is ready.</h1>
      <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.65; color: #4A4B62;">
        You're already on the Percolator waitlist. We just shipped referral codes &mdash; here's yours:
      </p>
      <div style="margin: 0 0 20px; padding: 14px 16px; background: #F8F8FC; border: 1px solid #E0E0EC; border-radius: 6px;">
        <div style="font-family: ui-monospace, SFMono-Regular, monospace; font-size: 10px; letter-spacing: 0.18em; color: #8A8BA8; text-transform: uppercase; margin-bottom: 6px;">YOUR REFERRAL CODE</div>
        <div style="font-family: ui-monospace, SFMono-Regular, monospace; font-size: 20px; font-weight: 700; letter-spacing: 0.08em; color: #0D0E15;">${code}</div>
        <div style="margin-top: 10px; font-size: 12.5px; line-height: 1.55; color: #4A4B62;">Share your link: <a href="https://percolator.trade/r/${code}" style="color:#9945FF; text-decoration: underline; font-family: ui-monospace, SFMono-Regular, monospace;">percolator.trade/r/${code}</a></div>
      </div>
      <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.65; color: #4A4B62;">
        When someone joins through your link, you get attribution. Mainnet opens after our external audit clears (targeting Q3 2026).
      </p>
      <hr style="margin: 22px 0; border:0; border-top: 1px solid #E0E0EC;">
      <p style="margin: 0; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; line-height: 1.7; color: #8A8BA8;">
        <a href="https://x.com/percolatortrade" style="color:#8A8BA8; text-decoration:none;">@percolatortrade</a> &middot; <a href="https://github.com/dcccrypto" style="color:#8A8BA8; text-decoration:none;">github.com/dcccrypto</a>
      </p>
    </div>
  </div>
  <p style="max-width:560px; margin: 14px auto 0; font-size: 11px; line-height: 1.5; color: #B8B9CC; text-align: center;">
    You received this because you joined the Percolator waitlist. Reply "remove" to be removed.
  </p>
</body></html>`;
}

/**
 * GET — return the pending count without sending anything.
 * The admin UI uses this to decide whether to show the "Send emails" button.
 */
export async function GET() {
  const auth = await requireAdminSession();
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
export async function POST() {
  const auth = await requireAdminSession();
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
        await resend.emails.send({
          from: FROM,
          to: row.email,
          subject: "Your Percolator referral code",
          html: renderHtml(row.referral_code),
          text: renderText(row.referral_code),
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
