/**
 * /api/vote/* handlers with the database layer mocked (the database itself is
 * covered by __tests__/db/perc-vote-db.test.ts). Signatures are genuine
 * Ed25519 signatures from freshly generated SYNTHETIC keypairs.
 *
 * Nothing here talks to any real database, and nothing starts a real vote.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import bs58 from "bs58";
import nacl from "tweetnacl";

vi.mock("server-only", () => ({}));
const db = vi.hoisted(() => ({
  status: vi.fn(),
  issueNonce: vi.fn(),
  submitGate: vi.fn(),
  cast: vi.fn(),
  tally: vi.fn(),
  adminGate: vi.fn(),
  start: vi.fn(),
}));
vi.mock("@/lib/allocation-vote/vote-db", () => ({ voteDb: db, logDbError: vi.fn() }));

import { GET as status } from "@/app/api/vote/status/route";
import { POST as challenge } from "@/app/api/vote/challenge/route";
import { POST as submit } from "@/app/api/vote/submit/route";
import { GET as results } from "@/app/api/vote/results/route";
import { POST as adminStart } from "@/app/api/vote/admin/start/route";
import { buildVoteMessage } from "@/lib/allocation-vote/vote-message";

const ADMIN = "A".repeat(48);
function configure({ admin = true } = {}) {
  process.env.ALLOCATION_DATABASE_URL = "postgresql://perc_alloc_reader:pw@127.0.0.1:5432/app";
  process.env.ALLOCATION_RATE_LIMIT_SECRET = "x".repeat(32);
  if (admin) process.env.VOTE_ADMIN_SECRET = ADMIN;
}

function req(p: string, init: { host?: string; method?: string; body?: string; headers?: Record<string, string> } = {}) {
  const host = init.host ?? "percolator.trade";
  return new NextRequest(`https://${host || "x.invalid"}${p}`, {
    method: init.method ?? "GET",
    headers: { host, ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...init.headers },
    body: init.body,
  });
}
const post = (p: string, body: unknown, headers?: Record<string, string>, host?: string) =>
  req(p, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers, host });

const kp = nacl.sign.keyPair();
const wallet = bs58.encode(kp.publicKey);
const N = { nonce: "ab".repeat(32), issuedAt: "2026-11-08T01:00:00.000Z", expiresAt: "2026-11-08T01:05:00.000Z" };
function signedBody(choice: "buy-and-burn" | "weekly-fee-claims" = "buy-and-burn", sk = kp.secretKey) {
  const message = buildVoteMessage({ choice, wallet, ...N });
  const sig = nacl.sign.detached(Uint8Array.from(Buffer.from(message, "utf8")), sk);
  return { body: { wallet, choice, ...N, signature: bs58.encode(sig) }, message, sig };
}

beforeEach(() => {
  for (const f of Object.values(db)) f.mockReset();
  db.submitGate.mockResolvedValue(0);
  db.adminGate.mockResolvedValue(0);
});
afterEach(() => {
  delete process.env.ALLOCATION_DATABASE_URL;
  delete process.env.ALLOCATION_RATE_LIMIT_SECRET;
  delete process.env.VOTE_ADMIN_SECRET;
});

describe("host lock + fail closed", () => {
  const hosts = ["mainnet.percolatorlaunch.com", "percolator-launch.vercel.app", "localhost", "evilpercolator.trade", ""];
  it.each(hosts)("%s -> 404 on every vote handler, no DB call", async (host) => {
    configure();
    const rs = await Promise.all([
      status(req("/api/vote/status", { host })),
      challenge(post("/api/vote/challenge", { wallet, choice: "buy-and-burn" }, undefined, host)),
      submit(post("/api/vote/submit", signedBody().body, undefined, host)),
      results(req("/api/vote/results", { host })),
      adminStart(post("/api/vote/admin/start", { confirm: "START perc-fee-policy-2026-11" }, { authorization: `Bearer ${ADMIN}` }, host)),
    ]);
    for (const r of rs) {
      expect(r.status).toBe(404);
      expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }
    for (const f of Object.values(db)) expect(f).not.toHaveBeenCalled();
  });

  it("without server DB config every endpoint is 503 unavailable (admin too)", async () => {
    const rs = await Promise.all([
      status(req("/api/vote/status")),
      challenge(post("/api/vote/challenge", { wallet, choice: "buy-and-burn" })),
      submit(post("/api/vote/submit", signedBody().body)),
      results(req("/api/vote/results")),
      adminStart(post("/api/vote/admin/start", {}, { authorization: `Bearer ${ADMIN}` })),
    ]);
    for (const r of rs) {
      expect(r.status).toBe(503);
      expect((await r.json()).status).toBe("unavailable");
      expect(r.headers.get("cache-control")).toMatch(/no-store/);
    }
  });

  it("a DB error is a generic 503 and leaks nothing", async () => {
    configure();
    db.status.mockRejectedValue(Object.assign(new Error("password authentication failed for user perc_alloc_reader at 10.0.0.1"), { code: "28P01" }));
    const r = await status(req("/api/vote/status"));
    expect(r.status).toBe(503);
    expect(JSON.stringify(await r.json())).not.toMatch(/password|perc_alloc|10\.0/);
  });
});

describe("status", () => {
  it("NOT STARTED is reported from the database", async () => {
    configure();
    db.status.mockResolvedValue({ outcome: "ok", retry_after_seconds: 0, state: "not_started", poll_key: "perc-fee-policy-2026-11", starts_at: null, ends_at: null, server_now: N.issuedAt });
    const r = await status(req("/api/vote/status"));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "ok", state: "not_started", starts_at: null, choices: ["weekly-fee-claims", "buy-and-burn"] });
  });
  it("unexpected DB shapes fail closed", async () => {
    configure();
    db.status.mockResolvedValue({ outcome: "ok", state: "OPEN!", poll_key: "perc-fee-policy-2026-11" });
    expect((await status(req("/api/vote/status"))).status).toBe(503);
    db.status.mockResolvedValue(undefined);
    expect((await status(req("/api/vote/status"))).status).toBe(503);
  });
  it("rate limited -> 429 with Retry-After", async () => {
    configure();
    db.status.mockResolvedValue({ outcome: "rate_limited", retry_after_seconds: 17 });
    const r = await status(req("/api/vote/status"));
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("17");
  });
});

describe("challenge", () => {
  const ok = (over: Record<string, unknown> = {}) => ({
    outcome: "ok", retry_after_seconds: 0, poll_key: "perc-fee-policy-2026-11", nonce: N.nonce, issued_at: N.issuedAt, expires_at: N.expiresAt,
    message: buildVoteMessage({ choice: "buy-and-burn", wallet, ...N }), ...over,
  });
  it("returns the exact message to sign", async () => {
    configure();
    db.issueNonce.mockResolvedValue(ok());
    const r = await challenge(post("/api/vote/challenge", { wallet, choice: "buy-and-burn" }));
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.message).toBe(buildVoteMessage({ choice: "buy-and-burn", wallet, ...N }));
    expect(db.issueNonce).toHaveBeenCalledWith(expect.anything(), wallet, "buy-and-burn", expect.any(Buffer));
  });
  it("a DB message that differs from the app's template fails closed", async () => {
    configure();
    db.issueNonce.mockResolvedValue(ok({ message: "Domain: evil" }));
    expect((await challenge(post("/api/vote/challenge", { wallet, choice: "buy-and-burn" }))).status).toBe(503);
  });
  it.each([
    ["not_eligible", 403],
    ["not_started", 409],
    ["closed", 409],
    ["invalid", 400],
    ["something_else", 503],
  ])("outcome %s -> %d", async (outcome, code) => {
    configure();
    db.issueNonce.mockResolvedValue({ outcome, retry_after_seconds: 0 });
    expect((await challenge(post("/api/vote/challenge", { wallet, choice: "buy-and-burn" }))).status).toBe(code);
  });
  it("strict body: wrong content type, oversized, batch, unknown choice -> refused without DB", async () => {
    configure();
    expect((await challenge(req("/api/vote/challenge", { method: "POST", body: "{}", headers: { "content-type": "text/plain" } }))).status).toBe(415);
    expect((await challenge(post("/api/vote/challenge", "x".repeat(5000)))).status).toBe(413);
    expect((await challenge(post("/api/vote/challenge", [{ wallet, choice: "buy-and-burn" }]))).status).toBe(400);
    expect((await challenge(post("/api/vote/challenge", { wallet, choice: "abstain" }))).status).toBe(400);
    expect(db.issueNonce).not.toHaveBeenCalled();
  });
  it.each(["https://evil.example", "https://percolator.trade.evil.com", "null", "https://percolator.trade:444", "https://percolator.trade/x", "javascript:1"])(
    "cross-site Origin %s is refused",
    async (origin) => {
      configure();
      expect((await challenge(post("/api/vote/challenge", { wallet, choice: "buy-and-burn" }, { origin }))).status).toBe(403);
      expect(db.issueNonce).not.toHaveBeenCalled();
    },
  );
  it("same-origin Origin is allowed", async () => {
    configure();
    db.issueNonce.mockResolvedValue({ outcome: "closed", retry_after_seconds: 0 });
    expect((await challenge(post("/api/vote/challenge", { wallet, choice: "buy-and-burn" }, { origin: "https://percolator.trade" }))).status).toBe(409);
  });
});

describe("submit", () => {
  it("a genuine signature is verified, then passed with the canonical message to the DB", async () => {
    configure();
    const s = signedBody();
    db.cast.mockResolvedValue({ outcome: "recorded", retry_after_seconds: 0, choice: "buy-and-burn", revision: 1, cast_at: N.issuedAt, ends_at: N.expiresAt });
    const r = await submit(post("/api/vote/submit", s.body));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "recorded", choice: "buy-and-burn", revision: 1 });
    const arg = db.cast.mock.calls[0]![1];
    expect(arg.message).toBe(s.message);
    expect(Buffer.from(arg.signature).equals(Buffer.from(s.sig))).toBe(true);
    expect(db.submitGate).toHaveBeenCalledTimes(1);
  });

  it("invalid signature -> 401 and the DB cast is never called", async () => {
    configure();
    const other = nacl.sign.keyPair();
    for (const body of [
      signedBody("buy-and-burn", other.secretKey).body,
      { ...signedBody("buy-and-burn").body, choice: "weekly-fee-claims" }, // choice swapped after signing
      { ...signedBody().body, nonce: "cd".repeat(32) }, // nonce swapped after signing
      { ...signedBody().body, expiresAt: "2026-11-08T09:05:00.000Z" }, // expiry extended after signing
    ]) {
      const r = await submit(post("/api/vote/submit", body));
      expect(r.status).toBe(401);
    }
    expect(db.cast).not.toHaveBeenCalled();
  });

  it("the submit gate runs before signature verification and can refuse with 429", async () => {
    configure();
    db.submitGate.mockResolvedValue(30);
    const r = await submit(post("/api/vote/submit", signedBody().body));
    expect(r.status).toBe(429);
    expect(db.cast).not.toHaveBeenCalled();
  });

  it.each([
    ["bad_nonce", 400, "bad_nonce"],
    ["message_mismatch", 400, "bad_nonce"],
    ["expired", 410, "expired"],
    ["superseded", 409, "superseded"],
    ["closed", 409, "closed"],
    ["not_started", 409, "not_started"],
    ["not_eligible", 403, "not_eligible"],
    ["rate_limited", 429, "rate_limited"],
    ["weird", 503, "unavailable"],
  ])("DB outcome %s -> %d %s", async (outcome, code, st) => {
    configure();
    db.cast.mockResolvedValue({ outcome, retry_after_seconds: outcome === "rate_limited" ? 9 : 0 });
    const r = await submit(post("/api/vote/submit", signedBody().body));
    expect(r.status).toBe(code);
    expect((await r.json()).status).toBe(st);
  });

  it("a recorded row that does not match the request fails closed", async () => {
    configure();
    db.cast.mockResolvedValue({ outcome: "recorded", choice: "weekly-fee-claims", revision: 1, cast_at: N.issuedAt, ends_at: N.expiresAt });
    expect((await submit(post("/api/vote/submit", signedBody("buy-and-burn").body))).status).toBe(503);
  });
});

describe("results: aggregate only, after close", () => {
  const closed = (over: Record<string, unknown> = {}) => ({
    outcome: "ok", retry_after_seconds: 0, state: "closed", poll_key: "perc-fee-policy-2026-11", ends_at: N.expiresAt,
    weekly_fee_claims_raw: "18446744073709551618", buy_and_burn_raw: "18446744073711551614",
    weekly_fee_claims_wallets: 2, buy_and_burn_wallets: 3, eligible_raw_total: "36893488147421103233",
    eligible_wallets: 5, token_decimals: 6, winner: "buy-and-burn", ...over,
  });
  it("hidden while not started/open", async () => {
    configure();
    for (const state of ["not_started", "open", "tallying"]) {
      db.tally.mockResolvedValue({ outcome: "ok", state, poll_key: "perc-fee-policy-2026-11", ends_at: null });
      const r = await results(req("/api/vote/results"));
      expect(r.status).toBe(409);
      expect(await r.json()).toEqual({ status: state, final: false, ends_at: null });
    }
  });
  it("final aggregate with exact decimals; no wallet appears", async () => {
    configure();
    db.tally.mockResolvedValue(closed());
    const r = await results(req("/api/vote/results"));
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.winner).toBe("buy-and-burn");
    expect(b.results["weekly-fee-claims"].balance).toBe("18446744073709.551618");
    expect(b.results["buy-and-burn"].balance).toBe("18446744073711.551614");
    expect(JSON.stringify(b)).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
  });
  it("DB winner disagreeing with the rule fails closed (tie must be buy-and-burn)", async () => {
    configure();
    db.tally.mockResolvedValue(closed({ weekly_fee_claims_raw: "5", buy_and_burn_raw: "5", winner: "weekly-fee-claims" }));
    expect((await results(req("/api/vote/results"))).status).toBe(503);
  });
});

describe("admin start", () => {
  const body = { confirm: "START perc-fee-policy-2026-11" };
  const auth = { authorization: `Bearer ${ADMIN}` };

  it("does not exist (404) unless VOTE_ADMIN_SECRET is configured - secure default", async () => {
    configure({ admin: false });
    const r = await adminStart(post("/api/vote/admin/start", body, auth));
    expect(r.status).toBe(404);
    expect(db.adminGate).not.toHaveBeenCalled();
    expect(db.start).not.toHaveBeenCalled();
  });

  it("refuses missing/wrong auth with 401 after the rate-limit gate; a URL secret is ignored", async () => {
    configure();
    for (const [p, h] of [
      ["/api/vote/admin/start", {}],
      ["/api/vote/admin/start", { authorization: `Bearer ${ADMIN}x` }],
      [`/api/vote/admin/start?secret=${ADMIN}`, {}],
      [`/api/vote/admin/start?token=${ADMIN}`, { authorization: "Bearer wrong-wrong-wrong-wrong-wrong-wrong" }],
    ] as const) {
      const r = await adminStart(post(p, body, h));
      expect(r.status).toBe(401);
      expect(JSON.stringify(await r.json())).not.toContain(ADMIN);
    }
    expect(db.adminGate).toHaveBeenCalledTimes(4);
    expect(db.start).not.toHaveBeenCalled();
  });

  it("rate limited before the secret is compared", async () => {
    configure();
    db.adminGate.mockResolvedValue(600);
    const r = await adminStart(post("/api/vote/admin/start", body, auth));
    expect(r.status).toBe(429);
    expect(db.start).not.toHaveBeenCalled();
  });

  it("requires the exact confirmation body", async () => {
    configure();
    for (const b of [{}, { confirm: "START" }, { confirm: "START perc-fee-policy-2026-11", x: 1 }, [body]]) {
      expect((await adminStart(post("/api/vote/admin/start", b, auth))).status).toBe(400);
    }
    expect(db.start).not.toHaveBeenCalled();
  });

  it("cross-site Origin refused", async () => {
    configure();
    expect((await adminStart(post("/api/vote/admin/start", body, { ...auth, origin: "https://evil.example" }))).status).toBe(403);
    expect(db.start).not.toHaveBeenCalled();
  });

  it("authorized + confirmed -> start_poll (mocked); already started -> 409", async () => {
    configure();
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    db.start.mockResolvedValueOnce({ outcome: "started", starts_at: "2026-11-09T00:00:00.000Z", ends_at: "2026-11-10T00:00:00.000Z", snapshot_label: "x" });
    const r = await adminStart(post("/api/vote/admin/start", body, { ...auth, origin: "https://percolator.trade" }));
    expect(r.status).toBe(200);
    expect(db.start).toHaveBeenCalledWith(expect.anything(), "perc-fee-policy-2026-11");
    expect(JSON.stringify(log.mock.calls)).not.toContain(ADMIN);
    db.start.mockResolvedValueOnce({ outcome: "already_started", starts_at: "a", ends_at: "b", snapshot_label: null });
    expect((await adminStart(post("/api/vote/admin/start", body, auth))).status).toBe(409);
    log.mockRestore();
  });
});
