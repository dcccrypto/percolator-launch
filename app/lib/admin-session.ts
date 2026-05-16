import { NextResponse } from "next/server";
import { verifyPrivyAuth } from "@/lib/privy-auth";

/**
 * Admin auth — Privy session + allowlist.
 *
 * Two allowlist mechanisms, either of which is sufficient. An admin
 * is anyone whose Privy session matches:
 *
 *   • PRIVY_ADMIN_DIDS — comma-separated list of Privy DIDs. The
 *     DID is the most stable identifier (doesn't depend on which
 *     email is "primary", doesn't depend on OAuth linkage state,
 *     never changes after Privy creates the account). Prefer this.
 *     The list may include the "did:privy:" prefix or omit it —
 *     we strip on both sides before comparing.
 *
 *   • PRIVY_ADMIN_EMAILS — comma-separated list of email addresses,
 *     lowercase. Matched against ANY of the user's verified emails
 *     (direct email account, Google/Apple OAuth email). Useful when
 *     onboarding a new admin who you don't yet have a DID for, but
 *     less reliable than DID.
 *
 * 503 only when BOTH lists are empty — refuse to fail-open.
 *
 * Background: pivoted from Supabase Auth + admin_users table when
 * the trading Supabase project went away. The DID path was added
 * after operators hit "your email isn't admin" 403s caused by
 * Privy linking the same human to a different primary email than
 * the one in PRIVY_ADMIN_EMAILS — the DID sidesteps that whole class
 * of confusion.
 */

function normalizeEmail(s: string): string {
  return s.trim().toLowerCase();
}

function stripDidPrefix(s: string): string {
  const t = s.trim();
  return t.startsWith("did:privy:") ? t.slice("did:privy:".length) : t;
}

function getAdminEmailSet(): Set<string> {
  const raw = (process.env.PRIVY_ADMIN_EMAILS ?? "").trim();
  return new Set(
    raw
      .split(",")
      .map(normalizeEmail)
      .filter(Boolean),
  );
}

function getAdminDidSet(): Set<string> {
  const raw = (process.env.PRIVY_ADMIN_DIDS ?? "").trim();
  return new Set(
    raw
      .split(",")
      .map((s) => stripDidPrefix(s))
      .filter(Boolean),
  );
}

export type AdminSessionResult =
  | { ok: true; userId: string; email: string | null }
  | { ok: false; response: NextResponse };

export async function requireAdminSession(
  req: Request,
): Promise<AdminSessionResult> {
  const adminEmails = getAdminEmailSet();
  const adminDids = getAdminDidSet();
  if (adminEmails.size === 0 && adminDids.size === 0) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error:
            "Neither PRIVY_ADMIN_DIDS nor PRIVY_ADMIN_EMAILS is configured on the server",
        },
        { status: 503 },
      ),
    };
  }

  const auth = await verifyPrivyAuth(req);
  if (!auth.ok) {
    const message =
      auth.status === 503
        ? "PRIVY_APP_SECRET not configured on the server"
        : auth.reason === "invalid-token"
          ? "Session expired or invalid — sign in again"
          : "No Privy session";
    return {
      ok: false,
      response: NextResponse.json(
        { error: message },
        { status: auth.status },
      ),
    };
  }

  // DID match first — the canonical identity.
  const didMatch = adminDids.has(stripDidPrefix(auth.userId));
  if (didMatch) {
    return { ok: true, userId: auth.userId, email: auth.email };
  }

  // Email any-match — works across multiple linked emails.
  const emailMatch = auth.emails.find((e) => adminEmails.has(e)) ?? null;
  if (emailMatch) {
    return { ok: true, userId: auth.userId, email: emailMatch };
  }

  // No match on either. Surface BOTH the DID and the emails so the
  // operator can pick which to add to the allowlist.
  const emailList = auth.emails.length
    ? auth.emails.join(", ")
    : "(no verified emails on session)";
  return {
    ok: false,
    response: NextResponse.json(
      {
        error: `Not an admin. DID=${stripDidPrefix(auth.userId)}, emails=${emailList}. Add the DID to PRIVY_ADMIN_DIDS or one email to PRIVY_ADMIN_EMAILS.`,
      },
      { status: 403 },
    ),
  };
}
