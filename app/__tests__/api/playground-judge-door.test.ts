// @vitest-environment node
/**
 * The judge door: /enter?judge=<PLAYGROUND_JUDGE_ACCESS_CODE> mints a 24h
 * session for hackathon judges, independent of the waitlist and the team door.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as gate from "../fixtures/gate-playground-access.pr2732";
import {
  JUDGE_SUB_PREFIX,
  SESSION_TTL_SECONDS,
  TEAM_SUB_PREFIX,
  judgeAccessCode,
  judgeFingerprint,
  mintSession,
  sessionGrantsAccess,
  teamFingerprint,
} from "@/lib/playground-access";
import { decideEnter, memoryReplayGuard } from "@/lib/playground-enter";

const SECRET = "s".repeat(40);
const TEAM = "t".repeat(40);
const JUDGE = "j".repeat(32);
const NOW = 1_800_000_000_000;
const ENV = {
  PLAYGROUND_ACCESS_SECRET: SECRET,
  PLAYGROUND_TEAM_BYPASS_SECRET: TEAM,
  PLAYGROUND_JUDGE_ACCESS_CODE: JUDGE,
};

describe("judgeAccessCode", () => {
  it("open with a long-enough code and no expiry", () => {
    expect(judgeAccessCode(ENV, NOW)).toBe(JUDGE);
  });

  it.each([
    ["unset", {}],
    ["too short", { PLAYGROUND_JUDGE_ACCESS_CODE: "j".repeat(23) }],
    ["past its UNTIL", { ...ENV, PLAYGROUND_JUDGE_ACCESS_UNTIL: new Date(NOW - 1).toISOString() }],
    ["exactly at its UNTIL", { ...ENV, PLAYGROUND_JUDGE_ACCESS_UNTIL: new Date(NOW).toISOString() }],
    ["unparseable UNTIL (fail closed)", { ...ENV, PLAYGROUND_JUDGE_ACCESS_UNTIL: "next tuesday" }],
    ["a bare number UNTIL (Date.parse would read year 99999)", { ...ENV, PLAYGROUND_JUDGE_ACCESS_UNTIL: "99999" }],
    ["a date-only UNTIL (ambiguous cut-off)", { ...ENV, PLAYGROUND_JUDGE_ACCESS_UNTIL: "2027-12-31" }],
    ["a zoneless UNTIL (runtime-local time)", { ...ENV, PLAYGROUND_JUDGE_ACCESS_UNTIL: "2027-12-31T23:59:59" }],
  ])("closed when %s", (_n, env) => {
    expect(judgeAccessCode(env as Record<string, string>, NOW)).toBeNull();
  });

  it("trims the code (a pasted trailing newline must not close the door)", () => {
    expect(judgeAccessCode({ PLAYGROUND_JUDGE_ACCESS_CODE: JUDGE + "\n" }, NOW)).toBe(JUDGE);
  });

  it("open before an offset-zoned UNTIL", () => {
    expect(judgeAccessCode({ ...ENV, PLAYGROUND_JUDGE_ACCESS_UNTIL: "2027-12-31T23:59:59-05:00" }, NOW)).toBe(JUDGE);
  });

  it("open before its UNTIL", () => {
    expect(judgeAccessCode({ ...ENV, PLAYGROUND_JUDGE_ACCESS_UNTIL: new Date(NOW + 1000).toISOString() }, NOW)).toBe(JUDGE);
  });
});

describe("decideEnter — judge door", () => {
  it("correct code → a judge session that grants access", async () => {
    const r = await decideEnter({ token: null, team: null, judge: JUDGE }, ENV, memoryReplayGuard(), NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("judge");
    expect(await sessionGrantsAccess(r.cookie, ENV, NOW)).toBe(true);
  });

  it("the code is reusable (judges share one link)", async () => {
    const guard = memoryReplayGuard();
    for (let i = 0; i < 3; i++) {
      expect((await decideEnter({ token: null, team: null, judge: JUDGE }, ENV, guard, NOW)).ok).toBe(true);
    }
  });

  it.each([
    ["wrong code", { token: null, team: null, judge: "x".repeat(32) }, ENV],
    ["door unset", { token: null, team: null, judge: JUDGE }, { PLAYGROUND_ACCESS_SECRET: SECRET }],
    ["door expired", { token: null, team: null, judge: JUDGE }, { ...ENV, PLAYGROUND_JUDGE_ACCESS_UNTIL: new Date(NOW - 1).toISOString() }],
    ["access secret unset", { token: null, team: null, judge: JUDGE }, { PLAYGROUND_JUDGE_ACCESS_CODE: JUDGE }],
    ["team secret presented as a judge code", { token: null, team: null, judge: TEAM }, ENV],
    ["judge code presented as a team secret", { token: null, team: JUDGE, judge: null }, ENV],
  ])("refuses: %s", async (_n, input, env) => {
    expect((await decideEnter(input, env as Record<string, string>, memoryReplayGuard(), NOW)).ok).toBe(false);
  });

  it("a handoff can never carry a judge sub", async () => {
    const token = gate.mintHandoff(JUDGE_SUB_PREFIX + "anything", 1, SECRET, NOW);
    expect((await decideEnter({ token, team: null }, ENV, memoryReplayGuard(), NOW)).ok).toBe(false);
  });
});

describe("sessionGrantsAccess — judge sessions", () => {
  async function judgeSession() {
    return mintSession(JUDGE_SUB_PREFIX + (await judgeFingerprint(JUDGE)), 1, SECRET, NOW);
  }

  it("die when the code rotates, is unset, or the door expires", async () => {
    const s = await judgeSession();
    expect(await sessionGrantsAccess(s, ENV, NOW)).toBe(true);
    expect(await sessionGrantsAccess(s, { ...ENV, PLAYGROUND_JUDGE_ACCESS_CODE: "r".repeat(32) }, NOW)).toBe(false);
    expect(await sessionGrantsAccess(s, { PLAYGROUND_ACCESS_SECRET: SECRET }, NOW)).toBe(false);
    expect(
      await sessionGrantsAccess(s, { ...ENV, PLAYGROUND_JUDGE_ACCESS_UNTIL: new Date(NOW + 1000).toISOString() }, NOW + 2000),
    ).toBe(false);
  });

  it("expire after the normal session TTL", async () => {
    expect(await sessionGrantsAccess(await judgeSession(), ENV, NOW + SESSION_TTL_SECONDS * 1000)).toBe(false);
  });

  it("do not fall through to the cohort check (pos 1): wrong fingerprint, or the door closed", async () => {
    const forged = await mintSession(JUDGE_SUB_PREFIX + "whatever", 1, SECRET, NOW);
    expect(await sessionGrantsAccess(forged, ENV, NOW)).toBe(false);
    expect(await sessionGrantsAccess(forged, { PLAYGROUND_ACCESS_SECRET: SECRET }, NOW)).toBe(false);
  });

  it("a judge-derived fingerprint never passes as a team session", async () => {
    expect(await judgeFingerprint(TEAM)).not.toBe(await teamFingerprint(TEAM));
    const asTeam = await mintSession(TEAM_SUB_PREFIX + (await judgeFingerprint(TEAM)), 1, SECRET, NOW);
    expect(await sessionGrantsAccess(asTeam, ENV, NOW)).toBe(false);
  });
});

describe("GET/POST /enter?judge=", () => {
  beforeEach(() => {
    vi.stubEnv("PLAYGROUND_ACCESS_SECRET", SECRET);
    vi.stubEnv("PLAYGROUND_TEAM_BYPASS_SECRET", TEAM);
    vi.stubEnv("PLAYGROUND_JUDGE_ACCESS_CODE", JUDGE);
    vi.stubEnv("PLAYGROUND_JUDGE_ACCESS_UNTIL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("GET with the right code sets the session and lands on /?signin=1", async () => {
    const { GET } = await import("@/app/enter/route");
    const ok = await GET(new NextRequest(`https://pg.test/enter?judge=${JUDGE}`));
    expect(ok.status).toBe(303);
    const loc = new URL(ok.headers.get("location")!);
    expect(loc.pathname).toBe("/");
    expect(loc.searchParams.get("signin")).toBe("1");
    expect(ok.headers.get("set-cookie")).toMatch(/^pg_access=/);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("GET with a wrong code goes to /locked with no cookie", async () => {
    const { GET } = await import("@/app/enter/route");
    const bad = await GET(new NextRequest(`https://pg.test/enter?judge=${"n".repeat(32)}`));
    expect(new URL(bad.headers.get("location")!).pathname).toBe("/locked");
    expect(bad.headers.get("set-cookie")).toBeNull();
  });

  it("POST form field `judge` works too", async () => {
    const { POST } = await import("@/app/enter/route");
    const body = new URLSearchParams({ judge: JUDGE });
    const res = await POST(
      new NextRequest("https://pg.test/enter", {
        method: "POST",
        body,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    );
    expect(res.headers.get("set-cookie")).toMatch(/^pg_access=/);
  });
});
