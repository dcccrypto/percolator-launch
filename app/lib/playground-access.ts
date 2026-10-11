/**
 * Playground access control — the VERIFY side of the devnet v2 waitlist lock.
 *
 * Devnet v2 is open to the first 1,000 waitlist positions. The gate that
 * decides who those are lives on percolator.trade (branch `main`,
 * app/lib/playground-access.ts + POST /api/playground/authorize, originally
 * written by @0x-SquidSol in #2732). This app lives on a different registrable
 * domain, so a cookie set by the gate is invisible here. Entry is two steps:
 *
 *   1. HANDOFF. The gate verifies the visitor (Privy → waitlist row → position)
 *      and mints a ~90s signed token. The browser carries it to /enter here.
 *   2. SESSION. /enter verifies the handoff and sets this app's OWN HttpOnly
 *      cookie (SESSION_COOKIE). middleware.ts checks that cookie on every
 *      request while PLAYGROUND_GATE_ENABLED is "true".
 *
 * WIRE FORMAT — must stay byte-compatible with the gate's mint side:
 *
 *   token  = b64url(JSON.stringify({ sub, pos, exp })) + "." + b64url(mac)
 *   mac    = HMAC-SHA256(key = utf8(derivedSecret), msg = utf8(<b64url body>))
 *   handoff derivedSecret = `${PLAYGROUND_ACCESS_SECRET}:handoff:v1`  (TTL 90s)
 *   session derivedSecret = `${PLAYGROUND_ACCESS_SECRET}:session:v1`  (TTL 24h)
 *   b64url = RFC 4648 §5, no padding (Node's Buffer "base64url")
 *
 * The two derivations are what make a handoff unusable as a session and vice
 * versa. __tests__/lib/playground-access-compat.test.ts mints with a verbatim
 * copy of the gate's Node code and verifies here, in both directions.
 *
 * This module is Web Crypto only (no `node:*` imports) because middleware.ts
 * runs on the Edge runtime and Vercel's edge validator rejects any Node module
 * that leaks into that bundle (see the long note at the top of middleware.ts).
 * The cost is that everything is async.
 */

/** Separator that cannot appear in base64url, so fields cannot be smuggled. */
const SEP = ".";

export const HANDOFF_TTL_SECONDS = 90;
export const SESSION_TTL_SECONDS = 24 * 60 * 60;

/** Cookie this app sets on its own domain once a handoff is accepted. */
export const SESSION_COOKIE = "pg_access";

/** Default size of the opening cohort ("the first 1,000 on the waitlist"). */
export const DEFAULT_COHORT_CUTOFF = 1000;

/** Prefix on the `sub` of a session minted through the team bypass. */
export const TEAM_SUB_PREFIX = "team:";

export interface AccessClaims {
  /** Stable waitlist row id (never a wallet or email), or `team:<fp>`. */
  sub: string;
  /** Waitlist position at the moment of verification. */
  pos: number;
  /** Unix seconds after which this is refused. */
  exp: number;
  /** The visitor's referral code, when the gate sent one (older handoffs don't). */
  ref?: string;
}

/** A referral code as the waitlist issues them: short, URL-safe. Anything else is dropped. */
const REF_RE = /^[A-Za-z0-9_-]{1,32}$/;

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strict base64url → bytes; null on anything that is not base64url. */
function b64urlToBytes(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmacB64url(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return bytesToB64url(new Uint8Array(mac));
}

/**
 * Constant-time string compare. Length is not secret (a SHA-256 MAC is always
 * 43 b64url chars), so an early length mismatch leaks nothing useful.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function mint(claims: AccessClaims, secret: string): Promise<string> {
  const body = bytesToB64url(enc.encode(JSON.stringify(claims)));
  return `${body}${SEP}${await hmacB64url(secret, body)}`;
}

/** Verify + decode, or null. Never throws and never says why it failed. */
async function open(
  token: string | null | undefined,
  secret: string,
  nowSec: number,
): Promise<AccessClaims | null> {
  if (!token || typeof token !== "string" || token.length > 2048) return null;
  const cut = token.indexOf(SEP);
  if (cut <= 0 || cut === token.length - 1) return null;
  const body = token.slice(0, cut);
  const mac = token.slice(cut + 1);
  let expected: string;
  try {
    expected = await hmacB64url(secret, body);
  } catch {
    return null;
  }
  if (!constantTimeEqual(mac, expected)) return null;
  const raw = b64urlToBytes(body);
  if (!raw) return null;
  let claims: AccessClaims;
  try {
    claims = JSON.parse(dec.decode(raw)) as AccessClaims;
  } catch {
    return null;
  }
  if (typeof claims?.sub !== "string" || !claims.sub) return null;
  if (typeof claims.pos !== "number" || !Number.isFinite(claims.pos)) return null;
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) return null;
  if (nowSec >= claims.exp) return null;
  // Optional and never a reason to refuse: an odd value is dropped, the token still opens.
  const { ref, ...rest } = claims;
  return typeof ref === "string" && REF_RE.test(ref) ? { ...rest, ref } : rest;
}

// Same derivations as the gate. Changing either string here (or there) breaks
// every in-flight token — bump BOTH sides to :v2 together.
const handoffSecret = (base: string): string => `${base}:handoff:v1`;
const sessionSecret = (base: string): string => `${base}:session:v1`;

const toSec = (ms: number): number => Math.floor(ms / 1000);

export function readHandoff(
  token: string | null | undefined,
  secret: string,
  nowMs = Date.now(),
): Promise<AccessClaims | null> {
  return open(token, handoffSecret(secret), toSec(nowMs));
}

export function mintSession(sub: string, pos: number, secret: string, nowMs = Date.now(), ref?: string): Promise<string> {
  return mint({ sub, pos, exp: toSec(nowMs) + SESSION_TTL_SECONDS, ...(ref ? { ref } : {}) }, sessionSecret(secret));
}

export function readSession(
  token: string | null | undefined,
  secret: string,
  nowMs = Date.now(),
): Promise<AccessClaims | null> {
  return open(token, sessionSecret(secret), toSec(nowMs));
}

/** Inside the opening cohort? Null / non-finite / <1 are refusals (fail closed). */
export function isWithinCohort(position: number | null | undefined, cutoff: number): boolean {
  if (position == null || !Number.isFinite(position)) return false;
  if (!Number.isFinite(cutoff) || cutoff <= 0) return false;
  return position >= 1 && position <= cutoff;
}

/** Cutoff from the environment, defaulting to the announced first 1,000. */
export function cohortCutoff(raw: string | undefined = process.env.PLAYGROUND_COHORT_CUTOFF): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_COHORT_CUTOFF;
}

/** The shared secret (>= 32 chars), or null — and null must REFUSE everyone. */
export function accessSecret(env: Record<string, string | undefined> = process.env): string | null {
  const s = env.PLAYGROUND_ACCESS_SECRET;
  return typeof s === "string" && s.length >= 32 ? s : null;
}

/** The team bypass secret (>= 32 chars), or null — null disables the bypass. */
export function teamBypassSecret(env: Record<string, string | undefined> = process.env): string | null {
  const s = env.PLAYGROUND_TEAM_BYPASS_SECRET;
  return typeof s === "string" && s.length >= 32 ? s : null;
}

/** The kill switch: the gate enforces only when this is exactly "true". */
export function gateEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.PLAYGROUND_GATE_ENABLED ?? "").trim() === "true";
}

/**
 * Short, non-reversible fingerprint of the team secret, baked into team
 * sessions as `team:<fp>`. Rotating (or unsetting) PLAYGROUND_TEAM_BYPASS_SECRET
 * therefore revokes every team session immediately, without touching the
 * waitlist sessions signed by the same access secret.
 */
export async function teamFingerprint(teamSecret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(`pg-team-fp:v1:${teamSecret}`));
  return bytesToB64url(new Uint8Array(digest)).slice(0, 16);
}

/**
 * Is this session cookie good for entry right now?
 *
 * Checks the signature + expiry (readSession), then:
 *   - waitlist sessions: position still inside the CURRENT cutoff, so lowering
 *     PLAYGROUND_COHORT_CUTOFF takes effect on the next request;
 *   - team sessions: fingerprint matches the CURRENT team secret.
 */
export async function sessionGrantsAccess(
  token: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
  nowMs = Date.now(),
): Promise<boolean> {
  const secret = accessSecret(env);
  if (!secret) return false;
  const claims = await readSession(token, secret, nowMs);
  if (!claims) return false;
  if (claims.sub.startsWith(TEAM_SUB_PREFIX)) {
    const team = teamBypassSecret(env);
    if (!team) return false;
    return constantTimeEqual(claims.sub, TEAM_SUB_PREFIX + (await teamFingerprint(team)));
  }
  return isWithinCohort(claims.pos, cohortCutoff(env.PLAYGROUND_COHORT_CUTOFF));
}

/**
 * Constant-time check of a presented team secret. Both sides are hashed first
 * so the compare is always fixed-width and the configured length never leaks.
 */
export async function teamSecretMatches(presented: string | null | undefined, configured: string): Promise<boolean> {
  if (!presented) return false;
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(presented)),
    crypto.subtle.digest("SHA-256", enc.encode(configured)),
  ]);
  return constantTimeEqual(bytesToB64url(new Uint8Array(a)), bytesToB64url(new Uint8Array(b)));
}
