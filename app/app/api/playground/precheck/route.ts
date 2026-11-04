/**
 * POST /api/playground/precheck { email } -> { onList: boolean }
 *
 * Asked before the gate page sends a Privy email code, so a code is only sent to an address that
 * is on the waitlist (product decision 2026-10-02). It reads the waitlist database directly. Any
 * row for the email counts: a legacy row without a referral code is given one by the gate once the
 * code proves the address (lib/playground-gate), so it must not be refused here first.
 *
 * Trade-off, accepted: this answers "is this email on the list?". Mitigations: strict per-IP
 * rate limit, no position, id or any other field returned, and logs never carry the email. A
 * rate-limited caller gets 429 `{ onList: false, limited: true }` whatever the email, so the page
 * can say "wait" instead of telling a member they are not on the list; that answer does not depend
 * on the email, so it reveals nothing about membership. Entry is still decided only by the
 * authenticated gate (/api/playground/authorize, /enter) — this is a UX filter, not access.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getWaitlistServiceSupabase } from "@/lib/waitlist/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 8;
const hits = new Map<string, { n: number; reset: number }>();

function limited(ip: string): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || h.reset <= now) {
    hits.set(ip, { n: 1, reset: now + WINDOW_MS });
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
    return false;
  }
  h.n += 1;
  return h.n > MAX_PER_WINDOW;
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const answer = (onList: boolean) =>
  NextResponse.json({ onList }, { headers: { "Cache-Control": "no-store" } });

export async function POST(req: NextRequest) {
  const ip = (req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0] ?? "").trim() || "unknown";
  if (limited(ip)) {
    return NextResponse.json({ onList: false, limited: true }, { status: 429, headers: { "Cache-Control": "no-store" } });
  }
  let email = "";
  try {
    const body = (await req.json()) as { email?: unknown };
    email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  } catch {
    return answer(false);
  }
  if (!EMAIL_RE.test(email)) return answer(false);
  try {
    const escaped = email.replace(/[\\%_]/g, (c) => `\\${c}`);
    const { data, error } = await getWaitlistServiceSupabase()
      .from("waitlist")
      .select("id")
      .ilike("email", escaped)
      .limit(1)
      .maybeSingle();
    if (error) {
      console.warn("[playground/precheck] lookup failed");
      // Fail OPEN for the UX filter only: a DB blip must not stop a member from getting a code.
      // Access itself is still decided by the authenticated gate.
      return NextResponse.json({ onList: true, unverified: true }, { headers: { "Cache-Control": "no-store" } });
    }
    return answer(Boolean(data));
  } catch {
    return NextResponse.json({ onList: true, unverified: true }, { headers: { "Cache-Control": "no-store" } });
  }
}
