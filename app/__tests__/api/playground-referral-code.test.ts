/**
 * The referral code reaches the playground through the signed access tokens: the gate on
 * percolator.trade adds `ref` to the handoff, /enter carries it into the `pg_access` session, and
 * GET /api/playground/me hands it to the Account and Security window. The playground has no
 * waitlist DB access, so this is the only path.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as gateWithRef from "../fixtures/gate-playground-access.ref";
import * as gateOld from "../fixtures/gate-playground-access.pr2732";
import { SESSION_COOKIE, mintSession, readSession } from "@/lib/playground-access";
import { decideEnter, memoryReplayGuard } from "@/lib/playground-enter";
import { GET as me } from "@/app/api/playground/me/route";

const SECRET = "s".repeat(40);
const NOW = 1_800_000_000_000;
const ENV = { PLAYGROUND_ACCESS_SECRET: SECRET };

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
  const call = (cookie?: string) =>
    me(new NextRequest("https://play.percolator.trade/api/playground/me", cookie ? { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } } : undefined));

  it("returns the session's code, uncached", async () => {
    vi.stubEnv("PLAYGROUND_ACCESS_SECRET", SECRET);
    const res = await call(await mintSession("row-1", 1, SECRET, Date.now(), "PERC7Q"));
    expect(await res.json()).toEqual({ ref: "PERC7Q" });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it.each([
    ["no session", async () => undefined],
    ["a session without a code", async () => mintSession("row-1", 1, SECRET, Date.now())],
    ["a team-bypass session", async () => mintSession("team:abc", 1, SECRET, Date.now(), "PERC7Q")],
    ["a forged session", async () => mintSession("row-1", 1, "f".repeat(40), Date.now(), "PERC7Q")],
  ])("%s: ref null", async (_name, cookie) => {
    vi.stubEnv("PLAYGROUND_ACCESS_SECRET", SECRET);
    expect(await (await call(await cookie())).json()).toEqual({ ref: null });
  });

  it("no access secret configured (gate off): ref null", async () => {
    vi.stubEnv("PLAYGROUND_ACCESS_SECRET", "");
    expect(await (await call(await mintSession("row-1", 1, SECRET, Date.now(), "PERC7Q"))).json()).toEqual({ ref: null });
  });
});
