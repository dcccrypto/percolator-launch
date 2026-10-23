/**
 * The referral code reaches the playground through the signed access tokens: the gate on
 * percolator.trade adds `ref` to the handoff, /enter carries it into the `pg_access` session, and
 * GET /api/playground/me hands it to the Account and Security window, only for the Privy login the
 * gate verified (the session's `uid` tag). The playground has no waitlist DB access, so this is the
 * only path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as gateWithRef from "../fixtures/gate-playground-access.ref";
import * as gateOld from "../fixtures/gate-playground-access.pr2732";
import { SESSION_COOKIE, mintSession, privyUserTag, readSession } from "@/lib/playground-access";
import { decideEnter, memoryReplayGuard } from "@/lib/playground-enter";
import { GET as me } from "@/app/api/playground/me/route";

const SECRET = "s".repeat(40);
const NOW = 1_800_000_000_000;
const ENV = { PLAYGROUND_ACCESS_SECRET: SECRET };
const DID = "did:privy:cm1owner000000000000";

const auth = vi.hoisted(() => ({ result: null as unknown }));
vi.mock("@/lib/privy-auth", () => ({ verifyPrivyAuth: vi.fn(async () => auth.result) }));
const signedInAs = (userId: string) => {
  auth.result = { ok: true, userId, email: null, emails: [], solanaWallets: [] };
};
const bound = async (sub: string, ref: string | undefined, did = DID, secret = SECRET) =>
  mintSession(sub, 1, secret, Date.now(), ref, await privyUserTag(did, secret));

beforeEach(() => signedInAs(DID));
afterEach(() => vi.unstubAllEnvs());

describe("handoff -> session", () => {
  it("a handoff from the updated gate carries the code into the session", async () => {
    const token = gateWithRef.mintHandoff("row-9", 9, SECRET, NOW, "PERC7Q");
    const r = await decideEnter({ token, team: null }, ENV, memoryReplayGuard(), NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await readSession(r.cookie, SECRET, NOW)).toMatchObject({ sub: "row-9", pos: 9, ref: "PERC7Q" });
  });

  it("a handoff from the current gate (no code) still enters, with no code", async () => {
    const token = gateOld.mintHandoff("row-9", 9, SECRET, NOW);
    const r = await decideEnter({ token, team: null }, ENV, memoryReplayGuard(), NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await readSession(r.cookie, SECRET, NOW)).not.toHaveProperty("ref");
  });

  it.each([["<script>"], ["A".repeat(33)], [12345], [{ x: 1 }]])("an odd code (%j) is dropped, never a reason to refuse the token", async (bad) => {
    const token = gateWithRef.mintHandoff("row-9", 9, SECRET, NOW, bad as string);
    const r = await decideEnter({ token, team: null }, ENV, memoryReplayGuard(), NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = await readSession(r.cookie, SECRET, NOW);
    expect(s).toMatchObject({ sub: "row-9", pos: 9 });
    expect(s).not.toHaveProperty("ref");
  });
});

describe("GET /api/playground/me", () => {
  const call = (cookie?: string, token: string | null = "privy-token") => {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = `${SESSION_COOKIE}=${cookie}`;
    if (token) headers.authorization = `Bearer ${token}`;
    return me(new NextRequest("https://play.percolator.trade/api/playground/me", { headers }));
  };

  it("returns the session's code to the Privy login the gate verified, uncached", async () => {
    vi.stubEnv("PLAYGROUND_ACCESS_SECRET", SECRET);
    const res = await call(await bound("row-1", "PERC7Q"));
    expect(await res.json()).toEqual({ ref: "PERC7Q" });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("a DIFFERENT Privy login on the same browser (same cookie): ref null", async () => {
    vi.stubEnv("PLAYGROUND_ACCESS_SECRET", SECRET);
    signedInAs("did:privy:cm1someoneelse00000");
    expect(await (await call(await bound("row-1", "PERC7Q"))).json()).toEqual({ ref: null });
  });

  it("the cookie alone, with no Privy access token: ref null", async () => {
    vi.stubEnv("PLAYGROUND_ACCESS_SECRET", SECRET);
    expect(await (await call(await bound("row-1", "PERC7Q"), null)).json()).toEqual({ ref: null });
  });

  it("an invalid Privy access token: ref null", async () => {
    vi.stubEnv("PLAYGROUND_ACCESS_SECRET", SECRET);
    auth.result = { ok: false, status: 401, reason: "invalid-token" };
    expect(await (await call(await bound("row-1", "PERC7Q"))).json()).toEqual({ ref: null });
  });

  it.each([
    ["no session", async () => undefined],
    ["a session without a code", async () => bound("row-1", undefined)],
    ["a session without the login tag (from before the gate sent it)", async () => mintSession("row-1", 1, SECRET, Date.now(), "PERC7Q")],
    ["a team-bypass session", async () => bound("team:abc", "PERC7Q")],
    ["a judge-door session", async () => bound("judge:abc", "PERC7Q")],
    ["a forged session", async () => bound("row-1", "PERC7Q", DID, "f".repeat(40))],
  ])("%s: ref null", async (_name, cookie) => {
    vi.stubEnv("PLAYGROUND_ACCESS_SECRET", SECRET);
    expect(await (await call(await cookie())).json()).toEqual({ ref: null });
  });

  it("no access secret configured (gate off): ref null", async () => {
    vi.stubEnv("PLAYGROUND_ACCESS_SECRET", "");
    expect(await (await call(await bound("row-1", "PERC7Q"))).json()).toEqual({ ref: null });
  });
});
