import { PrivyClient } from "@privy-io/server-auth";

/**
 * Server-side Privy auth helper.
 *
 * Verifies the access token from the `Authorization: Bearer …` header
 * (security boundary — proves the request came from a valid Privy
 * session). If an `X-Privy-Id-Token` header is also present, parses it
 * locally to extract linked accounts (email, wallets) without making a
 * Privy API call. Falls back to `getUser(userId)` (rate-limited) when
 * the id-token isn't supplied.
 *
 * Returns a flat shape so route handlers don't need to know about
 * Privy's LinkedAccount discriminated union — they just want the email
 * and a list of solana addresses.
 */

const APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim();
const APP_SECRET = process.env.PRIVY_APP_SECRET?.trim();

let _client: PrivyClient | null = null;

function getClient(): PrivyClient | null {
  if (_client) return _client;
  if (!APP_ID || !APP_SECRET) return null;
  _client = new PrivyClient(APP_ID, APP_SECRET);
  return _client;
}

export interface PrivyAuthResult {
  userId: string; // Privy DID, e.g. "did:privy:cl…"
  email: string | null; // lowercased
  solanaWallets: string[]; // base58 pubkeys
}

export type PrivyAuthError =
  | { ok: false; status: 401; reason: "missing-token" | "invalid-token" }
  | { ok: false; status: 503; reason: "not-configured" };

export type PrivyAuthOk = { ok: true } & PrivyAuthResult;

/**
 * Verify a Privy session from the request headers.
 *
 *  Authorization: Bearer <accessToken>     (required — security boundary)
 *  X-Privy-Id-Token: <idToken>              (optional — avoids rate-limited API call)
 *
 * Returns the verified DID plus best-effort linked email + Solana wallets.
 * Both lookup branches (id-token parse vs server-side getUser) yield
 * the same shape; callers shouldn't have to care which path served.
 */
export async function verifyPrivyAuth(
  req: Request,
): Promise<PrivyAuthOk | PrivyAuthError> {
  const client = getClient();
  if (!client) {
    return { ok: false, status: 503, reason: "not-configured" };
  }

  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  if (!token) {
    return { ok: false, status: 401, reason: "missing-token" };
  }

  let userId: string;
  try {
    const claims = await client.verifyAuthToken(token);
    userId = claims.userId;
  } catch (err) {
    console.warn("[privy-auth] verify failed", err);
    return { ok: false, status: 401, reason: "invalid-token" };
  }

  // Try the id-token fast path first; fall back to the deprecated
  // getUser(userId) only if the client didn't supply one. Both yield
  // the same User shape.
  const idToken = req.headers.get("x-privy-id-token")?.trim() ?? "";
  let user: Awaited<ReturnType<typeof client.getUser>> | null = null;
  try {
    if (idToken) {
      user = await client.getUser({ idToken });
    } else {
      user = await client.getUser(userId);
    }
  } catch (err) {
    // If id-token parse fails, retry against the API one time so we
    // still return useful claims rather than refusing the request.
    console.warn("[privy-auth] getUser failed, retrying via userId", err);
    try {
      user = await client.getUser(userId);
    } catch (err2) {
      console.warn("[privy-auth] getUser retry also failed — returning DID only", err2);
    }
  }

  const email = extractEmail(user);
  const solanaWallets = extractSolanaWallets(user);

  return { ok: true, userId, email, solanaWallets };
}

function extractEmail(user: Awaited<ReturnType<PrivyClient["getUser"]>> | null): string | null {
  if (!user) return null;
  // The User object exposes a top-level `email` for the primary email
  // account, plus linked Email/Google/etc accounts. We want the address
  // they actually used — prefer the primary, then any linked email,
  // then any oauth provider that exposes an email.
  const accounts = user.linkedAccounts ?? [];
  for (const a of accounts) {
    if (a.type === "email" && "address" in a && typeof a.address === "string") {
      return a.address.toLowerCase();
    }
  }
  for (const a of accounts) {
    if (
      (a.type === "google_oauth" || a.type === "apple_oauth") &&
      "email" in a &&
      typeof a.email === "string"
    ) {
      return a.email.toLowerCase();
    }
  }
  return null;
}

function extractSolanaWallets(
  user: Awaited<ReturnType<PrivyClient["getUser"]>> | null,
): string[] {
  if (!user) return [];
  const out: string[] = [];
  for (const a of user.linkedAccounts ?? []) {
    // Privy types its wallet entries as `wallet` with a `chainType` field.
    if (a.type === "wallet" && "chainType" in a && a.chainType === "solana") {
      if ("address" in a && typeof a.address === "string") {
        out.push(a.address);
      }
    }
  }
  return out;
}
