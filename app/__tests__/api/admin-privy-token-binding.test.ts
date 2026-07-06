/**
 * Regression coverage for #2206.
 *
 * The admin gate must not combine the authenticated Privy DID from one
 * access token with linked email attributes from another user's identity token.
 *
 * Exercised via requireAdminSession() (app/lib/admin-session.ts), the actual
 * caller of verifyPrivyAuth() (app/lib/privy-auth.ts) in this branch — the
 * marketing-site /api/admin/whoami route this regression was originally filed
 * against isn't part of the playground (devnet trading app) tree, but the
 * shared auth helper it called from is, and is still live (gates every
 * /api/admin/* route via the middleware's admin matcher).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const privy = vi.hoisted(() => ({
  verifyAccessToken: vi.fn(),
  verifyIdentityToken: vi.fn(),
}));

vi.mock("@privy-io/node", () => ({
  PrivyClient: class MockPrivyClient {
    utils() {
      return {
        auth: () => ({
          verifyAccessToken: privy.verifyAccessToken,
          verifyIdentityToken: privy.verifyIdentityToken,
        }),
      };
    }
  },
}));

const ATTACKER_DID = "did:privy:attacker";
const ADMIN_DID = "did:privy:administrator";
const ADMIN_EMAIL = "admin@example.test";

function accessClaims(userId: string) {
  return { user_id: userId };
}

function identityUser(id: string, email: string) {
  return {
    id,
    created_at: 0,
    has_accepted_terms: false,
    is_guest: false,
    linked_accounts: [
      {
        type: "email",
        address: email,
        first_verified_at: null,
        latest_verified_at: null,
        verified_at: 0,
      },
    ],
    mfa_methods: [],
  };
}

async function callRequireAdminSession(accessToken: string, identityToken?: string) {
  const { requireAdminSession } = await import("@/lib/admin-session");

  const headers = new Headers({
    authorization: `Bearer ${accessToken}`,
  });

  if (identityToken) {
    headers.set("x-privy-id-token", identityToken);
  }

  return requireAdminSession(
    new Request("http://localhost/api/admin/whoami", {
      method: "GET",
      headers,
    }),
  );
}

describe("admin Privy token subject binding", () => {
  beforeEach(() => {
    vi.resetModules();
    privy.verifyAccessToken.mockReset();
    privy.verifyIdentityToken.mockReset();

    process.env.NEXT_PUBLIC_PRIVY_APP_ID = "test-app-id";
    process.env.PRIVY_APP_SECRET = "test-app-secret";
    process.env.PRIVY_ADMIN_DIDS = "";
    process.env.PRIVY_ADMIN_EMAILS = ADMIN_EMAIL;
  });

  it("rejects a non-admin access token without an identity token", async () => {
    privy.verifyAccessToken.mockResolvedValue(accessClaims(ATTACKER_DID));

    const result = await callRequireAdminSession("attacker-access-token");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
    expect(privy.verifyIdentityToken).not.toHaveBeenCalled();
  });

  it("accepts matching admin access and identity tokens", async () => {
    privy.verifyAccessToken.mockResolvedValue(accessClaims(ADMIN_DID));
    privy.verifyIdentityToken.mockResolvedValue(
      identityUser(ADMIN_DID, ADMIN_EMAIL),
    );

    const result = await callRequireAdminSession(
      "admin-access-token",
      "admin-identity-token",
    );

    expect(result).toEqual({
      ok: true,
      userId: ADMIN_DID,
      email: ADMIN_EMAIL,
    });
  });

  it("rejects when identity token verification fails", async () => {
    privy.verifyAccessToken.mockResolvedValue(accessClaims(ADMIN_DID));
    privy.verifyIdentityToken.mockRejectedValue(new Error("invalid signature"));

    const result = await callRequireAdminSession(
      "admin-access-token",
      "bad-identity-token",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      expect(await result.response.json()).toEqual({
        error: "Session expired or invalid — sign in again",
      });
    }
  });

  it("still permits DID-based admin authorization without an identity token", async () => {
    process.env.PRIVY_ADMIN_DIDS = ADMIN_DID;
    process.env.PRIVY_ADMIN_EMAILS = "";

    privy.verifyAccessToken.mockResolvedValue(accessClaims(ADMIN_DID));

    const result = await callRequireAdminSession("admin-access-token");

    expect(result).toEqual({
      ok: true,
      userId: ADMIN_DID,
      email: null,
    });
    expect(privy.verifyIdentityToken).not.toHaveBeenCalled();
  });
});
