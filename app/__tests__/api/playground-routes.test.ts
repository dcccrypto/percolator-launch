/**
 * /api/playground/authorize (reports) and /api/playground/enter (the door).
 *
 * The adversarial cases: the door must refuse IDENTICALLY for every reason,
 * must mint only for a fresh server-side grant while launch is open, must
 * only ever send the token to the configured playground origin, and
 * /authorize must never hand out a token or the playground's address.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakeWaitlistSupabase, fillerRows, type FakeRow, type FakeOptions } from "../helpers/fakeWaitlistSupabase";

const h = vi.hoisted(() => ({
  auth: null as null | Record<string, unknown>,
  supabase: null as unknown,
  verifyCalls: [] as { authorization: string | null; idToken: string | null }[],
}));

vi.mock("@/lib/privy-auth", () => ({
  verifyPrivyAuth: vi.fn(async (req: Request) => {
    h.verifyCalls.push({
      authorization: req.headers.get("authorization"),
      idToken: req.headers.get("x-privy-id-token"),
    });
    if (req.headers.get("authorization") !== "Bearer good-access") {
      return { ok: false, status: 401, reason: "invalid-token" };
    }
    return h.auth ?? { ok: false, status: 401, reason: "invalid-token" };
  }),
}));
vi.mock("@/lib/waitlist/supabase", () => ({
  getWaitlistServiceSupabase: () => {
    if (!h.supabase) throw new Error("not configured");
    return h.supabase;
  },
}));

import { POST as authorize } from "@/app/api/playground/authorize/route";
import { POST as enter } from "@/app/api/playground/enter/route";
import { readHandoff, readSession } from "@/lib/playground-access";

const SECRET = "s".repeat(40);
const ME: FakeRow = { id: "row-me", privy_did: "did:privy:me", pubkey: "MYPUBKEY", email: "me@x.io", referral_code: "ME" };

function setWaitlist(rows: FakeRow[], opts?: FakeOptions) {
  h.supabase = fakeWaitlistSupabase(rows, opts).client;
}

const ENV_KEYS = ["PLAYGROUND_ACCESS_SECRET", "PLAYGROUND_OPEN", "PLAYGROUND_APP_URL", "PLAYGROUND_COHORT_CUTOFF"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.PLAYGROUND_ACCESS_SECRET = SECRET;
  process.env.PLAYGROUND_OPEN = "true";
  delete process.env.PLAYGROUND_APP_URL;
  delete process.env.PLAYGROUND_COHORT_CUTOFF;
  h.auth = { ok: true, userId: "did:privy:me", email: null, emails: [], solanaWallets: [] };
  h.verifyCalls = [];
  setWaitlist([...fillerRows(10), ME]); // position 11
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

// ── /authorize ─────────────────────────────────────────────────────────────

const authReq = (authorization = "Bearer good-access") =>
  new NextRequest("http://localhost/api/playground/authorize", { method: "POST", headers: { authorization } });

describe("POST /api/playground/authorize", () => {
  it("granted: position, cutoff and the launch flag — and NO token, NO playground address", async () => {
    process.env.PLAYGROUND_OPEN = "false";
    const res = await authorize(authReq());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true, status: "granted", position: 11, cutoff: 1000, open: false });
    expect(text).not.toMatch(/token|percolator-playground|\/enter|me@x\.io|MYPUBKEY/);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("reports open:true only when PLAYGROUND_OPEN is exactly 'true'", async () => {
    process.env.PLAYGROUND_OPEN = "true";
    expect((await (await authorize(authReq())).json()).open).toBe(true);
    for (const v of ["1", "TRUE", " true", "yes", ""]) {
      process.env.PLAYGROUND_OPEN = v;
      expect((await (await authorize(authReq())).json()).open).toBe(false);
    }
  });

  it("defaults the cutoff to 1000 and honours PLAYGROUND_COHORT_CUTOFF", async () => {
    setWaitlist([...fillerRows(1000), ME]); // position 1001
    const past = await authorize(authReq());
    expect(past.status).toBe(403);
    expect(await past.json()).toEqual({ ok: false, status: "not_yet", position: 1001, cutoff: 1000 });

    process.env.PLAYGROUND_COHORT_CUTOFF = "1001";
    expect((await (await authorize(authReq())).json()).status).toBe("granted");
  });

  it("every non-member gets the byte-identical refusal", async () => {
    const bodies: string[] = [];
    // no row at all
    setWaitlist(fillerRows(5));
    let res = await authorize(authReq());
    expect(res.status).toBe(403);
    bodies.push(await res.text());
    // a half-row with no referral code
    setWaitlist([{ ...ME, referral_code: null }]);
    res = await authorize(authReq());
    expect(res.status).toBe(403);
    bodies.push(await res.text());
    // a different identity entirely, with wallets and emails that miss
    h.auth = { ok: true, userId: "did:privy:other", email: "o@x.io", emails: ["o@x.io"], solanaWallets: ["OTHER"] };
    setWaitlist([ME]);
    res = await authorize(authReq());
    bodies.push(await res.text());
    expect(new Set(bodies)).toEqual(new Set([JSON.stringify({ ok: false, status: "not_member" })]));
  });

  it("fails CLOSED with an unset or short secret — and never even asks Privy", async () => {
    for (const s of [undefined, "", "short"]) {
      if (s === undefined) delete process.env.PLAYGROUND_ACCESS_SECRET;
      else process.env.PLAYGROUND_ACCESS_SECRET = s;
      h.verifyCalls = [];
      const res = await authorize(authReq());
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false, status: "unavailable" });
      expect(h.verifyCalls).toHaveLength(0);
    }
  });

  it("a bad Privy token is 401 unauthenticated", async () => {
    const res = await authorize(authReq("Bearer forged"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, status: "unauthenticated" });
  });

  it("a lookup failure is 503 unavailable — never a grant, never 'not a member'", async () => {
    setWaitlist([ME], { failColumn: "privy_did" });
    let res = await authorize(authReq());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, status: "unavailable" });

    setWaitlist([ME], { failRpc: true });
    res = await authorize(authReq());
    expect(res.status).toBe(503);

    h.supabase = null; // client getter throws
    res = await authorize(authReq());
    expect(res.status).toBe(503);
  });
});

// ── /enter ─────────────────────────────────────────────────────────────────

function enterReq(
  fields: Record<string, string> = { access_token: "good-access", id_token: "id-tok" },
  headers: Record<string, string> = { origin: "http://localhost", host: "localhost" },
) {
  const body = new URLSearchParams(fields).toString();
  return new NextRequest("http://localhost/api/playground/enter", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body,
  });
}

const BACK = "http://localhost/playground";

describe("POST /api/playground/enter — granted and open", () => {
  it("303s to the default playground /enter with a valid handoff for this row and position", async () => {
    const now = Date.now();
    const res = await enter(enterReq());
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin).toBe("https://play.percolator.trade");
    expect(loc.pathname).toBe("/enter");
    expect([...loc.searchParams.keys()]).toEqual(["t"]);
    const t = loc.searchParams.get("t")!;
    const claims = readHandoff(t, SECRET, now);
    expect(claims).toMatchObject({ sub: "row-me", pos: 11, ref: "ME" }); // the referral code, for the playground to show
    // It is a HANDOFF, not a session: it must not open as one.
    expect(readSession(t, SECRET, now)).toBeNull();
    // ...and it carries no identifier.
    expect(Buffer.from(t.split(".")[0]!, "base64url").toString("utf8")).not.toMatch(/@|MYPUBKEY|did:privy/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("verifies the FORM's tokens through the same Privy path /authorize uses", async () => {
    await enter(enterReq());
    expect(h.verifyCalls).toEqual([{ authorization: "Bearer good-access", idToken: "id-tok" }]);
  });

  it("honours PLAYGROUND_APP_URL (origin only)", async () => {
    process.env.PLAYGROUND_APP_URL = "https://pg.example.com/";
    const res = await enter(enterReq());
    expect(res.headers.get("location")).toMatch(/^https:\/\/pg\.example\.com\/enter\?t=/);
  });
});

describe("POST /api/playground/enter — every refusal is the same 303 back to the gate", () => {
  type Case = [string, () => void, (() => NextRequest)?];
  const cases: Case[] = [
    ["secret unset", () => void delete process.env.PLAYGROUND_ACCESS_SECRET],
    ["secret too short", () => void (process.env.PLAYGROUND_ACCESS_SECRET = "short")],
    ["launch closed (unset)", () => void delete process.env.PLAYGROUND_OPEN],
    ["launch closed ('false')", () => void (process.env.PLAYGROUND_OPEN = "false")],
    ["launch flag typo ('1')", () => void (process.env.PLAYGROUND_OPEN = "1")],
    ["app URL not https", () => void (process.env.PLAYGROUND_APP_URL = "http://percolator-playground.vercel.app")],
    ["app URL carries a path", () => void (process.env.PLAYGROUND_APP_URL = "https://evil.example/collect")],
    ["app URL garbage", () => void (process.env.PLAYGROUND_APP_URL = "not a url")],
    ["foreign Origin", () => {}, () => enterReq(undefined, { origin: "https://evil.example", host: "localhost" })],
    ["missing Origin", () => {}, () => enterReq(undefined, { host: "localhost" })],
    ["no access token", () => {}, () => enterReq({ id_token: "id-tok" })],
    ["forged access token", () => {}, () => enterReq({ access_token: "forged" })],
    ["not a member", () => setWaitlist(fillerRows(5))],
    ["past the cutoff", () => setWaitlist([...fillerRows(1000), ME])],
    ["row lookup error", () => setWaitlist([ME], { failColumn: "privy_did" })],
    ["position RPC error", () => setWaitlist([ME], { failRpc: true })],
    ["waitlist DB unconfigured", () => void (h.supabase = null)],
  ];

  it.each(cases)("%s", async (_label, arrange, makeReq) => {
    arrange();
    const res = await enter(makeReq ? makeReq() : enterReq());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(BACK);
    expect(await res.text()).toBe("");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("CONTROL: the same request with nothing broken DOES go through", async () => {
    const res = await enter(enterReq());
    expect(res.headers.get("location")).not.toBe(BACK);
  });

  it("has no GET handler — a link or <img> cannot trigger the door", async () => {
    const mod = await import("@/app/api/playground/enter/route");
    expect((mod as Record<string, unknown>).GET).toBeUndefined();
  });
});
