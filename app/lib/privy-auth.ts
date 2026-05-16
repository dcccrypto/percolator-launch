import { PrivyClient, type User, type LinkedAccount } from "@privy-io/node";

/**
 * Server-side Privy auth helper.
 *
 * Migrated from the deprecated @privy-io/server-auth to @privy-io/node.
 * The new SDK exposes verify helpers under `client.utils().auth()` and
 * uses snake_case field names on the User payload — both surface
 * differences are absorbed here so route handlers see the same flat
 * shape they always did.
 *
 * Verifies the access token from `Authorization: Bearer …` (security
 * boundary — proves the request came from a valid Privy session). When
 * an `X-Privy-Id-Token` header is also present, parses it locally to
 * extract linked accounts (email, wallets) — no Privy API call, so no
 * rate limit.
 */

const APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim();
const APP_SECRET = process.env.PRIVY_APP_SECRET?.trim();

let _client: PrivyClient | null = null;

function getClient(): PrivyClient | null {
  if (_client) return _client;
  if (!APP_ID || !APP_SECRET) return null;
  _client = new PrivyClient({ appId: APP_ID, appSecret: APP_SECRET });
  return _client;
}

export interface PrivyAuthResult {
  userId: string; // Privy DID, e.g. "did:privy:cl…"
  email: string | null; // primary email (lowercased) — for storage/display
  emails: string[]; // ALL verified emails (lowercased) — for allowlist matching
  solanaWallets: string[]; // base58 pubkeys
}

export type PrivyAuthError =
  | { ok: false; status: 401; reason: "missing-token" | "invalid-token" }
  | { ok: false; status: 503; reason: "not-configured" };

export type PrivyAuthOk = { ok: true } & PrivyAuthResult;

/**
 * Verify a Privy session from request headers.
 *
 *   Authorization: Bearer <accessToken>   (required — security boundary)
 *   X-Privy-Id-Token: <idToken>            (optional — avoids API call)
 *
 * Returns the verified DID + best-effort linked email / Solana wallets.
 * When the id-token is absent, returns the DID only with empty arrays
 * (the new SDK doesn't offer a no-rate-limit getUser-by-id fallback;
 * the client should send the id-token whenever it wants linked data).
 */
export async function verifyPrivyAuth(
  req: Request,
): Promise<PrivyAuthOk | PrivyAuthError> {
  const client = getClient();
  if (!client) {
    return { ok: false, status: 503, reason: "not-configured" };
  }

  const auth = req.headers.get("authorization") ?? "";
  const accessToken = auth.startsWith("Bearer ")
    ? auth.slice("Bearer ".length).trim()
    : "";
  if (!accessToken) {
    return { ok: false, status: 401, reason: "missing-token" };
  }

  const authUtils = client.utils().auth();

  let userId: string;
  try {
    const claims = await authUtils.verifyAccessToken(accessToken);
    userId = claims.user_id;
  } catch (err) {
    console.warn("[privy-auth] verifyAccessToken failed", err);
    return { ok: false, status: 401, reason: "invalid-token" };
  }

  // Optional id-token parse for linked accounts. If absent or invalid
  // we return DID only — the caller can still match on privy_did, just
  // not on email/pubkey backfill.
  const idToken = req.headers.get("x-privy-id-token")?.trim() ?? "";
  let user: User | null = null;
  if (idToken) {
    try {
      user = await authUtils.verifyIdentityToken(idToken);
    } catch (err) {
      console.warn(
        "[privy-auth] verifyIdentityToken failed, returning DID only",
        err,
      );
    }
  }

  const emails = extractAllEmails(user);
  const solanaWallets = extractSolanaWallets(user);

  return {
    ok: true,
    userId,
    email: emails[0] ?? null,
    emails,
    solanaWallets,
  };
}

/**
 * Collects every verified email Privy has linked to the user — direct
 * email logins, Google/Apple OAuth emails, etc. Returns lowercased and
 * deduped. Callers that need any-match semantics (admin allowlist
 * check) should iterate this array, not the single-email field.
 */
function extractAllEmails(user: User | null): string[] {
  if (!user) return [];
  const accounts: LinkedAccount[] = user.linked_accounts ?? [];
  const seen = new Set<string>();
  for (const a of accounts) {
    if (a.type === "email" && "address" in a && typeof a.address === "string") {
      seen.add(a.address.toLowerCase());
    } else if (
      (a.type === "google_oauth" || a.type === "apple_oauth") &&
      "email" in a &&
      typeof a.email === "string"
    ) {
      seen.add(a.email.toLowerCase());
    }
  }
  return [...seen];
}

function extractSolanaWallets(user: User | null): string[] {
  if (!user) return [];
  const accounts: LinkedAccount[] = user.linked_accounts ?? [];
  const out: string[] = [];
  for (const a of accounts) {
    if (
      a.type === "wallet" &&
      "chain_type" in a &&
      a.chain_type === "solana" &&
      "address" in a &&
      typeof a.address === "string"
    ) {
      out.push(a.address);
    }
  }
  return out;
}
