import { NextResponse } from "next/server";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Resend } from "resend";
import { getWaitlistSupabase } from "@/lib/waitlist/supabase";

export const runtime = "nodejs";

// RFC 5322-lite — good enough to reject obvious garbage, not strict enough
// to reject corner-case-valid addresses.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const FROM = "Percolator <waitlist@percolator.trade>";

/**
 * High-intent waitlist signup.
 *
 * Body: {
 *   pubkey: base58 Solana public key,
 *   signature: base58 signature over `message`,
 *   message: text the user signed (MUST contain the pubkey + a recent timestamp),
 *   twitter_handle?: optional handle for follow-up,
 *   source?: optional UTM source
 * }
 *
 * The server verifies the signature with tweetnacl BEFORE inserting,
 * so the RLS-anon-insert policy on the waitlist table cannot be abused
 * to insert someone else's pubkey.
 *
 * Replay protection: the message must include a timestamp within the
 * last 10 minutes; the server rejects older messages.
 */

const MESSAGE_PREFIX = "Joining the Percolator waitlist at ";
const MAX_MESSAGE_AGE_MS = 10 * 60 * 1000; // 10 min

function isValidSolanaPubkey(s: string): boolean {
  try {
    const bytes = bs58.decode(s);
    return bytes.length === 32;
  } catch {
    return false;
  }
}

/**
 * Spam filter: check that the pubkey has been seen on Solana mainnet at all.
 *
 * A spammer can generate ed25519 keypairs locally and sign arbitrary messages —
 * the signature verifies but the wallet has never been funded or used. Real
 * users have at least one on-chain transaction (Phantom funds the account on
 * first use, and any received SOL creates an account info entry).
 *
 * Implementation: server-side getAccountInfo call against Helius mainnet using
 * HELIUS_MAINNET_API_KEY. Result.value === null means "system program does not
 * have an account here" = wallet has never received SOL.
 *
 * Posture: fail-open on RPC errors so a Helius outage doesn't block signups.
 * The cost of letting through a few extras during an outage is lower than
 * blocking real users.
 */
async function walletExistsOnMainnet(pubkey: string): Promise<boolean> {
  const apiKey = (
    process.env.HELIUS_MAINNET_API_KEY ??
    process.env.HELIUS_API_KEY ??
    ""
  ).trim();
  const url = apiKey
    ? `https://mainnet.helius-rpc.com/?api-key=${apiKey}`
    : "https://api.mainnet-beta.solana.com";

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [pubkey, { encoding: "base64", commitment: "confirmed" }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn("[waitlist] mainnet RPC non-2xx, fail-open", res.status);
      return true;
    }
    const data = (await res.json()) as { result?: { value?: unknown } };
    return data?.result?.value !== null && data?.result?.value !== undefined;
  } catch (err) {
    console.warn("[waitlist] mainnet RPC error, fail-open", err);
    return true;
  }
}

function parseTimestampFromMessage(message: string): number | null {
  if (!message.startsWith(MESSAGE_PREFIX)) return null;
  const tail = message.slice(MESSAGE_PREFIX.length);
  // Tail format: <ISO8601 timestamp> | <pubkey>
  const sepIdx = tail.indexOf(" | ");
  if (sepIdx === -1) return null;
  const ts = tail.slice(0, sepIdx);
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const b = body as Record<string, unknown>;

  // Honeypot — silently accept and drop
  if (typeof b.website === "string" && b.website.length > 0) {
    return NextResponse.json({ ok: true });
  }

  const twitter_handle =
    typeof b.twitter_handle === "string" && b.twitter_handle.trim().length > 0
      ? b.twitter_handle.trim().slice(0, 50)
      : null;
  const source =
    typeof b.source === "string" && b.source.length > 0
      ? b.source.slice(0, 100)
      : null;
  const userAgent = req.headers.get("user-agent")?.slice(0, 200) ?? null;

  // ── Parse all candidate fields ──────────────────────────────────────────
  const emailRaw = typeof b.email === "string" ? b.email.trim().toLowerCase() : null;
  const pubkey = typeof b.pubkey === "string" ? b.pubkey : null;
  const signature = typeof b.signature === "string" ? b.signature : null;
  const message = typeof b.message === "string" ? b.message : null;

  // Validate email shape if present
  if (emailRaw !== null) {
    if (!emailRaw || !EMAIL_RE.test(emailRaw) || emailRaw.length > 254) {
      return NextResponse.json({ error: "invalid email" }, { status: 400 });
    }
  }

  // Two valid input shapes:
  //   1. email only                       → notify by email only
  //   2. pubkey + signature + message     → notify on chain, no email
  //
  // The combined shape (email + wallet fields) was previously accepted for
  // the Privy embedded-wallet flow, with the on-chain existence check
  // skipped on the assumption that Privy's OTP gate proved real intent.
  // The route never actually verified anything from Privy, so the skip
  // let any caller bind an arbitrary email to a self-controlled keypair —
  // and the silent 23505 swallow below meant a victim later signing up
  // with the same email would receive {ok:true} while their pubkey was
  // never persisted. Rejecting the combined shape closes that vector
  // without touching the two pure paths. The dApp gate at mainnet open
  // re-authenticates Privy users via Privy directly, so binding the
  // embedded wallet into the waitlist row was never load-bearing for
  // priority-access recovery — it was decorative trust the server
  // couldn't actually validate.
  const hasWalletPart = pubkey !== null && signature !== null && message !== null;
  const hasEmail = emailRaw !== null;

  if (hasEmail && hasWalletPart) {
    return NextResponse.json(
      {
        error:
          "email and wallet signups are separate paths — submit one or the other, not both",
      },
      { status: 400 },
    );
  }

  if (!hasEmail && !hasWalletPart) {
    return NextResponse.json(
      { error: "provide an email or a wallet signature" },
      { status: 400 },
    );
  }

  // If we have wallet fields, verify them. (Whether or not email is provided.)
  if (hasWalletPart) {
    if (!isValidSolanaPubkey(pubkey!)) {
      return NextResponse.json({ error: "invalid pubkey" }, { status: 400 });
    }
    const ts = parseTimestampFromMessage(message!);
    if (!ts) {
      return NextResponse.json({ error: "invalid message format" }, { status: 400 });
    }
    if (Math.abs(Date.now() - ts) > MAX_MESSAGE_AGE_MS) {
      return NextResponse.json({ error: "message expired" }, { status: 400 });
    }
    if (!message!.includes(pubkey!)) {
      return NextResponse.json({ error: "message must include pubkey" }, { status: 400 });
    }
    let sigBytes: Uint8Array;
    let pubBytes: Uint8Array;
    try {
      sigBytes = bs58.decode(signature!);
      pubBytes = bs58.decode(pubkey!);
    } catch {
      return NextResponse.json({ error: "decode failed" }, { status: 400 });
    }
    if (sigBytes.length !== 64 || pubBytes.length !== 32) {
      return NextResponse.json({ error: "wrong sig/pubkey length" }, { status: 400 });
    }
    const msgBytes = new TextEncoder().encode(message!);
    const ok = nacl.sign.detached.verify(msgBytes, sigBytes, pubBytes);
    if (!ok) {
      return NextResponse.json({ error: "signature invalid" }, { status: 401 });
    }

    // Spam filter: wallet must have been seen on Solana mainnet at least once.
    // The combined-shape rejection above guarantees hasEmail is false here, so
    // the previous `if (!hasEmail)` guard is now redundant — the check runs
    // unconditionally on the wallet-only path.
    const exists = await walletExistsOnMainnet(pubkey!);
    if (!exists) {
      return NextResponse.json(
        {
          error:
            "wallet not seen on Solana mainnet — fund this wallet (any amount) and try again",
        },
        { status: 400 },
      );
    }
  }

  // ── Insert ──────────────────────────────────────────────────────────────
  const supabase = getWaitlistSupabase();
  const insertRow: Record<string, unknown> = {
    twitter_handle,
    source,
    user_agent: userAgent,
  };
  if (hasEmail) insertRow.email = emailRaw;
  if (hasWalletPart) {
    insertRow.pubkey = pubkey;
    insertRow.signature = signature;
    insertRow.message = message;
  }

  const { error: insertError } = await supabase.from("waitlist").insert(insertRow);
  // 23505 = unique violation (already on the list) — idempotent
  if (insertError && insertError.code !== "23505") {
    console.error("[waitlist] insert error", insertError);
    return NextResponse.json({ error: "insert failed" }, { status: 500 });
  }

  // ── Position lookup ─────────────────────────────────────────────────────
  let position: number | null = null;
  try {
    if (hasWalletPart) {
      const { data } = await supabase.rpc("waitlist_position", { p_pubkey: pubkey });
      if (typeof data === "number") position = data;
    } else if (hasEmail) {
      const { data } = await supabase.rpc("waitlist_position_by_email", {
        p_email: emailRaw,
      });
      if (typeof data === "number") position = data;
    }
  } catch {
    /* ignore */
  }

  // ── Confirmation email (fire-and-forget) ────────────────────────────────
  if (hasEmail) {
    sendConfirmationEmail(emailRaw!, position, hasWalletPart).catch((err) =>
      console.error("[waitlist] confirmation send failed", err),
    );
  }

  return NextResponse.json({ ok: true, position });
}

// ─── Email confirmation send via Resend ──────────────────────────────────────

async function sendConfirmationEmail(
  email: string,
  position: number | null,
  hasWallet: boolean,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    console.warn("[waitlist] RESEND_API_KEY missing — skipping confirmation send");
    return;
  }
  const resend = new Resend(apiKey);
  const positionLine = position
    ? `<p style="margin: 0 0 16px; font-size: 14px; line-height: 1.5; color: #4A4B62;">You're <strong style="color: #9945FF; font-family: ui-monospace, SFMono-Regular, monospace;">#${position}</strong> on the list.</p>`
    : "";

  // If the signup came in with a wallet (Privy email login → embedded
  // wallet), the user is already covered by the on-chain notification
  // path. If it's email-only, nudge them toward the wallet path as a
  // backup channel.
  const secondaryParagraph = hasWallet
    ? `<p style="margin: 0 0 16px; font-size: 14px; line-height: 1.65; color: #4A4B62;">
        We also created a Solana wallet under your email (Privy embedded). When mainnet opens, the dApp at percolator.trade will recognise that wallet and unlock your priority access automatically — no extra step.
      </p>`
    : `<p style="margin: 0 0 16px; font-size: 14px; line-height: 1.65; color: #4A4B62;">
        Have a Solana wallet of your own? Sign up <a href="https://percolator.trade/#reserve" style="color:#9945FF; text-decoration: underline;">with your wallet too</a> — we send a wallet-native notification on chain (memo from our project wallet) when mainnet opens, so you get pinged in Phantom even if you miss this email.
      </p>`;

  const secondaryText = hasWallet
    ? `We also created a Solana wallet under your email (Privy embedded). When mainnet opens, the dApp at percolator.trade will recognise that wallet and unlock your priority access automatically — no extra step.`
    : `Have a Solana wallet? Sign up with your wallet too at https://percolator.trade/#reserve — we send a wallet-native notification on chain when mainnet opens.`;

  await resend.emails.send({
    from: FROM,
    to: email,
    subject: "You're on the Percolator waitlist",
    html: `<!doctype html>
<html><head><meta charset="utf-8"><title>Welcome</title></head>
<body style="margin:0; padding:32px 16px; background:#F8F8FC; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #0D0E15;">
  <div style="max-width:560px; margin:0 auto; background:#FFFFFF; border:1px solid #E0E0EC; border-radius:8px; overflow:hidden;">
    <div style="padding: 28px 28px 0;">
      <div style="font-family: ui-monospace, SFMono-Regular, monospace; font-size: 11px; letter-spacing: 0.18em; color: #8A8BA8; text-transform: uppercase;">PERCOLATOR · WAITLIST</div>
    </div>
    <div style="padding: 18px 28px 28px;">
      <h1 style="margin: 0 0 12px; font-size: 22px; line-height: 1.2; font-weight: 700; color: #0D0E15;">You're on the list.</h1>
      ${positionLine}
      <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.65; color: #4A4B62;">
        Mainnet opens after our external audit clears (targeting Q3 2026). We'll email you here when it does.
      </p>
      ${secondaryParagraph}
      <hr style="margin: 22px 0; border:0; border-top: 1px solid #E0E0EC;">
      <p style="margin: 0; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; line-height: 1.7; color: #8A8BA8;">
        <a href="https://x.com/percolatortrade" style="color:#8A8BA8; text-decoration:none;">@percolatortrade</a> · <a href="https://github.com/dcccrypto" style="color:#8A8BA8; text-decoration:none;">github.com/dcccrypto</a> · <a href="https://percolator.trade/pitch" style="color:#8A8BA8; text-decoration:none;">percolator.trade/pitch</a>
      </p>
    </div>
  </div>
  <p style="max-width:560px; margin: 14px auto 0; font-size: 11px; line-height: 1.5; color: #B8B9CC; text-align: center;">
    You received this because you joined the Percolator waitlist at percolator.trade. If you'd like to be removed, reply with "remove".
  </p>
</body></html>`,
    text: `You're on the Percolator waitlist.${position ? `\n\nYou're #${position} on the list.` : ""}\n\nMainnet opens after our external audit clears (targeting Q3 2026). We'll email you here when it does.\n\n${secondaryText}\n\n@percolatortrade · github.com/dcccrypto · percolator.trade/pitch\n\n—\nYou received this because you joined the Percolator waitlist. Reply "remove" to be removed.`,
  });
}
