import { NextResponse } from "next/server";
import { getWaitlistServiceSupabase } from "@/lib/waitlist/supabase";
import { verifyPrivyAuth } from "@/lib/privy-auth";
import { ensureReferralCode } from "@/lib/waitlist/ensureReferralCode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/waitlist/whoami
 *
 * Identity-aware waitlist lookup.
 *
 * Auth: Privy access token in `Authorization: Bearer …`. Optionally
 * `X-Privy-Id-Token` for the no-rate-limit path that parses linked
 * accounts directly from the id token.
 *
 * Resolution order:
 *   1. Look up by privy_did   — fastest, indexed, no false matches
 *   2. Look up by pubkey      — for users who signed up wallet-only
 *                                 before Privy was wired up to write DIDs
 *   3. Look up by email       — for users who signed up email-only
 *
 * On a (2) or (3) hit, opportunistically backfill `privy_did` so the
 * next request is a (1) hit. This unifies the 126 pre-Privy-DID rows
 * over time with no migration script.
 *
 * A matched row without a referral code (a legacy row the backfill
 * missed) is given one here: the Privy session has just proved the DID,
 * wallet or email that matched it. Without this an early email member
 * could never get back in — see lib/waitlist/ensureReferralCode.
 *
 * Returns:
 *   { found: true, referral_code, position, returning, linked: {…} }
 *   { found: false }                       — Privy user, no waitlist row yet
 *   401                                    — token missing / invalid
 *   503                                    — server not configured for Privy
 *
 * Never reveals which identifier matched (privy_did vs pubkey vs email)
 * because the client doesn't need to know and the response would be a
 * mild side-channel about which channel a user originally signed up
 * through.
 */
export async function POST(req: Request) {
  const auth = await verifyPrivyAuth(req);
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.reason },
      { status: auth.status },
    );
  }

  try {
    const supabase = getWaitlistServiceSupabase();

    // ── Step 1: privy_did exact match ────────────────────────────────
    {
      const { data, error } = await supabase
        .from("waitlist")
        .select("id, pubkey, email, referral_code, privy_did, created_at")
        .eq("privy_did", auth.userId)
        .maybeSingle();
      // An outage must not read as "not on the list".
      if (error) throw new Error("whoami lookup by privy_did failed");
      if (data) {
        const referral_code = data.referral_code ?? (await ensureReferralCode(supabase, data.id));
        const position = await getPosition(supabase, data);
        return NextResponse.json({
          found: true,
          referral_code,
          position,
          returning: true,
        });
      }
    }

    // ── Step 2: pubkey match (legacy wallet-path signups) ────────────
    for (const pubkey of auth.solanaWallets) {
      const { data, error } = await supabase
        .from("waitlist")
        .select("id, pubkey, email, referral_code, privy_did, created_at")
        .eq("pubkey", pubkey)
        .maybeSingle();
      if (error) throw new Error("whoami lookup by pubkey failed");
      if (data) {
        // Opportunistic backfill — if this row has no DID yet, claim it.
        if (!data.privy_did) {
          await backfillPrivyDid(supabase, data.id, auth.userId);
        }
        const referral_code = data.referral_code ?? (await ensureReferralCode(supabase, data.id));
        const position = await getPosition(supabase, data);
        return NextResponse.json({
          found: true,
          referral_code,
          position,
          returning: true,
        });
      }
    }

    // ── Step 3: email match (legacy email-path signups) ──────────────
    // Every verified email, not just the primary: a member may have signed
    // in with a different address than the one linked first.
    for (const email of auth.emails.length ? auth.emails : auth.email ? [auth.email] : []) {
      // Case-insensitive exact match (rows from before the lowercase policy
      // may store mixed case); LIKE wildcards escaped.
      const escaped = email.replace(/[\\%_]/g, (c) => `\\${c}`);
      const { data, error } = await supabase
        .from("waitlist")
        .select("id, pubkey, email, referral_code, privy_did, created_at")
        .ilike("email", escaped)
        .limit(1)
        .maybeSingle();
      if (error) throw new Error("whoami lookup by email failed");
      if (data) {
        if (!data.privy_did) {
          await backfillPrivyDid(supabase, data.id, auth.userId);
        }
        const referral_code = data.referral_code ?? (await ensureReferralCode(supabase, data.id));
        const position = await getPosition(supabase, data);
        return NextResponse.json({
          found: true,
          referral_code,
          position,
          returning: true,
        });
      }
    }

    // No matching row — this Privy user isn't on the waitlist yet.
    return NextResponse.json({ found: false });
  } catch (err) {
    console.error("[whoami] unexpected", err);
    return NextResponse.json({ error: "unexpected" }, { status: 500 });
  }
}

async function backfillPrivyDid(
  supabase: ReturnType<typeof getWaitlistServiceSupabase>,
  rowId: string,
  did: string,
): Promise<void> {
  try {
    // `is_null` guard keeps the update idempotent against concurrent
    // requests for the same Privy user across multiple identifiers.
    const { error } = await supabase
      .from("waitlist")
      .update({ privy_did: did })
      .eq("id", rowId)
      .is("privy_did", null);
    if (error) {
      // Unique-violation (23505) means another concurrent call won
      // the race for this DID — that's fine, the row is now linked.
      if (error.code !== "23505") {
        console.warn("[whoami] backfill privy_did failed", error);
      }
    }
  } catch (err) {
    console.warn("[whoami] backfill threw", err);
  }
}

async function getPosition(
  supabase: ReturnType<typeof getWaitlistServiceSupabase>,
  row: { pubkey: string | null; email: string | null },
): Promise<number | null> {
  try {
    if (row.pubkey) {
      const { data } = await supabase.rpc("waitlist_position", {
        p_pubkey: row.pubkey,
      });
      if (typeof data === "number") return data;
    }
    if (row.email) {
      const { data } = await supabase.rpc("waitlist_position_by_email", {
        p_email: row.email,
      });
      if (typeof data === "number") return data;
    }
  } catch (err) {
    console.warn("[whoami] position lookup failed", err);
  }
  return null;
}
