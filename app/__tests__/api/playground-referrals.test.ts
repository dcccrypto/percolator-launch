// @vitest-environment node
/**
 * GET /api/playground/referrals returns a referral code only to the Privy login the gate verified, never
 * to whoever merely holds the `pg_access` cookie (the founder's review of #3191). Drives the real route
 * with real sessions; only Privy verification and the waitlist count fetch are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { JUDGE_SUB_PREFIX, SESSION_COOKIE, TEAM_SUB_PREFIX, mintSession, privyUserTag } from "@/lib/playground-access";

const SECRET = "s".repeat(40);
const DID = "did:privy:cm1owner000000000000";
const OTHER_DID = "did:privy:cm1someoneelse00000";

const auth = vi.hoisted(() => ({ result: null as unknown }));
vi.mock("@/lib/privy-auth", () => ({ verifyPrivyAuth: vi.fn(async () => auth.result) }));

const signedInAs = (userId: string) => {
  auth.result = { ok: true, userId, email: null, solanaWallets: [] };
};

async function sessionFor(ref?: string, did?: string, sub = "row-1"): Promise<string> {
  return mintSession(sub, 12, SECRET, Date.now(), ref, did ? await privyUserTag(did, SECRET) : undefined);
}

async function get(cookie?: string) {
  const { GET } = await import("@/app/api/playground/referrals/route");
  const headers: Record<string, string> = { authorization: "Bearer token" };
  if (cookie) headers.cookie = `${SESSION_COOKIE}=${cookie}`;
  const res = await GET(new NextRequest("http://localhost/api/playground/referrals", { headers }));
  return { res, body: await res.json() };
}

let countFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  process.env.PLAYGROUND_ACCESS_SECRET = SECRET;
  delete process.env.NEXT_PUBLIC_WAITLIST_ORIGIN;
  signedInAs(DID);
  countFetch = vi.fn(async () => new Response(JSON.stringify({ count: 7 }), { status: 200 }));
  vi.stubGlobal("fetch", countFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PLAYGROUND_ACCESS_SECRET;
});

describe("GET /api/playground/referrals", () => {
  it("the matching Privy login gets its code, link and joined count, uncached", async () => {
    const { res, body } = await get(await sessionFor("AB23XYZ9", DID));
    expect(body).toEqual({ status: "ok", code: "AB23XYZ9", link: "https://percolator.trade/r/AB23XYZ9", joined: 7 });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(countFetch).toHaveBeenCalledWith(
      "https://percolator.trade/api/waitlist/my-referrals?code=AB23XYZ9",
      expect.objectContaining({ cache: "no-store", redirect: "error" }),
    );
  });

  it("a DIFFERENT Privy login on the same browser gets nothing", async () => {
    signedInAs(OTHER_DID);
    const { body } = await get(await sessionFor("AB23XYZ9", DID));
    expect(body.status).toBe("unavailable");
    expect(body).not.toHaveProperty("code");
    expect(countFetch).not.toHaveBeenCalled();
  });

  it("a session without the uid tag (older than this change) gets nothing", async () => {
    const { body } = await get(await sessionFor("AB23XYZ9"));
    expect(body).toEqual({ status: "unavailable", enterUrl: "https://percolator.trade/playground" });
  });

  it("no session (gate off) gets nothing", async () => {
    const { body } = await get();
    expect(body.status).toBe("unavailable");
  });

  it.each([TEAM_SUB_PREFIX, JUDGE_SUB_PREFIX])("a %s session gets nothing even with matching claims", async (prefix) => {
    const { body } = await get(await sessionFor("AB23XYZ9", DID, `${prefix}fingerprint`));
    expect(body.status).toBe("unavailable");
  });

  it("checks the session before Privy: no usable session never costs a Privy verification", async () => {
    const { verifyPrivyAuth } = await import("@/lib/privy-auth");
    await get();
    await get(await sessionFor("AB23XYZ9"));
    expect(verifyPrivyAuth).not.toHaveBeenCalled();
  });

  it("no Authorization header is signed-out without touching the session or Privy", async () => {
    const { GET } = await import("@/app/api/playground/referrals/route");
    const res = await GET(new NextRequest("http://localhost/api/playground/referrals"));
    expect(await res.json()).toEqual({ status: "signed-out" });
  });

  it("no Privy login is signed-out", async () => {
    auth.result = { ok: false, status: 401, reason: "missing-token" };
    const { body } = await get(await sessionFor("AB23XYZ9", DID));
    expect(body).toEqual({ status: "signed-out" });
  });

  it("Privy not configured on the server is unavailable, not signed-out", async () => {
    auth.result = { ok: false, status: 503, reason: "not-configured" };
    const { body } = await get(await sessionFor("AB23XYZ9", DID));
    expect(body.status).toBe("unavailable");
  });

  it.each([
    ["the count endpoint fails", () => new Response("", { status: 500 })],
    ["the count endpoint degrades with a reason", () => new Response(JSON.stringify({ count: 0, reason: "query" }), { status: 200 })],
    ["the count is not a whole number", () => new Response(JSON.stringify({ count: "7" }), { status: 200 })],
  ])("%s: joined is null, the link still shows", async (_n, make) => {
    countFetch.mockImplementation(async () => make());
    const { body } = await get(await sessionFor("AB23XYZ9", DID));
    expect(body).toMatchObject({ status: "ok", code: "AB23XYZ9", joined: null });
  });

  it("the count fetch throwing is joined null, not a 500", async () => {
    countFetch.mockImplementation(async () => {
      throw new Error("network");
    });
    const { res, body } = await get(await sessionFor("AB23XYZ9", DID));
    expect(res.status).toBe(200);
    expect(body.joined).toBeNull();
  });

  it("NEXT_PUBLIC_WAITLIST_ORIGIN redirects link and count to staging; a non-https value is ignored", async () => {
    process.env.NEXT_PUBLIC_WAITLIST_ORIGIN = "https://staging.percolator.trade/";
    let r = await get(await sessionFor("AB23XYZ9", DID));
    expect(r.body.link).toBe("https://staging.percolator.trade/r/AB23XYZ9");

    vi.resetModules();
    process.env.NEXT_PUBLIC_WAITLIST_ORIGIN = "javascript:alert(1)";
    r = await get(await sessionFor("AB23XYZ9", DID));
    expect(r.body.link).toBe("https://percolator.trade/r/AB23XYZ9");
  });

  it("reuses a code's count for a minute, so many viewers do not each hit the waitlist", async () => {
    const cookie = await sessionFor("AB23XYZ9", DID);
    await get(cookie);
    await get(cookie);
    await get(cookie);
    expect(countFetch).toHaveBeenCalledTimes(1);
  });

  it("a failed read keeps the last good count, and a failure is never cached", async () => {
    const { referralJoinedCount } = await import("@/lib/referral-count");
    const t0 = 1_000_000;
    expect(await referralJoinedCount("AB23XYZ9", "https://percolator.trade", t0)).toBe(7);
    countFetch.mockImplementation(async () => new Response("", { status: 429 }));
    expect(await referralJoinedCount("AB23XYZ9", "https://percolator.trade", t0 + 61_000)).toBe(7);
    expect(await referralJoinedCount("NEWCODE1", "https://percolator.trade", t0 + 61_000)).toBeNull();
    countFetch.mockImplementation(async () => new Response(JSON.stringify({ count: 2 }), { status: 200 }));
    expect(await referralJoinedCount("NEWCODE1", "https://percolator.trade", t0 + 61_001)).toBe(2);
  });

  it("a cached count is re-read after a minute, so new signups appear", async () => {
    const { referralJoinedCount } = await import("@/lib/referral-count");
    const t0 = 2_000_000;
    expect(await referralJoinedCount("AB23XYZ9", "https://percolator.trade", t0)).toBe(7);
    countFetch.mockImplementation(async () => new Response(JSON.stringify({ count: 8 }), { status: 200 }));
    expect(await referralJoinedCount("AB23XYZ9", "https://percolator.trade", t0 + 59_000)).toBe(7);
    expect(await referralJoinedCount("AB23XYZ9", "https://percolator.trade", t0 + 60_000)).toBe(8);
  });
});
