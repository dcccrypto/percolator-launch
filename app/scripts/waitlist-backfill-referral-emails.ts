/**
 * One-time backfill: email every existing email-path waitlist signup their
 * referral code.
 *
 * Run once after the referral-code migration lands. Idempotent — re-runs
 * skip anyone whose `referral_code_emailed_at` is already set, so it's
 * safe to resume after a partial run.
 *
 * Usage:
 *   cd app
 *   pnpm tsx scripts/waitlist-backfill-referral-emails.ts            # send
 *   pnpm tsx scripts/waitlist-backfill-referral-emails.ts --dry-run  # preview
 *
 * Env required:
 *   NEXT_PUBLIC_WAITLIST_SUPABASE_URL
 *   WAITLIST_SUPABASE_SERVICE_ROLE_KEY
 *   RESEND_API_KEY
 *
 * Pacing: ~4 sends/sec via SEND_DELAY_MS. Resend's default plan ceiling is
 * 10/sec, so this leaves headroom for the live signup route to keep
 * sending its own confirmations in parallel without throttling.
 */

import { Resend } from "resend";
import { getWaitlistServiceSupabase } from "@/lib/waitlist/supabase";

const FROM = "Percolator <waitlist@percolator.trade>";
const BATCH_SIZE = 100;
const SEND_DELAY_MS = 250;

interface Row {
  id: string;
  email: string;
  referral_code: string;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) console.log("[backfill] DRY RUN — no emails sent, no rows updated");

  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey && !dryRun) {
    console.error("RESEND_API_KEY missing");
    process.exit(1);
  }
  const resend = apiKey ? new Resend(apiKey) : null;
  const supabase = getWaitlistServiceSupabase();

  let processed = 0;
  let sent = 0;
  let failed = 0;
  let updateFailed = 0;

  while (true) {
    const { data, error } = await supabase
      .from("waitlist")
      .select("id, email, referral_code")
      .not("email", "is", null)
      .not("referral_code", "is", null)
      .is("referral_code_emailed_at", null)
      .limit(BATCH_SIZE);
    if (error) {
      console.error("[backfill] select failed", error);
      process.exit(1);
    }
    const rows = (data ?? []) as Row[];
    if (rows.length === 0) {
      console.log("[backfill] no more rows");
      break;
    }

    for (const row of rows) {
      processed++;
      if (dryRun) {
        console.log(
          `[backfill] DRY would email ${row.email} (code ${row.referral_code})`,
        );
        continue;
      }
      try {
        await resend!.emails.send({
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
            `[backfill] update flag FAILED for ${row.email}`,
            updateError,
          );
        }
        await sleep(SEND_DELAY_MS);
      } catch (err) {
        failed++;
        console.error(`[backfill] send failed for ${row.email}`, err);
      }
    }
    console.log(
      `[backfill] batch: processed=${processed} sent=${sent} failed=${failed} updateFailed=${updateFailed}`,
    );
  }

  console.log(
    `[backfill] DONE: processed=${processed} sent=${sent} failed=${failed} updateFailed=${updateFailed}`,
  );
  if (updateFailed > 0) {
    console.error(
      "[backfill] DO NOT RE-RUN until you reconcile flags. Some rows were",
      "successfully emailed but their referral_code_emailed_at could not be",
      "set — re-running will email those users a second time.",
    );
    process.exit(2);
  }
  if (failed > 0) process.exit(1);
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

main().catch((err) => {
  console.error("[backfill] fatal", err);
  process.exit(1);
});
