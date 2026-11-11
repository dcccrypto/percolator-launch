// @vitest-environment node
/**
 * /enter — exchanging a percolator.trade handoff (minted by #2732's real code)
 * or the team bypass for this app's pg_access session cookie.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as gate from "../fixtures/gate-playground-access.pr2732";
import { readSession, sessionGrantsAccess } from "@/lib/playground-access";
import { decideEnter, memoryReplayGuard } from "@/lib/playground-enter";

const SECRET = "s".repeat(40);
const TEAM = "t".repeat(40);
const NOW = 1_800_000_000_000;
const ENV = { PLAYGROUND_ACCESS_SECRET: SECRET, PLAYGROUND_TEAM_BYPASS_SECRET: TEAM };

describe("decideEnter", () => {
  it("accepts an in-cohort handoff and mints a session carrying the same row + position", async () => {
    const r = await decideEnter({ token: gate.mintHandoff("row-9", 999, SECRET, NOW), team: null }, ENV, memoryReplayGuard(), NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("handoff");
    expect(await readSession(r.cookie, SECRET, NOW)).toMatchObject({ sub: "row-9", pos: 999 });
    // And the gate's own reader agrees it is a session.
    expect(gate.readSession(r.cookie, SECRET, NOW)).toMatchObject({ sub: "row-9", pos: 999 });
  });

  it.each([
    ["over the cutoff", () => gate.mintHandoff("r", 1001, SECRET, NOW), ENV],
    ["over a lowered cutoff", () => gate.mintHandoff("r", 600, SECRET, NOW), { ...ENV, PLAYGROUND_COHORT_CUTOFF: "500" }],
    ["expired", () => gate.mintHandoff("r", 1, SECRET, NOW - 91_000), ENV],
    ["wrong secret", () => gate.mintHandoff("r", 1, "w".repeat(40), NOW), ENV],
    ["a session presented as a handoff", () => gate.mintSession("r", 1, SECRET, NOW), ENV],
    ["tampered", () => gate.mintHandoff("r", 1, SECRET, NOW).replace(/^./, (c) => (c === "e" ? "f" : "e")), ENV],
    ["a forged team sub", () => gate.mintHandoff("team:anything", 1, SECRET, NOW), ENV],
    ["no access secret configured", () => gate.mintHandoff("r", 1, SECRET, NOW), { PLAYGROUND_TEAM_BYPASS_SECRET: TEAM }],
    ["missing token", () => null, ENV],
    ["signed with an empty base while unconfigured", () => gate.mintHandoff("r", 1, "", NOW), {}],
  ])("refuses %s", async (_name, token, env) => {
    const r = await decideEnter({ token: token() as string | null, team: null }, env as Record<string, string>, memoryReplayGuard(), NOW);
    expect(r.ok).toBe(false);
  });

  it("refuses a replayed handoff (single use)", async () => {
    const guard = memoryReplayGuard(() => NOW);
    const token = gate.mintHandoff("r", 1, SECRET, NOW);
    expect((await decideEnter({ token, team: null }, ENV, guard, NOW)).ok).toBe(true);
    expect((await decideEnter({ token, team: null }, ENV, guard, NOW)).ok).toBe(false);
    // A different token for the same member is fine.
    expect((await decideEnter({ token: gate.mintHandoff("r", 1, SECRET, NOW + 1000), team: null }, ENV, guard, NOW)).ok).toBe(true);
  });

  it("team bypass: correct secret → a session that grants access", async () => {
    const r = await decideEnter({ token: null, team: TEAM }, ENV, memoryReplayGuard(), NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("team");
    expect(await sessionGrantsAccess(r.cookie, ENV, NOW)).toBe(true);
  });

  it.each([
    ["wrong secret", { token: null, team: "x".repeat(40) }, ENV],
    ["bypass unset", { token: null, team: TEAM }, { PLAYGROUND_ACCESS_SECRET: SECRET }],
    ["bypass too short", { token: null, team: "short" }, { PLAYGROUND_ACCESS_SECRET: SECRET, PLAYGROUND_TEAM_BYPASS_SECRET: "short" }],
    ["access secret unset", { token: null, team: TEAM }, { PLAYGROUND_TEAM_BYPASS_SECRET: TEAM }],
  ])("team bypass refuses: %s", async (_n, input, env) => {
    expect((await decideEnter(input, env as Record<string, string>, memoryReplayGuard(), NOW)).ok).toBe(false);
  });
});

describe("GET/POST /enter route", () => {
  beforeEach(() => {
    vi.stubEnv("PLAYGROUND_ACCESS_SECRET", SECRET);
    vi.stubEnv("PLAYGROUND_TEAM_BYPASS_SECRET", TEAM);
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  async function route() {
    return import("@/app/enter/route");
  }

  it("a granted entry lands on /?signin=1 so the playground opens Privy sign-in (same embedded wallet)", async () => {
    const { GET } = await route();
    const token = gate.mintHandoff("row-8", 8, SECRET);
    const res = await GET(new NextRequest(`https://percolator-playground.vercel.app/enter?t=${token}`));
    expect(new URL(res.headers.get("location")!).searchParams.get("signin")).toBe("1");
  });

  it("accepts ?t= — the exact parameter percolator.trade's /api/playground/enter redirects with", async () => {
    const { GET } = await route();
    const token = gate.mintHandoff("row-7", 7, SECRET);
    const res = await GET(new NextRequest(`https://percolator-playground.vercel.app/enter?t=${token}`));
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");
    expect(res.headers.get("set-cookie") ?? "").toMatch(/^pg_access=/);
  });

  it("valid handoff → 303 to / with a HttpOnly; Secure; SameSite=Lax; Path=/; 24h cookie", async () => {
    const { GET } = await route();
    const token = gate.mintHandoff("row-1", 10, SECRET);
    const res = await GET(new NextRequest(`https://percolator-playground.vercel.app/enter?token=${token}`));
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");
    const sc = res.headers.get("set-cookie") ?? "";
    expect(sc).toMatch(/^pg_access=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+;/);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/Secure/i);
    expect(sc).toMatch(/SameSite=lax/i);
    expect(sc).toMatch(/Path=\//);
    expect(sc).toMatch(/Max-Age=86400/);
    expect(sc).not.toMatch(/Domain=/i);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const cookie = sc.split(";")[0].split("=")[1];
    expect(await readSession(cookie, SECRET)).toMatchObject({ sub: "row-1", pos: 10 });
  });

  it("accepts ?h= and a POSTed form", async () => {
    const { GET, POST } = await route();
    const a = await GET(new NextRequest(`https://pg.test/enter?h=${gate.mintHandoff("a", 1, SECRET)}`));
    expect(a.headers.get("set-cookie")).toMatch(/^pg_access=/);
    const body = new URLSearchParams({ token: gate.mintHandoff("b", 1, SECRET) });
    const b = await POST(
      new NextRequest("https://pg.test/enter", {
        method: "POST",
        body,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    );
    expect(b.status).toBe(303);
    expect(b.headers.get("set-cookie")).toMatch(/^pg_access=/);
  });

  it("invalid / expired / over-cutoff → 303 to /locked, no cookie", async () => {
    const { GET } = await route();
    for (const t of ["garbage", gate.mintHandoff("r", 1, SECRET, Date.now() - 120_000), gate.mintHandoff("r", 1001, SECRET)]) {
      const res = await GET(new NextRequest(`https://pg.test/enter?token=${encodeURIComponent(t)}`));
      expect(res.status).toBe(303);
      expect(new URL(res.headers.get("location")!).pathname).toBe("/locked");
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  it("team bypass via POST form field only", async () => {
    const { GET, POST } = await route();
    const post = (team: string) =>
      POST(new NextRequest("https://pg.test/enter", { method: "POST", body: new URLSearchParams({ team }), headers: { "content-type": "application/x-www-form-urlencoded" } }));
    const ok = await post(TEAM);
    expect(new URL(ok.headers.get("location")!).pathname).toBe("/");
    expect(ok.headers.get("set-cookie")).toMatch(/^pg_access=/);
    const bad = await post("n".repeat(40));
    expect(new URL(bad.headers.get("location")!).pathname).toBe("/locked");
    expect(bad.headers.get("set-cookie")).toBeNull();
    const viaGet = await GET(new NextRequest(`https://pg.test/enter?team=${TEAM}`));
    expect(new URL(viaGet.headers.get("location")!).pathname).toBe("/locked");
    expect(viaGet.headers.get("set-cookie")).toBeNull();
  });

  it("the route replays are refused across requests", async () => {
    const { GET } = await route();
    const t = gate.mintHandoff("once", 1, SECRET);
    expect((await GET(new NextRequest(`https://pg.test/enter?token=${t}`))).headers.get("set-cookie")).toMatch(/^pg_access=/);
    expect((await GET(new NextRequest(`https://pg.test/enter?token=${t}`))).headers.get("set-cookie")).toBeNull();
  });
});
