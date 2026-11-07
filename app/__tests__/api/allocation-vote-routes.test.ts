/**
 * Public launch state for the allocation checker and holder vote on
 * percolator.trade: allocations NOT published, vote DISABLED.
 *
 * Every write fails closed server-side, nothing reads env to switch it on,
 * there is no start/admin endpoint, and each handler refuses any host other
 * than the exact waitlist host (defense in depth behind middleware).
 */
import { describe, it, expect, afterEach } from "vitest";
import { NextRequest } from "next/server";
import * as fs from "fs";
import * as path from "path";

import { GET as allocationStatus } from "@/app/api/allocation/status/route";
import { POST as allocationCheck } from "@/app/api/allocation/check/route";
import { GET as voteStatus } from "@/app/api/vote/status/route";
import { POST as voteChallenge } from "@/app/api/vote/challenge/route";
import { POST as voteSubmit } from "@/app/api/vote/submit/route";
import { GET as voteResults } from "@/app/api/vote/results/route";
import { GET as voteLog } from "@/app/api/vote/log/route";

const ROOT = path.resolve(__dirname, "../..");
// A syntactically valid 32-byte base58 key (the System Program id), not a holder.
const VALID_SYNTAX = "11111111111111111111111111111111";

function req(p: string, init: { host?: string; method?: string; body?: string; type?: string } = {}) {
  const host = init.host ?? "percolator.trade";
  const headers: Record<string, string> = { host };
  if (init.type) headers["content-type"] = init.type;
  return new NextRequest(`https://${host || "x.invalid"}${p}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body,
  });
}
const post = (p: string, body: unknown, host?: string) =>
  req(p, { method: "POST", body: JSON.stringify(body), type: "application/json", host });

function expectPrivateHeaders(res: Response) {
  expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  expect(res.headers.get("cache-control")).toMatch(/no-store/);
}

afterEach(() => {
  for (const k of ["VOTE_ENABLED", "NEXT_PUBLIC_VOTE_ENABLED", "VOTE_STATE", "ALLOCATION_PUBLISHED"]) delete process.env[k];
});

describe("allocation: not published", () => {
  it("status reports unpublished / unavailable", async () => {
    const res = await allocationStatus(req("/api/allocation/status"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ published: false, data: "unavailable" });
    expectPrivateHeaders(res);
  });

  it("a syntactically valid wallet gets 503 unavailable, never a figure", async () => {
    const res = await allocationCheck(post("/api/allocation/check", { wallet: VALID_SYNTAX }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ status: "unavailable", message: "Validated allocation data unavailable" });
    expectPrivateHeaders(res);
  });

  it.each([
    [{ wallet: "" }, "Enter a wallet address (input is empty)."],
    [{ wallet: "0OIl" + "1".repeat(30) }, "Address contains invalid characters (base58 only: no 0, O, I, l, spaces or symbols)."],
    [{ wallet: "1".repeat(31) }, "Address length must be 32 to 44 characters."],
    [{ wallet: 42 }, "Wallet address must be a text string."],
    [{}, "Wallet address must be a text string."],
  ])("invalid input %j → 400 with the source checker message", async (body, msg) => {
    const res = await allocationCheck(post("/api/allocation/check", body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ status: "invalid", error: msg });
  });

  it("rejects non-JSON content type (415) and oversize bodies (413)", async () => {
    const r1 = await allocationCheck(req("/api/allocation/check", { method: "POST", body: "wallet=x", type: "application/x-www-form-urlencoded" }));
    expect(r1.status).toBe(415);
    const r2 = await allocationCheck(post("/api/allocation/check", { wallet: "1".repeat(2000) }));
    expect(r2.status).toBe(413);
    const r3 = await allocationCheck(req("/api/allocation/check", { method: "POST", body: "{not json", type: "application/json" }));
    expect(r3.status).toBe(400);
  });

  it("env cannot publish allocations", async () => {
    process.env.ALLOCATION_PUBLISHED = "true";
    const res = await allocationCheck(post("/api/allocation/check", { wallet: VALID_SYNTAX }));
    expect(res.status).toBe(503);
    expect((await (await allocationStatus(req("/api/allocation/status"))).json()).published).toBe(false);
  });
});

describe("vote: disabled, fail closed", () => {
  it("status is UNAVAILABLE and not open", async () => {
    const res = await voteStatus(req("/api/vote/status"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "UNAVAILABLE", open: false });
    expectPrivateHeaders(res);
  });

  it.each([
    {},
    { wallet: VALID_SYNTAX, option: "OPTION_A" },
    { wallet: VALID_SYNTAX, option: "OPTION_B" },
    { challenge_id: "0".repeat(32), signature: "1".repeat(88) },
  ])("challenge and submit refuse every body with 503 (%j)", async (body) => {
    for (const [fn, p] of [[voteChallenge, "/api/vote/challenge"], [voteSubmit, "/api/vote/submit"]] as const) {
      const res = await fn(post(p, body));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ status: "unavailable", message: "Vote unavailable" });
      expectPrivateHeaders(res);
    }
  });

  it("results and log are not available (409 not_started)", async () => {
    for (const [fn, p] of [[voteResults, "/api/vote/results"], [voteLog, "/api/vote/log"]] as const) {
      const res = await fn(req(p));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ status: "not_started", final: false });
    }
  });

  it("env cannot open the vote", async () => {
    process.env.VOTE_ENABLED = "true";
    process.env.NEXT_PUBLIC_VOTE_ENABLED = "true";
    process.env.VOTE_STATE = "OPEN";
    expect((await (await voteStatus(req("/api/vote/status"))).json()).state).toBe("UNAVAILABLE");
    expect((await voteChallenge(post("/api/vote/challenge", { wallet: VALID_SYNTAX, option: "OPTION_B" }))).status).toBe(503);
  });

  it("there is no start, admin, or configure endpoint under /api/vote", () => {
    const dir = path.join(ROOT, "app/api/vote");
    const routes: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else routes.push(path.relative(dir, p));
      }
    };
    walk(dir);
    expect(routes.sort()).toEqual([
      "challenge/route.ts",
      "log/route.ts",
      "results/route.ts",
      "status/route.ts",
      "submit/route.ts",
    ]);
  });

  it("route and lib sources read no env, filesystem, or storage (nothing can switch them on)", () => {
    const files = [
      ...["status", "challenge", "submit", "results", "log"].map((r) => `app/api/vote/${r}/route.ts`),
      ...["status", "check"].map((r) => `app/api/allocation/${r}/route.ts`),
      ...fs.readdirSync(path.join(ROOT, "lib/allocation-vote")).map((f) => `lib/allocation-vote/${f}`),
      "app/allocation/page.tsx",
      "app/vote/page.tsx",
    ];
    for (const f of files) {
      const src = fs.readFileSync(path.join(ROOT, f), "utf8");
      expect(src, f).not.toMatch(/process\.env/);
      expect(src, f).not.toMatch(/from ["'](node:)?fs["']|supabase|@upstash|@vercel\/blob|localStorage/);
    }
  });
});

describe("handlers refuse every host but percolator.trade", () => {
  const hosts = ["mainnet.percolatorlaunch.com", "percolator-launch.vercel.app", "localhost", "evilpercolator.trade", "percolator.trade.evil.com", ""];
  it.each(hosts)("%s → 404 on every handler", async (host) => {
    const results = await Promise.all([
      allocationStatus(req("/api/allocation/status", { host })),
      allocationCheck(post("/api/allocation/check", { wallet: VALID_SYNTAX }, host)),
      voteStatus(req("/api/vote/status", { host })),
      voteChallenge(post("/api/vote/challenge", {}, host)),
      voteSubmit(post("/api/vote/submit", {}, host)),
      voteResults(req("/api/vote/results", { host })),
      voteLog(req("/api/vote/log", { host })),
    ]);
    for (const r of results) {
      expect(r.status).toBe(404);
      expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }
  });
});
