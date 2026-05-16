import { NextResponse } from "next/server";
import { verifyPrivyAuth } from "@/lib/privy-auth";

/**
 * Admin auth, pivoted from Supabase Auth + admin_users table to
 * Privy session + email allowlist.
 *
 * Why the change: the original implementation required a working
 * trading Supabase project (NEXT_PUBLIC_SUPABASE_URL) to verify
 * Supabase Auth cookies + read the admin_users table. When that
 * project went down, admin login broke entirely.
 *
 * The new model:
 *  1. Caller (admin route handler or the admin page itself) attaches
 *     a Privy access token in `Authorization: Bearer …` plus an
 *     identity token in `X-Privy-Id-Token`. verifyPrivyAuth verifies
 *     both via @privy-io/node and extracts the user's linked email.
 *  2. We check the verified email against PRIVY_ADMIN_EMAILS, a
 *     comma-separated env-var allowlist (case-insensitive). Members
 *     are admins; everyone else gets 403.
 *
 * The email comes from a verified Privy identity token, so we trust
 * Privy's OTP / 2FA verification implicitly — when Privy 2FA is
 * enabled in the dashboard, admins step through the second factor
 * before a session is issued, then any request bearing that session
 * is an authenticated-second-factor request.
 */

function normalizeEmail(s: string): string {
  return s.trim().toLowerCase();
}

// Resolved fresh on each call so env edits take effect on the next
// request without needing a process restart.
function getAdminEmailSet(): Set<string> {
  const raw = (process.env.PRIVY_ADMIN_EMAILS ?? "").trim();
  return new Set(
    raw
      .split(",")
      .map(normalizeEmail)
      .filter(Boolean),
  );
}

export type AdminSessionResult =
  | { ok: true; userId: string; email: string }
  | { ok: false; response: NextResponse };

/**
 * Verify the caller is an admin. Pass the incoming Request so we can
 * read the Privy headers off it.
 *
 * Returns 503 when the allowlist is empty (config error — refuse to
 * silently allow everyone). 401 on missing/invalid Privy token. 403
 * when the verified email isn't in the allowlist (or the token has
 * no verified email, which usually means the client forgot to send
 * the X-Privy-Id-Token header).
 */
export async function requireAdminSession(
  req: Request,
): Promise<AdminSessionResult> {
  const adminEmails = getAdminEmailSet();
  if (adminEmails.size === 0) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "PRIVY_ADMIN_EMAILS not configured" },
        { status: 503 },
      ),
    };
  }

  const auth = await verifyPrivyAuth(req);
  if (!auth.ok) {
    // Distinguish the two 503 paths the caller cares about — Privy
    // server SDK unconfigured vs allowlist unconfigured (handled above)
    // — so the admin page can tell the operator which env var to set.
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

  if (auth.emails.length === 0) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error:
            "Privy session has no verified email — make sure the client sends X-Privy-Id-Token",
        },
        { status: 403 },
      ),
    };
  }

  // Any-match: a Privy user can have multiple linked emails (direct
  // + Google OAuth + Apple OAuth). Accept if ANY of them is on the
  // allowlist. Otherwise surface the full list so the operator can
  // see exactly what Privy associates with their session.
  const matched = auth.emails.find((e) => adminEmails.has(e)) ?? null;
  if (!matched) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: `Signed in as ${auth.emails.join(", ")} — none of these is on PRIVY_ADMIN_EMAILS. Add one, or sign in with an allowlisted email.`,
        },
        { status: 403 },
      ),
    };
  }

  return { ok: true, userId: auth.userId, email: matched };
}
