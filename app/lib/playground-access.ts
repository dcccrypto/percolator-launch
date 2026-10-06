/**
 * Playground access control — the one definition of "may this person enter?".
 *
 * Devnet v2 opens to the waitlist in position order, and the gate has to hold
 * against someone simply typing the playground URL. That is the whole problem:
 * the gate page lives on percolator.trade (`main`) and the app lives on
 * play.percolator.trade (`playground`; formerly percolator-playground.vercel.app) — two hosts, so
 * a cookie set by the gate is INVISIBLE to the app. A redirect alone gates
 * nothing.
 *
 * So entry is two steps, and this module is the contract both sides share:
 *
 *   1. HANDOFF. The gate verifies the visitor (Privy → waitlist row → position)
 *      and mints a short-lived signed token naming them. It travels in the
 *      redirect URL, so it is deliberately tiny and deliberately brief.
 *   2. SESSION. The app verifies that token's signature, then sets its OWN
 *      HttpOnly cookie on its OWN domain. Every later request is checked by
 *      middleware against that cookie.
 *
 * Both steps are HMAC-SHA256 over a server-only secret, so a token or cookie
 * cannot be forged by anyone who cannot read the environment. Nothing here
 * trusts a value supplied by the browser beyond its signature.
 *
 * If the playground ever moves to playground.percolator.trade, step 1 becomes
 * unnecessary — a cookie on `.percolator.trade` would cover both — and this
 * module should lose the handoff half rather than keep it for its own sake.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Separator that cannot appear in base64url, so fields cannot be smuggled. */
const SEP = ".";

/**
 * How long a handoff token is valid. Seconds, not minutes: it exists only to
 * survive one redirect, and a short life is most of what stops it being
 * replayed out of a shared URL or a referrer log.
 */
export const HANDOFF_TTL_SECONDS = 90;

/** How long a session lasts before the visitor re-verifies. */
export const SESSION_TTL_SECONDS = 24 * 60 * 60;

/** Cookie the playground sets on its own domain once a handoff is accepted. */
export const SESSION_COOKIE = "pg_access";

export interface AccessClaims {
  /** Stable waitlist row id — NOT a wallet or an email. See `subjectOf`. */
  sub: string;
  /** Waitlist position at the moment of verification. */
  pos: number;
  /** Unix seconds after which this is refused. */
  exp: number;
  /**
   * The visitor's referral code, so the playground can show it without reading the waitlist DB.
   * Optional: older tokens lack it, and `open` checks only sub / pos / exp.
   */
  ref?: string;
}

const b64url = (b: Buffer): string => b.toString("base64url");

function sign(payload: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(payload).digest());
}

/**
 * Constant-time compare that cannot throw on a length mismatch.
 *
 * `timingSafeEqual` throws when the buffers differ in length, and a throw is
 * itself an oracle — it separates "wrong length" from "wrong bytes" by timing
 * and by control flow. Hashing both sides first makes every comparison the
 * same width, which is the trick `lib/api-auth.ts` already uses here.
 */
function safeEqual(a: string, b: string): boolean {
  const ha = createHmac("sha256", "cmp").update(a).digest();
  const hb = createHmac("sha256", "cmp").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Encode + sign. Shared by both token kinds; `secret` is what separates them. */
function mint(claims: AccessClaims, secret: string): string {
  const body = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  return `${body}${SEP}${sign(body, secret)}`;
}

/**
 * Verify + decode, or null. Never throws, and never says WHY it failed —
 * callers must not be able to distinguish a bad signature from an expired
 * token, because the difference tells an attacker which half to work on.
 */
function open(token: string | null | undefined, secret: string, now: number): AccessClaims | null {
  if (!token) return null;
  const cut = token.indexOf(SEP);
  if (cut <= 0 || cut === token.length - 1) return null;
  const body = token.slice(0, cut);
  const mac = token.slice(cut + 1);
  if (!safeEqual(mac, sign(body, secret))) return null;
  let claims: AccessClaims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as AccessClaims;
  } catch {
    return null;
  }
  if (typeof claims?.sub !== "string" || !claims.sub) return null;
  if (typeof claims.pos !== "number" || !Number.isFinite(claims.pos)) return null;
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) return null;
  if (now >= claims.exp) return null;
  return claims;
}

/**
 * The two secrets are DIFFERENT derivations of one configured value, so a
 * handoff token can never be presented as a session cookie or vice versa.
 * Same secret for both would make a 90-second token usable for 24 hours.
 */
const handoffSecret = (base: string): string => `${base}:handoff:v1`;
const sessionSecret = (base: string): string => `${base}:session:v1`;

export function mintHandoff(sub: string, pos: number, secret: string, nowMs = Date.now(), ref?: string): string {
  const now = Math.floor(nowMs / 1000);
  return mint({ sub, pos, exp: now + HANDOFF_TTL_SECONDS, ...(ref ? { ref } : {}) }, handoffSecret(secret));
}

export function readHandoff(token: string | null | undefined, secret: string, nowMs = Date.now()): AccessClaims | null {
  return open(token, handoffSecret(secret), Math.floor(nowMs / 1000));
}

export function mintSession(sub: string, pos: number, secret: string, nowMs = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  return mint({ sub, pos, exp: now + SESSION_TTL_SECONDS }, sessionSecret(secret));
}

export function readSession(token: string | null | undefined, secret: string, nowMs = Date.now()): AccessClaims | null {
  return open(token, sessionSecret(secret), Math.floor(nowMs / 1000));
}

/**
 * Whether a position is inside the opening cohort.
 *
 * `position` is `row_number() over (order by created_at asc, id asc)` from the
 * `waitlist_position` RPC — the SAME number the member already sees on the
 * waitlist page. Deriving a second ordering here would mean a person reading
 * "#812" is told they are not in the first 1000.
 *
 * A null position means the lookup failed or the row is not on the waitlist;
 * both are refusals. Fail CLOSED — an outage must not open the door.
 */
export function isWithinCohort(position: number | null | undefined, cutoff: number): boolean {
  if (position == null || !Number.isFinite(position)) return false;
  if (!Number.isFinite(cutoff) || cutoff <= 0) return false;
  return position >= 1 && position <= cutoff;
}

/** Cutoff from the environment, defaulting to the announced first 1000. */
export function cohortCutoff(raw: string | undefined = process.env.PLAYGROUND_COHORT_CUTOFF): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1000;
}

/**
 * The shared secret, or null when unset.
 *
 * Null must make every verification FAIL rather than pass — a missing
 * environment variable is the most likely way this gets deployed open, so it
 * is the case worth being loudest about. Callers check for null explicitly;
 * this never substitutes a default.
 */
export function accessSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const s = env.PLAYGROUND_ACCESS_SECRET;
  return typeof s === "string" && s.length >= 32 ? s : null;
}

// ── Launch switch + where the app lives ─────────────────────────────────────
//
// Both are SERVER-ONLY environment variables (never NEXT_PUBLIC_). The
// playground's address is emitted by exactly one place — the Location header of
// /api/playground/enter, after a fresh server-side grant — so it never appears
// in a client bundle or in markup served to someone who has not been admitted.

/** Default deployment of the devnet v2 app (Vercel project percolator-playground). */
const DEFAULT_PLAYGROUND_APP_URL = "https://play.percolator.trade";

/** Path on the playground app that exchanges a handoff token for a session. */
export const ENTER_PATH = "/enter";

/** Query parameter that carries the handoff token to ENTER_PATH. */
export const HANDOFF_PARAM = "t";

/**
 * Whether entry is open. Only the exact string "true" opens it: "1", "yes",
 * " true", an empty value and an unset variable all keep the door shut, so a
 * typo fails closed rather than open.
 */
export function playgroundOpen(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PLAYGROUND_OPEN === "true";
}

/**
 * Origin of the playground app, or null when PLAYGROUND_APP_URL is set to
 * something unusable. Unset means the default deployment. Anything that is not
 * an https origin (http is tolerated for localhost only, for local testing) is
 * refused rather than "fixed": redirecting a freshly minted token to a mistyped
 * host would hand it to whoever owns that host.
 */
export function playgroundAppUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.PLAYGROUND_APP_URL?.trim();
  if (!raw) return DEFAULT_PLAYGROUND_APP_URL;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
  if (u.username || u.password) return null;
  // Origin only: a path, query or fragment in the variable is a configuration
  // mistake, and silently keeping it would put the token somewhere unexpected.
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) return null;
  return u.origin;
}

/** `${origin}/enter?t=<token>` — the only URL a handoff token is ever sent to. */
export function playgroundEntryUrl(origin: string, token: string): string {
  const u = new URL(ENTER_PATH, origin);
  u.searchParams.set(HANDOFF_PARAM, token);
  return u.toString();
}
