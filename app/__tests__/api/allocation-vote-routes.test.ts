/**
 * Public launch state for the allocation checker and holder vote on
 * percolator.trade.
 *
 *  - Allocation checker: one wallet per request, answered from the private
 *    database through a single lookup function (mocked here; the database side
 *    is covered by __tests__/db). Unconfigured -> fails closed as unavailable.
 *  - Vote: state lives in the private database (see vote-routes.test.ts and
 *    __tests__/db/perc-vote-db.test.ts); unconfigured it fails closed.
 *  - Each handler refuses any host other than the exact waitlist host (defense
 *    in depth behind middleware).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import * as fs from "fs";
import * as path from "path";

vi.mock("server-only", () => ({}));
const lookup = vi.fn();
vi.mock("@/lib/allocation-vote/lookup-db", () => ({ lookupAllocation: (...a: unknown[]) => lookup(...a) }));

import { GET as allocationStatus } from "@/app/api/allocation/status/route";
import { POST as allocationCheck } from "@/app/api/allocation/check/route";
import { GET as voteStatus } from "@/app/api/vote/status/route";
import { POST as voteChallenge } from "@/app/api/vote/challenge/route";
import { POST as voteSubmit } from "@/app/api/vote/submit/route";
import { GET as voteResults } from "@/app/api/vote/results/route";

const ROOT = path.resolve(__dirname, "../..");
// A syntactically valid 32-byte base58 key (the System Program id), not a holder.
const VALID_SYNTAX = "11111111111111111111111111111111";
const OTHER_SYNTAX = "So11111111111111111111111111111111111111112";

function req(p: string, init: { host?: string; method?: string; body?: string | ReadableStream; type?: string; headers?: Record<string, string> } = {}) {
  const host = init.host ?? "percolator.trade";
  const headers: Record<string, string> = { host, ...init.headers };
  if (init.type) headers["content-type"] = init.type;
  return new NextRequest(`https://${host || "x.invalid"}${p}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body,
    // @ts-expect-error -- required by undici for stream bodies
    duplex: "half",
  });
}
const post = (p: string, body: unknown, host?: string, headers?: Record<string, string>) =>
  req(p, { method: "POST", body: JSON.stringify(body), type: "application/json", host, headers });

function expectPrivateHeaders(res: Response) {
  expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  expect(res.headers.get("cache-control")).toMatch(/no-store/);
}

const SECRET = "x".repeat(32);
function configure() {
  process.env.ALLOCATION_DATABASE_URL = "postgresql://perc_alloc_reader:pw@127.0.0.1:5432/app";
  process.env.ALLOCATION_RATE_LIMIT_SECRET = SECRET;
}

const row = (o: Record<string, unknown>) => ({
  outcome: "eligible",
  retry_after_seconds: 0,
  eligible: null,
  balance_raw: null,
  token_decimals: null,
  allocation_usd_cents: null,
  exclusion_reasons: null,
  snapshot_label: "7 Nov 2026",
  allocation_status: "provisional",
  balance_basis: null,
  ...o,
});

beforeEach(() => {
  lookup.mockReset();
});
afterEach(() => {
  for (const k of [
    "VOTE_ENABLED", "NEXT_PUBLIC_VOTE_ENABLED", "VOTE_STATE", "ALLOCATION_PUBLISHED",
    "ALLOCATION_DATABASE_URL", "ALLOCATION_RATE_LIMIT_SECRET", "ALLOCATION_DATABASE_CA_PEM",
  ]) delete process.env[k];
});

describe("allocation: unconfigured fails closed", () => {
  it("status reports unpublished / unavailable", async () => {
    const res = await allocationStatus(req("/api/allocation/status"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ published: false, data: "unavailable" });
    expectPrivateHeaders(res);
  });

  it("a syntactically valid wallet gets 503 unavailable, never a figure, and no lookup", async () => {
    const res = await allocationCheck(post("/api/allocation/check", { wallet: VALID_SYNTAX }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "unavailable", message: "Allocation checker unavailable. Try again later." });
    expectPrivateHeaders(res);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("publish-looking env flags do nothing", async () => {
    process.env.ALLOCATION_PUBLISHED = "true";
    expect((await allocationCheck(post("/api/allocation/check", { wallet: VALID_SYNTAX }))).status).toBe(503);
    expect((await (await allocationStatus(req("/api/allocation/status"))).json()).published).toBe(false);
  });

  it.each([
    ["a non-reader database role", "postgresql://postgres:pw@127.0.0.1:5432/app", SECRET],
    ["a service-role-looking user", "postgresql://service_role:pw@db.example.com:5432/app", SECRET],
    ["a short rate-limit secret", "postgresql://perc_alloc_reader:pw@127.0.0.1:5432/app", "short"],
    ["a non-postgres URL", "https://perc_alloc_reader:pw@example.com/", SECRET],
  ])("refuses %s (fails closed, no lookup)", async (_l, url, secret) => {
    process.env.ALLOCATION_DATABASE_URL = url;
    process.env.ALLOCATION_RATE_LIMIT_SECRET = secret;
    expect((await allocationCheck(post("/api/allocation/check", { wallet: VALID_SYNTAX }))).status).toBe(503);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("allocation: input validation (before any lookup)", () => {
  beforeEach(configure);

  it.each([
    [{ wallet: "" }, "Enter a wallet address (input is empty)."],
    [{ wallet: "0OIl" + "1".repeat(30) }, "Address contains invalid characters (base58 only: no 0, O, I, l, spaces or symbols)."],
    [{ wallet: "1".repeat(31) }, "Address length must be 32 to 44 characters."],
    [{ wallet: 42 }, "Wallet address must be a text string."],
    [{}, "Wallet address must be a text string."],
    [{ wallet: `${VALID_SYNTAX},${OTHER_SYNTAX}` }, "Address contains invalid characters (base58 only: no 0, O, I, l, spaces or symbols)."],
    [{ wallet: `${VALID_SYNTAX} ${OTHER_SYNTAX}` }, "Address contains invalid characters (base58 only: no 0, O, I, l, spaces or symbols)."],
    [{ wallet: `${VALID_SYNTAX}\n${OTHER_SYNTAX}` }, "Address contains invalid characters (base58 only: no 0, O, I, l, spaces or symbols)."],
    [{ wallet: [VALID_SYNTAX, OTHER_SYNTAX] }, 'Send exactly one wallet as JSON: {"wallet": "<address>"}'],
    [{ wallets: [VALID_SYNTAX] }, 'Send exactly one wallet as JSON: {"wallet": "<address>"}'],
    [{ wallet: VALID_SYNTAX, other: OTHER_SYNTAX }, 'Send exactly one wallet as JSON: {"wallet": "<address>"}'],
    [[{ wallet: VALID_SYNTAX }], 'Send exactly one wallet as JSON: {"wallet": "<address>"}'],
    [null, 'Send exactly one wallet as JSON: {"wallet": "<address>"}'],
    ["11111111111111111111111111111111", 'Send exactly one wallet as JSON: {"wallet": "<address>"}'],
  ])("invalid input %j -> 400", async (body, msg) => {
    const res = await allocationCheck(post("/api/allocation/check", body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ status: "invalid", error: msg });
    expectPrivateHeaders(res);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("rejects non-JSON content type (415), oversize bodies (413) and bad JSON (400)", async () => {
    const r1 = await allocationCheck(req("/api/allocation/check", { method: "POST", body: "wallet=x", type: "application/x-www-form-urlencoded" }));
    expect(r1.status).toBe(415);
    const r2 = await allocationCheck(post("/api/allocation/check", { wallet: "1".repeat(2000) }));
    expect(r2.status).toBe(413);
    const r3 = await allocationCheck(req("/api/allocation/check", { method: "POST", body: "{not json", type: "application/json" }));
    expect(r3.status).toBe(400);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("caps a streamed body with no content-length (413) without buffering it all", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        if (pulled > 10_000) return c.close();
        c.enqueue(new TextEncoder().encode('{"wallet":"' + "1".repeat(500)));
      },
    });
    const res = await allocationCheck(req("/api/allocation/check", { method: "POST", body: stream, type: "application/json" }));
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(10);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("allocation: one wallet's result only", () => {
  beforeEach(configure);

  it("eligible: exact balance and provisional allocation, nothing else", async () => {
    lookup.mockResolvedValue(row({ outcome: "eligible", eligible: true, balance_raw: "1234567890123", token_decimals: 6, allocation_usd_cents: "12345", exclusion_reasons: [], balance_basis: "snapshot" }));
    const res = await allocationCheck(post("/api/allocation/check", { wallet: VALID_SYNTAX }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "eligible",
      snapshot: "7 Nov 2026",
      snapshot_balance: "1234567.890123",
      balance_basis: "snapshot",
      provisional_allocation_usd: "123.45",
      allocation_status: "provisional",
    });
    expectPrivateHeaders(res);
    expect(lookup).toHaveBeenCalledTimes(1);
    const [, owner, key] = lookup.mock.calls[0]!;
    expect(owner).toBe(VALID_SYNTAX);
    expect(Buffer.isBuffer(key) && key.length).toBe(32);
  });

  it("excluded: known reasons, balance, no allocation figure", async () => {
    lookup.mockResolvedValue(row({ outcome: "excluded", eligible: false, balance_raw: "5", token_decimals: 6, exclusion_reasons: ["off-curve", "LP"], balance_basis: "snapshot" }));
    const body = await (await allocationCheck(post("/api/allocation/check", { wallet: VALID_SYNTAX }))).json();
    expect(body).toEqual({
      status: "excluded",
      snapshot: "7 Nov 2026",
      snapshot_balance: "0.000005",
      exclusion_reasons: [
        { code: "off-curve", label: "Off-curve address: a program-derived account, not a user wallet" },
        { code: "LP", label: "Liquidity pool, vault or program-owned account" },
      ],
    });
    expect(body).not.toHaveProperty("provisional_allocation_usd");
  });

  it("approved balance exception: eligible, flagged as exception, with no founder/team wording", async () => {
    lookup.mockResolvedValue(row({ outcome: "eligible", eligible: true, balance_raw: "2500000", token_decimals: 6, allocation_usd_cents: "777", exclusion_reasons: [], balance_basis: "exception" }));
    const res = await allocationCheck(post("/api/allocation/check", { wallet: VALID_SYNTAX }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      status: "eligible",
      snapshot: "7 Nov 2026",
      snapshot_balance: "2.5",
      balance_basis: "exception",
      provisional_allocation_usd: "7.77",
      allocation_status: "provisional",
    });
    expect(text).not.toMatch(/founder|team/i);
  });

  it("unknown: not_found with no balance and no allocation (never a fabricated zero)", async () => {
    lookup.mockResolvedValue(row({ outcome: "not_found" }));
    const res = await allocationCheck(post("/api/allocation/check", { wallet: VALID_SYNTAX }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "not_found", snapshot: "7 Nov 2026" });
  });

  it("rate limited: 429 with Retry-After", async () => {
    lookup.mockResolvedValue(row({ outcome: "rate_limited", retry_after_seconds: 42, snapshot_label: null, allocation_status: null }));
    const res = await allocationCheck(post("/api/allocation/check", { wallet: VALID_SYNTAX }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(await res.json()).toEqual({ status: "rate_limited", retry_after_seconds: 42 });
  });

  it.each([
    ["no active snapshot", row({ outcome: "unavailable", snapshot_label: null, allocation_status: null })],
    ["no row", undefined],
    ["eligible without a figure", row({ outcome: "eligible", eligible: true, balance_raw: "1", token_decimals: 6 })],
    ["not_found carrying a balance", row({ outcome: "not_found", balance_raw: "0" })],
    ["excluded with an unknown reason", row({ outcome: "excluded", eligible: false, balance_raw: "1", token_decimals: 6, exclusion_reasons: ["team"] })],
    ["eligible with a malformed cents value", row({ outcome: "eligible", eligible: true, balance_raw: "1", token_decimals: 6, allocation_usd_cents: "1.5", exclusion_reasons: [] })],
    ["unexpected outcome", row({ outcome: "everything" })],
    ["eligible without a balance basis", row({ outcome: "eligible", eligible: true, balance_raw: "1", token_decimals: 6, allocation_usd_cents: "1", exclusion_reasons: [] })],
    ["eligible with an unknown balance basis", row({ outcome: "eligible", eligible: true, balance_raw: "1", token_decimals: 6, allocation_usd_cents: "1", exclusion_reasons: [], balance_basis: "founder" })],
    ["excluded with an exception basis", row({ outcome: "excluded", eligible: false, balance_raw: "1", token_decimals: 6, exclusion_reasons: ["LP"], balance_basis: "exception" })],
    ["not_found carrying a basis", row({ outcome: "not_found", balance_basis: "snapshot" })],
  ])("malformed database answer (%s) fails closed as 503", async (_l, r) => {
    lookup.mockResolvedValue(r);
    const res = await allocationCheck(post("/api/allocation/check", { wallet: VALID_SYNTAX }));
    expect(res.status).toBe(503);
    expect((await res.json()).status).toBe("unavailable");
  });

  it("a database error is 503 and the log line carries no wallet, URL or message", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    lookup.mockImplementation(() => {
      throw Object.assign(new Error(`boom ${VALID_SYNTAX} postgresql://perc_alloc_reader:pw@h`), { code: "57014" });
    });
    const res = await allocationCheck(post("/api/allocation/check", { wallet: VALID_SYNTAX }));
    expect(res.status).toBe(503);
    const logged = err.mock.calls.flat().join(" ");
    expect(logged).toBe("[allocation] lookup failed (57014)");
    err.mockRestore();
  });

  it("client keys are HMACs of the IP: stable per IP, distinct across IPs, never the IP itself", async () => {
    lookup.mockResolvedValue(row({ outcome: "not_found" }));
    for (const ip of ["203.0.113.7", "203.0.113.7", "198.51.100.9"]) {
      await allocationCheck(post("/api/allocation/check", { wallet: VALID_SYNTAX }, undefined, { "x-real-ip": ip }));
    }
    const keys = lookup.mock.calls.map((c) => (c[2] as Buffer).toString("hex"));
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).not.toBe(keys[2]);
    for (const k of keys) expect(k).not.toContain(Buffer.from("203.0.113.7").toString("hex"));
  });

  it("no cross-wallet leakage: each request is its own lookup, results are not reused", async () => {
    lookup
      .mockResolvedValueOnce(row({ outcome: "eligible", eligible: true, balance_raw: "1000000", token_decimals: 6, allocation_usd_cents: "100", exclusion_reasons: [], balance_basis: "snapshot" }))
      .mockResolvedValueOnce(row({ outcome: "not_found" }));
    const a = await (await allocationCheck(post("/api/allocation/check", { wallet: VALID_SYNTAX }))).json();
    const b = await (await allocationCheck(post("/api/allocation/check", { wallet: OTHER_SYNTAX }))).json();
    expect(a.status).toBe("eligible");
    expect(b).toEqual({ status: "not_found", snapshot: "7 Nov 2026" });
    expect(lookup.mock.calls.map((c) => c[1])).toEqual([VALID_SYNTAX, OTHER_SYNTAX]);
  });

  it("status reports provisional when configured, without a database call", async () => {
    expect(await (await allocationStatus(req("/api/allocation/status"))).json()).toEqual({ published: true, data: "provisional" });
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("vote: fail closed without server configuration (full behaviour in vote-routes.test.ts)", () => {
  it("unconfigured: status and writes are 503 unavailable; env flags cannot open it", async () => {
    process.env.VOTE_ENABLED = "true";
    process.env.NEXT_PUBLIC_VOTE_ENABLED = "true";
    process.env.VOTE_STATE = "OPEN";
    const res = await voteStatus(req("/api/vote/status"));
    expect(res.status).toBe(503);
    expectPrivateHeaders(res);
    for (const [fn, p] of [[voteChallenge, "/api/vote/challenge"], [voteSubmit, "/api/vote/submit"]] as const) {
      const r = await fn(post(p, { wallet: VALID_SYNTAX, choice: "buy-and-burn" }));
      expect(r.status).toBe(503);
      expect((await r.json()).status).toBe("unavailable");
    }
    expect((await voteResults(req("/api/vote/results"))).status).toBe(503);
    delete process.env.VOTE_ENABLED;
    delete process.env.NEXT_PUBLIC_VOTE_ENABLED;
    delete process.env.VOTE_STATE;
  });

  it("the only start endpoint is admin/start; there is no configure/reset/delete endpoint", () => {
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
      "admin/start/route.ts",
      "challenge/route.ts",
      "results/route.ts",
      "status/route.ts",
      "submit/route.ts",
    ]);
  });

  it("vote/allocation sources and pages read no env except the config modules, and no storage", () => {
    const CONFIG = new Set(["server-config.ts", "vote-admin.ts", "preview-host.ts"]);
    const files = [
      ...["status", "challenge", "submit", "results", "admin/start"].map((r) => `app/api/vote/${r}/route.ts`),
      ...fs.readdirSync(path.join(ROOT, "lib/allocation-vote")).filter((f) => !CONFIG.has(f)).map((f) => `lib/allocation-vote/${f}`),
      "app/allocation/page.tsx",
      "app/allocation/AllocationChecker.tsx",
      "app/vote/page.tsx",
      "app/vote/VoteClient.tsx",
      "app/vote/wallet-standard.ts",
      "app/vote/admin/page.tsx",
      "app/vote/admin/AdminStart.tsx",
    ];
    for (const f of files) {
      const src = fs.readFileSync(path.join(ROOT, f), "utf8");
      expect(src, f).not.toMatch(/process\.env/);
      expect(src, f).not.toMatch(/from ["'](node:)?fs["']|supabase|@upstash|@vercel\/blob|localStorage|sessionStorage|indexedDB|document\.cookie/);
    }
  });

  it("preview-host.ts reads exactly VERCEL_ENV and ALLOCATION_VOTE_PREVIEW_HOST, nothing else, no storage", () => {
    const src = fs.readFileSync(path.join(ROOT, "lib/allocation-vote/preview-host.ts"), "utf8");
    const reads = [...src.matchAll(/process\.env(?:\.([A-Z_]+)|\[)/g)].map((m) => m[1] ?? "<dynamic>");
    expect([...new Set(reads)].sort()).toEqual(["ALLOCATION_VOTE_PREVIEW_HOST", "VERCEL_ENV"]);
    expect(src).not.toMatch(/import |require\(|localStorage|document\.cookie/);
  });

  it("the allocation surface's only env reads are the three lookup settings plus VOTE_ADMIN_SECRET", () => {
    const src = fs.readFileSync(path.join(ROOT, "lib/allocation-vote/server-config.ts"), "utf8");
    expect(src).toMatch(/^import "server-only";$/m);
    const names = [...src.matchAll(/env\.([A-Z0-9_]+)/g)].map((m) => m[1]).sort();
    expect([...new Set(names)]).toEqual(["ALLOCATION_DATABASE_CA_PEM", "ALLOCATION_DATABASE_URL", "ALLOCATION_RATE_LIMIT_SECRET"]);
    const admin = fs.readFileSync(path.join(ROOT, "lib/allocation-vote/vote-admin.ts"), "utf8");
    expect([...new Set([...admin.matchAll(/env\.([A-Z0-9_]+)/g)].map((m) => m[1]))]).toEqual(["VOTE_ADMIN_SECRET"]);
    for (const s of [src, admin]) expect(s).not.toMatch(/NEXT_PUBLIC_/);
    for (const f of ["lookup-db.ts", "client-key.ts", "vote-db.ts", "vote-admin.ts", "vote-route.ts"]) {
      expect(fs.readFileSync(path.join(ROOT, "lib/allocation-vote", f), "utf8"), f).toMatch(/^import "server-only";$/m);
    }
  });
});

describe("handlers refuse every host but percolator.trade", () => {
  const hosts = ["mainnet.percolatorlaunch.com", "percolator-launch.vercel.app", "localhost", "evilpercolator.trade", "percolator.trade.evil.com", ""];
  it.each(hosts)("%s -> 404 on every handler (even when configured)", async (host) => {
    configure();
    lookup.mockResolvedValue(row({ outcome: "eligible", eligible: true, balance_raw: "1", token_decimals: 6, allocation_usd_cents: "1", exclusion_reasons: [] }));
    const results = await Promise.all([
      allocationStatus(req("/api/allocation/status", { host })),
      allocationCheck(post("/api/allocation/check", { wallet: VALID_SYNTAX }, host)),
      voteStatus(req("/api/vote/status", { host })),
      voteChallenge(post("/api/vote/challenge", {}, host)),
      voteSubmit(post("/api/vote/submit", {}, host)),
      voteResults(req("/api/vote/results", { host })),
    ]);
    for (const r of results) {
      expect(r.status).toBe(404);
      expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }
    expect(lookup).not.toHaveBeenCalled();
  });
});
