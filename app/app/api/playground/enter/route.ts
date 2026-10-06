/**
 * POST /api/playground/enter — the door.
 *
 * Submitted as an ordinary top-level form POST by the "Enter Playground"
 * button, carrying the visitor's Privy tokens as form fields
 * (`access_token`, optional `id_token`). It re-verifies everything from
 * scratch — the client's earlier verdict is never trusted — and then:
 *
 *   granted + PLAYGROUND_OPEN=true → 303 to `${PLAYGROUND_APP_URL}/enter?t=<handoff>`
 *   anything else                   → 303 to /playground on this host
 *
 * Every refusal is the SAME response (303 → /playground, no body, no reason),
 * whether the secret is unset, launch is closed, the Origin is foreign, the
 * Privy token is bad, the visitor is not a member, is past the cutoff, or a
 * lookup failed. The gate page then re-asks /authorize and explains.
 *
 * This Location header is the ONLY place the playground's address is ever
 * emitted, and only after a fresh grant.
 *
 * 303 rather than 302: the browser must follow with a GET, which 303 states
 * explicitly for a POST (302 does the same in every browser, by convention).
 */

import { NextResponse, type NextRequest } from "next/server";
import { verifyPrivyAuth } from "@/lib/privy-auth";
import { getWaitlistServiceSupabase } from "@/lib/waitlist/supabase";
import {
  accessSecret,
  mintHandoff,
  playgroundAppUrl,
  playgroundEntryUrl,
  playgroundOpen,
} from "@/lib/playground-access";
import { decidePlaygroundAccess } from "@/lib/playground-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function see(location: string): NextResponse {
  const res = new NextResponse(null, { status: 303 });
  res.headers.set("Location", location);
  res.headers.set("Cache-Control", "no-store");
  // The token rides in the Location URL; say nothing about it onward.
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}

/**
 * Same-origin check. The Privy token in the body already makes a cross-site
 * forgery useless (another site cannot read it), but an attacker could still
 * post THEIR OWN valid token from their own page and drop a victim into the
 * attacker's playground session. Requiring our own Origin closes that too.
 */
function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const back = () => see(new URL("/playground", req.url).toString());

  if (!sameOrigin(req)) return back();

  const secret = accessSecret();
  if (!secret) {
    console.error("[playground-enter] PLAYGROUND_ACCESS_SECRET unset or too short — refusing all");
    return back();
  }
  if (!playgroundOpen()) return back();
  const appUrl = playgroundAppUrl();
  if (!appUrl) {
    console.error("[playground-enter] PLAYGROUND_APP_URL is not a valid https origin — refusing all");
    return back();
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return back();
  }
  const accessToken = form.get("access_token");
  const idToken = form.get("id_token");
  // lib/privy-auth reads headers; hand it the form's tokens in that shape so
  // the verification path is byte-for-byte the one /authorize uses. With Privy HttpOnly cookies
  // the form may carry no token — the privy-token cookie on this request is used instead.
  const headers = new Headers();
  if (typeof accessToken === "string" && accessToken) headers.set("authorization", `Bearer ${accessToken}`);
  const cookie = req.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  if (typeof idToken === "string" && idToken) headers.set("x-privy-id-token", idToken);
  const auth = await verifyPrivyAuth(new Request(req.url, { method: "POST", headers }), { fetchUserIfNoIdToken: true });
  if (!auth.ok) return back();

  const verdict = await decidePlaygroundAccess(auth, getWaitlistServiceSupabase);
  if (verdict.kind !== "granted") return back();

  const token = mintHandoff(verdict.rowId, verdict.position, secret, Date.now(), verdict.referralCode ?? undefined);
  console.info(`[playground-enter] handoff minted for ${auth.userId}`);
  return see(playgroundEntryUrl(appUrl, token));
}
