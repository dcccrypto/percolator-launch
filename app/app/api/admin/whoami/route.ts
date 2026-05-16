import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/whoami
 *
 * Tiny endpoint the /admin page calls on mount to decide whether to
 * render the dashboard or bounce to /admin/login. Returns the
 * verified email + Privy DID when the caller is in the allowlist.
 *
 * Response shapes:
 *   200 { ok: true, email, userId }       — admin, render dashboard
 *   401 { error: "..." }                   — no Privy session, send to login
 *   403 { error: "Forbidden" }             — logged in but not an admin
 *   503 { error: "..." }                   — server misconfig (no allowlist or no Privy secret)
 */
export async function GET(req: Request) {
  const auth = await requireAdminSession(req);
  if (!auth.ok) return auth.response;
  return NextResponse.json({
    ok: true,
    email: auth.email,
    userId: auth.userId,
  });
}
