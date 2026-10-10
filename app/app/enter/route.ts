/**
 * /enter — the playground's half of the devnet v2 waitlist handoff.
 * Logic + contract: lib/playground-enter.ts. Ops: docs/PLAYGROUND-ACCESS.md.
 */
import { NextResponse, type NextRequest } from "next/server";
import { Redis } from "@upstash/redis";
import {
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
  decideEnter,
  memoryReplayGuard,
  type ReplayGuard,
} from "@/lib/playground-enter";

export const dynamic = "force-dynamic";

const memoryGuard = memoryReplayGuard();
let redis: Redis | null | undefined;

function getRedis(): Redis | null {
  if (redis !== undefined) return redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  try {
    redis = url && token ? new Redis({ url, token }) : null;
  } catch {
    redis = null;
  }
  return redis;
}

/**
 * Cross-instance single use via Redis SET NX when configured; otherwise (or on
 * a Redis error) the per-instance memory guard. Falling back rather than
 * refusing is deliberate: replay is already bounded by the 90s token life, and
 * a Redis blip must not lock the cohort out.
 */
const replayGuard: ReplayGuard = async (mac, ttl) => {
  const r = getRedis();
  if (r) {
    try {
      const res = await r.set(`pg:handoff:${mac}`, 1, { nx: true, ex: ttl });
      return res === "OK";
    } catch {
      /* fall through */
    }
  }
  return memoryGuard(mac, ttl);
};

function finish(req: NextRequest, cookie: string | null): NextResponse {
  const res = NextResponse.redirect(new URL(cookie ? "/?signin=1" : "/locked", req.url), { status: 303 });
  if (cookie) res.cookies.set(SESSION_COOKIE, cookie, SESSION_COOKIE_OPTIONS);
  // The token rode in on this request; do not let it leak onward or be cached.
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}

async function handle(req: NextRequest, token: string | null, team: string | null, judge: string | null = null) {
  const result = await decideEnter({ token, team, judge }, process.env, replayGuard);
  if (!result.ok) {
    // No token, identifier or reason in logs — only that a refusal happened.
    console.warn("[playground/enter] refused");
    return finish(req, null);
  }
  return finish(req, result.cookie);
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  // "t" is what percolator.trade sends (main lib/playground-access.ts HANDOFF_PARAM).
  return handle(req, q.get("t") ?? q.get("token") ?? q.get("h"), q.get("team"), q.get("judge"));
}

export async function POST(req: NextRequest) {
  let form: FormData | null = null;
  try {
    form = await req.formData();
  } catch {
    form = null;
  }
  const str = (k: string) => {
    const v = form?.get(k);
    return typeof v === "string" ? v : null;
  };
  return handle(req, str("token") ?? str("h"), str("team"), str("judge"));
}
