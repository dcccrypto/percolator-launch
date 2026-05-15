import { NextResponse } from "next/server";
import { createHash } from "crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Resend } from "resend";
import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";
import {
  getWaitlistSupabase,
  getWaitlistServiceSupabase,
} from "@/lib/waitlist/supabase";
import {
  generateReferralCode,
  isValidReferralCodeShape,
} from "@/lib/waitlist/referralCode";

export const runtime = "nodejs";

// RFC 5322-lite — good enough to reject obvious garbage, not strict enough
// to reject corner-case-valid addresses.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const FROM = "Percolator <waitlist@percolator.trade>";

// ── Email-send abuse limits ──────────────────────────────────────────────
// Two distributed Upstash limiters bound the Resend send rate:
//   • per-email: at most one confirmation per address per 24h. Belt-and-
//     suspenders on top of the duplicate-insert short-circuit below — if
//     the unique constraint on lower(email) ever regresses, this still
//     caps inbox flooding from rotating IPs to one mail/day per victim.
//   • global hourly: at most WAITLIST_EMAIL_HOURLY_CAP confirmations across
//     all addresses per hour (default 500). Bounds Resend quota burn when
//     an attacker rotates through many fresh victim emails (the per-email
//     limiter can't help in that case because each is a first hit).
// Both fail open when Upstash isn't configured, matching the in-memory
// fallback posture in app/middleware.ts so local dev / CI keep working.
let _emailLimiter: Ratelimit | null = null;
let _globalEmailLimiter: Ratelimit | null = null;
let _emailLimitersInitialized = false;

function getEmailLimiters(): {
  perEmail: Ratelimit | null;
  global: Ratelimit | null;
} {
  if (_emailLimitersInitialized) {
    return { perEmail: _emailLimiter, global: _globalEmailLimiter };
  }
  _emailLimitersInitialized = true;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { perEmail: null, global: null };

  try {
    const redis = new Redis({ url, token });
    _emailLimiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(1, "24 h"),
      prefix: "rl:wl-em",
      analytics: false,
    });
    const globalCap = Math.max(
      1,
      Number(process.env.WAITLIST_EMAIL_HOURLY_CAP ?? 500),
    );
    _globalEmailLimiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(globalCap, "1 h"),
      prefix: "rl:wl-em-global",
      analytics: false,
    });
  } catch {
    // Init failure (bad credentials, network) — fail open.
    _emailLimiter = null;
    _globalEmailLimiter = null;
  }
  return { perEmail: _emailLimiter, global: _globalEmailLimiter };
}

/** sha256 hex of the lowercased email so the email cleartext doesn't end
 *  up in Redis logs / dashboards. */
function emailRateKey(email: string): string {
  return createHash("sha256").update(email).digest("hex");
}

/** Returns true iff a confirmation email may be sent to this address now.
 *  Consumes one slot from BOTH limiters on success — order matters: the
 *  global cap is checked first so a system-wide overflow doesn't burn a
 *  per-email budget that won't be used. Fail-open when Upstash is
 *  unconfigured (local dev / Redis outage). */
async function shouldSendConfirmationEmail(email: string): Promise<boolean> {
  const { perEmail, global } = getEmailLimiters();
  if (!perEmail || !global) return true; // fail-open
  const g = await global.limit("global");
  if (!g.success) {
    console.warn("[waitlist] global email cap reached this hour");
    return false;
  }
  const e = await perEmail.limit(emailRateKey(email));
  return e.success;
}

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
  // Referrer code (optional). Normalize to uppercase since codes are
  // Crockford base32 uppercase by definition; accept lowercase from the
  // wire so shared URLs that got lowercased somewhere still attribute.
  const referredByRaw =
    typeof b.referred_by_code === "string"
      ? b.referred_by_code.trim().toUpperCase()
      : null;

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

  // ── Wallet signature verification (moved up from later in the route) ────
  // We need to verify the signature BEFORE we can trust the pubkey for
  // the duplicate-lookup fast path below. Without that, anyone could
  // probe arbitrary pubkeys for membership. The mainnet spam check
  // (walletExistsOnMainnet) stays further down so it only fires on
  // genuinely new signups — pre-invite users who are just looking up
  // their existing code shouldn't burn a Helius RPC call.
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
  }

  // ── Sign-in fast path for existing wallet signups ───────────────────────
  // The waitlist is invite-only NOW, but every row created before that
  // change is grandfathered (referred_by_code IS NULL). Those users need
  // to be able to come back and see their backfilled referral code
  // without supplying an invite of their own — they ARE the invite list.
  //
  // Wallet-path only: the signature above proved ownership, so returning
  // the existing code is safe. Email-path lookup would require an OTP
  // (membership oracle) and is handled by the separate backfill-emails
  // operator action.
  if (hasWalletPart) {
    try {
      const service = getWaitlistServiceSupabase();
      const { data: existing } = await service
        .from("waitlist")
        .select("referral_code")
        .eq("pubkey", pubkey)
        .maybeSingle();
      if (existing && existing.referral_code) {
        let position: number | null = null;
        try {
          const { data } = await service.rpc("waitlist_position", {
            p_pubkey: pubkey,
          });
          if (typeof data === "number") position = data;
        } catch (err) {
          console.warn("[waitlist-signup] position lookup failed", err);
        }
        return NextResponse.json({
          ok: true,
          position,
          referral_code: existing.referral_code,
          returning: true,
        });
      }
    } catch (err) {
      console.warn("[waitlist-signup] lookup failed, falling through", err);
      // Fall through to the normal signup flow — worst case the user
      // gets the standard "invite required" error if they had no code.
    }
  }

  // ── Referrer validation (REQUIRED — invite-only) ────────────────────────
  // The waitlist is invite-only: every new signup must supply a valid
  // referral code from an existing member. Existing rows from before this
  // change are grandfathered (their referred_by_code stays NULL). Shape
  // check is a cheap pre-filter so the existence-check RPC isn't a free
  // oracle for "is any 8-char string in the table". On idempotent
  // re-submit, the duplicate branch later silently drops the value
  // without overwriting any prior referrer — preventing retroactive
  // self-attribution.
  if (referredByRaw === null || referredByRaw.length === 0) {
    return NextResponse.json(
      {
        error:
          "referral code required — Percolator is invite-only. Ask a member for a code or follow @percolatortrade for drops.",
      },
      { status: 400 },
    );
  }
  if (!isValidReferralCodeShape(referredByRaw)) {
    return NextResponse.json(
      { error: "referral code format invalid" },
      { status: 400 },
    );
  }
  let referredByCode: string;
  try {
    const existsCheck = await getWaitlistSupabase().rpc(
      "waitlist_referral_code_exists",
      { p_code: referredByRaw },
    );
    if (existsCheck.data !== true) {
      return NextResponse.json(
        { error: "referral code not recognised" },
        { status: 400 },
      );
    }
    referredByCode = referredByRaw;
  } catch (err) {
    console.error("[waitlist] referral code existence check failed", err);
    // Fail closed on RPC failure — better to reject than admit signups
    // bypassing the invite gate during a partial outage.
    return NextResponse.json(
      { error: "referral code check failed, try again" },
      { status: 503 },
    );
  }

  // Wallet signature was already verified at the top of this route
  // (before the sign-in fast-path lookup). Only the mainnet spam check
  // remains for new wallet signups — it fires here so existing-user
  // lookups don't burn a Helius RPC call.
  if (hasWalletPart) {
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
  // Generate a fresh referral_code per insert attempt. Two unique constraints
  // can fire here:
  //   • waitlist_referral_code_key — astronomically unlikely collision on a
  //     fresh random 8-char Crockford code; retry with a new one
  //   • waitlist_pubkey_key or waitlist_email_unique_idx — the same user
  //     re-submitting; idempotent, mark as duplicate and move on
  const supabase = getWaitlistSupabase();
  const baseRow: Record<string, unknown> = {
    twitter_handle,
    source,
    user_agent: userAgent,
  };
  if (hasEmail) baseRow.email = emailRaw;
  if (hasWalletPart) {
    baseRow.pubkey = pubkey;
    baseRow.signature = signature;
    baseRow.message = message;
  }
  baseRow.referred_by_code = referredByCode;

  const MAX_CODE_ATTEMPTS = 8;
  let referralCode: string | null = null;
  let isDuplicate = false;
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const candidate = generateReferralCode();
    const { error } = await supabase
      .from("waitlist")
      .insert({ ...baseRow, referral_code: candidate });
    if (!error) {
      referralCode = candidate;
      break;
    }
    if (error.code !== "23505") {
      console.error("[waitlist] insert error", error);
      return NextResponse.json({ error: "insert failed" }, { status: 500 });
    }
    // 23505 unique violation — distinguish by constraint name in the message.
    if (error.message?.includes("waitlist_referral_code_key")) {
      continue; // referral code collision — retry with a fresh code
    }
    // User already on the list (pubkey or email duplicate).
    isDuplicate = true;
    break;
  }

  if (!isDuplicate && referralCode === null) {
    console.error("[waitlist] referral code collision retry exhausted");
    return NextResponse.json({ error: "insert failed" }, { status: 500 });
  }

  // Wallet-path duplicate: the signature proves the caller owns the pubkey,
  // so returning the existing code is safe and gives idempotent UX
  // (refreshes / re-submits show the same code). For the email path, returning
  // the existing code on duplicate would turn the endpoint into a membership
  // oracle (anyone could probe "is email X on the list and what's their
  // code"), so on email-path duplicates we leave referralCode null and the
  // UI directs the user to their inbox.
  if (isDuplicate && hasWalletPart && referralCode === null) {
    referralCode = await readOrAssignReferralCode(pubkey!);
  }

  // ── Position lookup ─────────────────────────────────────────────────────
  // Routed through the service-role client so the underlying functions can
  // stay revoked from anon (membership-oracle prevention). Falls back to
  // null if the service env var is missing; UX-wise the success card
  // gracefully omits the position when null.
  let position: number | null = null;
  try {
    const service = getWaitlistServiceSupabase();
    if (hasWalletPart) {
      const { data } = await service.rpc("waitlist_position", { p_pubkey: pubkey });
      if (typeof data === "number") position = data;
    } else if (hasEmail) {
      const { data } = await service.rpc("waitlist_position_by_email", {
        p_email: emailRaw,
      });
      if (typeof data === "number") position = data;
    }
  } catch (err) {
    console.warn("[waitlist-signup] position lookup unavailable", err);
  }

  // ── Confirmation email (fire-and-forget) ────────────────────────────────
  // Three layers protect the Resend send from abuse:
  //   (1) skip on duplicate insert — Resend send count == new-row count,
  //       so the same email replayed from rotating IPs sends one mail, not N.
  //   (2) per-email budget (1/24h) — backstops layer 1 if the unique
  //       constraint on lower(email) ever regresses or a row gets deleted.
  //   (3) global hourly cap — bounds Resend quota burn during the
  //       many-fresh-victim-emails attack, where layer 1 and 2 don't help
  //       because every signup is genuinely new.
  // The response stays {ok:true, position} regardless of whether the mail
  // actually went out — leaking "we suppressed your mail" would tell an
  // attacker their target was already on the list (membership oracle).
  if (
    hasEmail &&
    !isDuplicate &&
    (await shouldSendConfirmationEmail(emailRaw!))
  ) {
    sendConfirmationEmail(emailRaw!, position, hasWalletPart, referralCode).catch(
      (err) => console.error("[waitlist] confirmation send failed", err),
    );
  }

  // Email-path duplicate: withhold both the code AND the position. Returning
  // either one would let an attacker holding the publishable key probe
  // arbitrary email addresses for membership (the position number itself
  // is a yes/no signal — non-null position = "this email is on the list").
  // Wallet-path duplicate is safe to fully respond to because the wallet
  // signature already proved ownership.
  const isEmailDuplicate = isDuplicate && !hasWalletPart;
  const responseCode = isEmailDuplicate ? null : referralCode;
  const responsePosition = isEmailDuplicate ? null : position;
  return NextResponse.json({
    ok: true,
    position: responsePosition,
    referral_code: responseCode,
    // Wallet-path-only: signals to the UI that this signup was an
    // idempotent re-submit so it can swap "you're in" copy for "welcome
    // back". Deliberately NOT set on the email-duplicate branch — a
    // `returning: true` flag tied to an email would be a clean
    // membership oracle. The email-flow UI infers "returning" from
    // referral_code === null instead (which is unavoidable signal we
    // already accepted).
    returning: isDuplicate && hasWalletPart,
  });
}

/**
 * Read the existing referral_code for a wallet that's already on the list, or
 * assign one if the row pre-dates the column (backfill miss / race). Uses the
 * service-role client because anon SELECT is denied for privacy.
 *
 * Only safe to call after the caller's signature over `pubkey` has been
 * verified by the calling route — otherwise this becomes a code-lookup
 * oracle for any pubkey.
 */
async function readOrAssignReferralCode(pubkey: string): Promise<string | null> {
  let service;
  try {
    service = getWaitlistServiceSupabase();
  } catch (err) {
    console.error("[waitlist] service client unavailable", err);
    return null;
  }

  const { data, error } = await service
    .from("waitlist")
    .select("referral_code")
    .eq("pubkey", pubkey)
    .maybeSingle();
  if (error) {
    console.error("[waitlist] read existing code failed", error);
    return null;
  }
  if (data?.referral_code) return data.referral_code as string;

  // Row exists but has no code — assign one with collision retry. The
  // `.is("referral_code", null)` predicate makes the update race-safe: if a
  // concurrent request already assigned a code, we get 0 rows updated and
  // re-read on the next loop iteration.
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = generateReferralCode();
    const { error: updateError, count } = await service
      .from("waitlist")
      .update({ referral_code: candidate }, { count: "exact" })
      .eq("pubkey", pubkey)
      .is("referral_code", null);
    if (!updateError && (count ?? 0) > 0) return candidate;
    if (updateError && updateError.code !== "23505") {
      console.error("[waitlist] update code failed", updateError);
      return null;
    }
    // Either 23505 (code collision) or 0 rows updated (concurrent assign).
    // Re-read to pick up the now-assigned code.
    const { data: reread } = await service
      .from("waitlist")
      .select("referral_code")
      .eq("pubkey", pubkey)
      .maybeSingle();
    if (reread?.referral_code) return reread.referral_code as string;
  }
  console.error("[waitlist] assign code retries exhausted");
  return null;
}

// ─── Email confirmation send via Resend ──────────────────────────────────────

async function sendConfirmationEmail(
  email: string,
  position: number | null,
  hasWallet: boolean,
  referralCode: string | null,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    console.warn("[waitlist] RESEND_API_KEY missing — skipping confirmation send");
    return;
  }
  const resend = new Resend(apiKey);

  /** Marks the row's `referral_code_emailed_at` once Resend confirms the
   * send. Best-effort: a missing service-role key or a transient supabase
   * error logs and returns — the backfill script will retry on its next
   * pass. Pulled here (rather than as a separate await chain) so we don't
   * block the route handler on this update.
   *
   * The `.eq("email", email)` match is case-sensitive at the storage layer.
   * Two things make it correct anyway:
   *   • New rows: this function only runs on `email` already lowercased by
   *     the route (see emailRaw = ...toLowerCase() above).
   *   • Pre-existing rows: the schema migration's one-time
   *     `update waitlist set email = lower(email)` block normalises legacy
   *     mixed-case rows before they can be touched here.
   */
  const markEmailed = async () => {
    if (!referralCode) return;
    try {
      const service = getWaitlistServiceSupabase();
      await service
        .from("waitlist")
        .update({ referral_code_emailed_at: new Date().toISOString() })
        .eq("email", email)
        .is("referral_code_emailed_at", null);
    } catch (err) {
      console.warn("[waitlist-signup] mark emailed failed (non-fatal)", err);
    }
  };
  const positionLine = position
    ? `<p style="margin: 0 0 16px; font-size: 14px; line-height: 1.5; color: #4A4B62;">You're <strong style="color: #9945FF; font-family: ui-monospace, SFMono-Regular, monospace;">#${position}</strong> on the list.</p>`
    : "";

  // Referral block — code + share link. Rendered inline as a copy-friendly
  // monospace pill. The link points at /r/<code>; that route attributes the
  // referrer for any signup that lands through it (separate follow-up PR).
  const referralBlock = referralCode
    ? `<div style="margin: 0 0 20px; padding: 14px 16px; background: #F8F8FC; border: 1px solid #E0E0EC; border-radius: 6px;">
        <div style="font-family: ui-monospace, SFMono-Regular, monospace; font-size: 10px; letter-spacing: 0.18em; color: #8A8BA8; text-transform: uppercase; margin-bottom: 6px;">YOUR REFERRAL CODE</div>
        <div style="font-family: ui-monospace, SFMono-Regular, monospace; font-size: 20px; font-weight: 700; letter-spacing: 0.08em; color: #0D0E15;">${referralCode}</div>
        <div style="margin-top: 10px; font-size: 12.5px; line-height: 1.55; color: #4A4B62;">Share your link: <a href="https://percolator.trade/r/${referralCode}" style="color:#9945FF; text-decoration: underline; font-family: ui-monospace, SFMono-Regular, monospace;">percolator.trade/r/${referralCode}</a></div>
      </div>`
    : "";

  const referralText = referralCode
    ? `\n\nYour referral code: ${referralCode}\nShare your link: https://percolator.trade/r/${referralCode}\n`
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
      ${referralBlock}
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
    text: `You're on the Percolator waitlist.${position ? `\n\nYou're #${position} on the list.` : ""}${referralText}\nMainnet opens after our external audit clears (targeting Q3 2026). We'll email you here when it does.\n\n${secondaryText}\n\n@percolatortrade · github.com/dcccrypto · percolator.trade/pitch\n\n—\nYou received this because you joined the Percolator waitlist. Reply "remove" to be removed.`,
  });

  // Resend.send resolves on accept — at that point the message is queued
  // with Resend. Mark the row so the backfill doesn't re-email this user.
  await markEmailed();
}
