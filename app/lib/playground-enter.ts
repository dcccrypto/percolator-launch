/**
 * /enter — exchange a percolator.trade handoff (or the team bypass secret) for
 * this app's own session cookie. Kept out of the route file so it can be unit
 * tested without the Next.js request pipeline.
 *
 * Contract with the gate (percolator.trade/playground):
 *   GET  /enter?token=<handoff>                     (also accepts ?h=)
 *   POST /enter   form field `token` (or `h`)       (keeps the token out of URLs/logs)
 *   GET  /enter?team=<PLAYGROUND_TEAM_BYPASS_SECRET> (team only — see docs/PLAYGROUND-ACCESS.md)
 *
 * Success → 303 to "/" with Set-Cookie pg_access (HttpOnly; Secure; SameSite=Lax;
 * Path=/; Max-Age=86400). Anything else → 303 to "/locked", with no reason given
 * (an attacker must not learn whether a token was expired, forged or over cutoff).
 */
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  HANDOFF_TTL_SECONDS,
  TEAM_SUB_PREFIX,
  accessSecret,
  cohortCutoff,
  isWithinCohort,
  mintSession,
  readHandoff,
  teamBypassSecret,
  teamFingerprint,
  teamSecretMatches,
} from "@/lib/playground-access";

export interface EnterInput {
  /** Handoff token presented (query or form), if any. */
  token: string | null;
  /** Team bypass secret presented, if any. */
  team: string | null;
}

export type EnterResult =
  | { ok: true; cookie: string; kind: "handoff" | "team" }
  | { ok: false };

/**
 * Single-use guard for handoff tokens. Returns true the FIRST time a given
 * token is seen (within its lifetime) and false on a replay.
 */
export type ReplayGuard = (tokenMac: string, ttlSeconds: number) => Promise<boolean>;

/** Per-instance best-effort replay guard — the fallback when Redis is absent. */
export function memoryReplayGuard(nowMs: () => number = Date.now): ReplayGuard {
  const seen = new Map<string, number>();
  return async (mac, ttl) => {
    const now = nowMs();
    for (const [k, until] of seen) if (until <= now) seen.delete(k);
    if (seen.has(mac)) return false;
    seen.set(mac, now + ttl * 1000);
    return true;
  };
}

export async function decideEnter(
  input: EnterInput,
  env: Record<string, string | undefined>,
  replayGuard: ReplayGuard,
  nowMs = Date.now(),
): Promise<EnterResult> {
  const secret = accessSecret(env);
  // Unset / short access secret: refuse everyone, team included — there is
  // nothing to sign a session with, and a default would be a public key.
  if (!secret) return { ok: false };

  if (input.team) {
    const team = teamBypassSecret(env);
    if (!team || !(await teamSecretMatches(input.team, team))) return { ok: false };
    const sub = TEAM_SUB_PREFIX + (await teamFingerprint(team));
    return { ok: true, kind: "team", cookie: await mintSession(sub, 1, secret, nowMs) };
  }

  const claims = await readHandoff(input.token, secret, nowMs);
  if (!claims) return { ok: false };
  // A handoff can never mint a team session.
  if (claims.sub.startsWith(TEAM_SUB_PREFIX)) return { ok: false };
  if (!isWithinCohort(claims.pos, cohortCutoff(env.PLAYGROUND_COHORT_CUTOFF))) return { ok: false };

  // One-time use: the MAC half uniquely identifies the token. TTL = the most a
  // token can still live, so the guard never needs to outlive it.
  const mac = (input.token as string).slice((input.token as string).indexOf(".") + 1);
  const remaining = Math.max(1, Math.min(HANDOFF_TTL_SECONDS, claims.exp - Math.floor(nowMs / 1000)));
  if (!(await replayGuard(mac, remaining))) return { ok: false };

  return { ok: true, kind: "handoff", cookie: await mintSession(claims.sub, claims.pos, secret, nowMs, claims.ref) };
}

/** Cookie attributes for the session. Host-only (no Domain) on purpose. */
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: SESSION_TTL_SECONDS,
};

export { SESSION_COOKIE };
