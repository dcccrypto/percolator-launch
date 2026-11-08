/**
 * PERC holder vote end to end against `next start` and a THROWAWAY local
 * Postgres, driven by app/scripts/vote/e2e-local.ts.
 *
 * SKIPPED unless VOTE_E2E_PORT is set (CI does not run the local DB harness).
 * REMOTE mode (VOTE_E2E_BASE=https://<preview alias>): the same cases against a
 * deployed Vercel PREVIEW backed by an isolated THROWAWAY database, driven by
 * app/scripts/vote/e2e-preview.ts. Vercel sets the client IP there, so the
 * throwaway DB's limiter rows are cleared between cases instead of rotating IPs.
 * Voters are SYNTHETIC keypairs generated per run; every vote carries a genuine
 * Ed25519 signature. The poll is started only inside the throwaway database.
 * Test titles and logs never include a wallet address.
 */
import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as path from "node:path";
import { createRequire } from "node:module";
import type naclT from "tweetnacl";

// bs58 / tweetnacl / pg are app dependencies; resolve them from app/.
const appRequire = createRequire(new URL("../app/package.json", import.meta.url));
type B58 = { encode(b: Uint8Array): string; decode(s: string): Uint8Array };
const bs58Mod = appRequire("bs58") as B58 & { default?: B58 };
const bs58: B58 = typeof bs58Mod.decode === "function" ? bs58Mod : bs58Mod.default!;
const nacl = appRequire("tweetnacl") as typeof naclT;
const { Client } = appRequire("pg") as typeof import("pg");
// Independent copy of the signed-message template (the app and the database each
// build it too): the server's challenge text must match this exactly.
function buildVoteMessage(f: { choice: string; wallet: string; nonce: string; issuedAt: string; expiresAt: string }) {
  return [
    "percolator.trade PERC holder vote",
    "Action: cast-vote",
    "Domain: percolator.trade",
    "Poll: perc-fee-policy-2026-11",
    `Choice: ${f.choice}`,
    `Wallet: ${f.wallet}`,
    `Nonce: ${f.nonce}`,
    `Issued At: ${f.issuedAt}`,
    `Expires At: ${f.expiresAt}`,
    "Signing records a vote only. It is not a transaction and moves no funds.",
  ].join("\n");
}
// eslint-disable-next-line @typescript-eslint/no-namespace
declare namespace nacl { type SignKeyPair = naclT.SignKeyPair }

const PORT = Number(process.env.VOTE_E2E_PORT);
const REMOTE = process.env.VOTE_E2E_BASE ? new URL(process.env.VOTE_E2E_BASE) : null;
if (REMOTE && (REMOTE.protocol !== "https:" || !REMOTE.hostname.endsWith(".vercel.app"))) throw new Error("VOTE_E2E_BASE must be an https *.vercel.app preview");
const enabled = (REMOTE !== null || (Number.isInteger(PORT) && PORT > 0)) && !!process.env.VOTE_E2E_VOTERS;
// Deployment-protection header for the preview (value from env, never logged).
const PROTECT: Record<string, string> = process.env.VOTE_E2E_OIDC ? { "x-vercel-trusted-oidc-idp-token": process.env.VOTE_E2E_OIDC } : {};
const TARGET_HOST = REMOTE ? REMOTE.hostname : "percolator.trade";
test.skip(!enabled, "local vote E2E harness not configured");

const keys = enabled ? JSON.parse(fs.readFileSync(process.env.VOTE_E2E_VOTERS!, "utf8")) : { eligible: [], excluded: "" };
const kp = (sk: string) => nacl.sign.keyPair.fromSecretKey(bs58.decode(sk));
const V = enabled ? (keys.eligible as string[]).map(kp) : [];
const X = enabled ? kp(keys.excluded) : null;
const addr = (k: nacl.SignKeyPair) => bs58.encode(k.publicKey);
const ADMIN = process.env.VOTE_E2E_ADMIN ?? "";
const SHOTS = process.env.VOTE_E2E_SHOTS;
const BASE = REMOTE ? REMOTE.origin : `http://percolator.trade:${PORT}`;

if (!REMOTE) test.use({ launchOptions: { args: ["--host-resolver-rules=MAP percolator.trade 127.0.0.1, MAP mainnet.percolatorlaunch.com 127.0.0.1"] } });
test.describe.configure({ mode: "serial" });

/** Throwaway-DB operator connection; verified TLS when a CA is given (remote preview DB). */
function superClient() {
  const ca = process.env.VOTE_E2E_SUPER_CA;
  if (REMOTE && !ca) throw new Error("VOTE_E2E_SUPER_CA required in REMOTE mode");
  const u = new URL(process.env.VOTE_E2E_SUPER_URL!);
  u.search = "";
  return new Client({ connectionString: u.toString(), ...(ca ? { ssl: { rejectUnauthorized: true, ca } } : {}) });
}

/** REMOTE only: clear limiter rows in the THROWAWAY database (all clients share one real IP there). */
async function resetLimits() {
  if (!REMOTE) return;
  const su = superClient();
  await su.connect();
  try {
    await su.query("delete from perc_alloc.rate_limit");
  } finally {
    await su.end();
  }
}
test.beforeEach(async ({ page }) => {
  await resetLimits();
  if (REMOTE) await page.setExtraHTTPHeaders(PROTECT);
});

let ipSeq = 10;
const ip = () => `198.51.100.${ipSeq++}`;

function raw(o: { host?: string; path: string; method?: string; body?: unknown; headers?: Record<string, string> }) {
  return new Promise<{ status: number; json: Record<string, unknown> | null; text: string }>((resolve, reject) => {
    const body = o.body === undefined ? undefined : typeof o.body === "string" ? o.body : JSON.stringify(o.body);
    const method = o.method ?? (body ? "POST" : "GET");
    const ctype = body ? { "content-type": "application/json" } : {};
    const onRes = (res: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode!, json, text });
        });
    };
    // REMOTE: the request goes to o.host (default: the preview alias) over TLS; Vercel routes by that name.
    const r = REMOTE
      ? https.request({ host: o.host ?? TARGET_HOST, port: 443, path: o.path, method, headers: { ...PROTECT, ...ctype, ...o.headers } }, onRes)
      : http.request(
          { host: "127.0.0.1", port: PORT, path: o.path, method, headers: { host: `${o.host ?? "percolator.trade"}:${PORT}`, "x-real-ip": ip(), ...ctype, ...o.headers } },
          onRes,
        );
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

async function challenge(k: nacl.SignKeyPair, choice: string) {
  return raw({ path: "/api/vote/challenge", body: { wallet: addr(k), choice } });
}
function sign(k: nacl.SignKeyPair, c: Record<string, unknown>, choice = c.choice as string) {
  const message = buildVoteMessage({ choice: choice, wallet: addr(k), nonce: c.nonce as string, issuedAt: c.issuedAt as string, expiresAt: c.expiresAt as string });
  const sig = nacl.sign.detached(Uint8Array.from(Buffer.from(message, "utf8")), k.secretKey);
  return { wallet: addr(k), choice, nonce: c.nonce, issuedAt: c.issuedAt, expiresAt: c.expiresAt, signature: bs58.encode(sig) };
}
async function vote(k: nacl.SignKeyPair, choice: string) {
  const c = await challenge(k, choice);
  expect(c.status).toBe(200);
  expect(c.json!.message).toBe(buildVoteMessage({ choice: choice, wallet: addr(k), nonce: c.json!.nonce as string, issuedAt: c.json!.issuedAt as string, expiresAt: c.json!.expiresAt as string }));
  return raw({ path: "/api/vote/submit", body: sign(k, c.json!) });
}

/** An injected Wallet Standard wallet whose signMessage is a genuine Ed25519 signature made in Node. */
async function injectWallet(page: Page, k: nacl.SignKeyPair) {
  await page.exposeBinding("__e2eSign", (_src, b64: string) => {
    const msg = Buffer.from(b64, "base64").toString("utf8");
    if (!msg.startsWith("percolator.trade PERC holder vote\n")) throw new Error("refusing to sign unexpected text");
    return Array.from(nacl.sign.detached(Uint8Array.from(Buffer.from(msg, "utf8")), k.secretKey));
  });
  await page.addInitScript(({ address, pk }) => {
    const account = { address, publicKey: new Uint8Array(pk), chains: ["solana:mainnet"], features: ["solana:signMessage"] };
    const wallet = {
      version: "1.0.0", name: "E2E Test Wallet", icon: "data:image/svg+xml;base64,PHN2Zy8+", chains: ["solana:mainnet"], accounts: [account],
      features: {
        "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) },
        "solana:signMessage": {
          version: "1.0.0",
          signMessage: async ({ message }: { message: Uint8Array }) => {
            const b64 = btoa(String.fromCharCode(...message));
            const sig = await (window as unknown as { __e2eSign: (s: string) => Promise<number[]> }).__e2eSign(b64);
            return [{ signedMessage: message, signature: new Uint8Array(sig) }];
          },
        },
      },
    };
    const cb = (api: { register: (w: unknown) => void }) => api.register(wallet);
    window.addEventListener("wallet-standard:app-ready", (e) => cb((e as CustomEvent).detail));
    window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: cb }));
  }, { address: addr(k), pk: Array.from(k.publicKey) });
}

const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
};

test("host lock: mainnet host and lookalikes 404 on vote pages and APIs", async () => {
  // REMOTE: the same deployment under its OTHER hostnames (unique URL, branch alias) must 404.
  const hosts = REMOTE ? (process.env.VOTE_E2E_OTHER_HOSTS ?? "").split(",").filter(Boolean) : ["mainnet.percolatorlaunch.com", "evilpercolator.trade"];
  expect(hosts.length).toBeGreaterThan(0);
  for (const host of hosts) {
    for (const p of ["/vote", "/vote/admin", "/api/vote/status", "/api/vote/results"]) expect((await raw({ host, path: p })).status, `${host}${p}`).toBe(404);
    expect((await raw({ host, path: "/api/vote/admin/start", body: { confirm: "START perc-fee-policy-2026-11" }, headers: { authorization: `Bearer ${ADMIN}` } })).status).toBe(404);
  }
});

test("default: NOT STARTED; nothing can be voted; results hidden", async ({ page }) => {
  expect((await raw({ path: "/api/vote/status" })).json).toMatchObject({ status: "ok", state: "not_started", starts_at: null });
  expect((await challenge(V[0]!, "buy-and-burn")).json).toMatchObject({ status: "not_started" });
  expect((await raw({ path: "/api/vote/results" })).status).toBe(409);
  await page.setExtraHTTPHeaders({ ...(REMOTE ? PROTECT : {}), "x-real-ip": ip() });
  await page.goto(`${BASE}/vote`);
  await expect(page.getByTestId("vote-state")).toHaveAttribute("data-state", "not_started");
  await shot(page, "01-not-started");
});

test("admin start refuses missing, wrong, URL-borne secrets and bad confirmation; limiter precedes the secret check", async () => {
  const confirm = { confirm: "START perc-fee-policy-2026-11" };
  expect((await raw({ path: "/api/vote/admin/start", body: confirm })).status).toBe(401);
  expect((await raw({ path: "/api/vote/admin/start", body: confirm, headers: { authorization: `Bearer ${ADMIN}x` } })).status).toBe(401);
  expect((await raw({ path: `/api/vote/admin/start?secret=${ADMIN}`, body: confirm })).status).toBe(401);
  expect((await raw({ path: "/api/vote/admin/start", body: { confirm: "START" }, headers: { authorization: `Bearer ${ADMIN}` } })).status).toBe(400);
  const one = "203.0.113.77";
  const codes = [];
  for (let i = 0; i < 6; i++) {
    codes.push((await raw({ path: "/api/vote/admin/start", body: { confirm: "nope" }, headers: { authorization: `Bearer ${i === 5 ? ADMIN : "wrong"}`, ...(REMOTE ? {} : { "x-real-ip": one }) } })).status);
  }
  expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
  expect((await raw({ path: "/api/vote/status" })).json!.state).toBe("not_started");
});

test("one-click admin start (throwaway local DB) opens exactly 24h; a second start is refused", async ({ page }) => {
  await page.setExtraHTTPHeaders({ ...(REMOTE ? PROTECT : {}), "x-real-ip": ip() });
  await page.goto(`${BASE}/vote/admin`);
  await page.locator("#vote-admin-secret").fill(ADMIN);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Start vote" }).click();
  await expect(page.getByText(/Vote started\. Closes/)).toBeVisible();
  await expect(page.locator("#vote-admin-secret")).toHaveValue("");
  const s = (await raw({ path: "/api/vote/status" })).json!;
  expect(s.state).toBe("open");
  expect(Date.parse(s.ends_at as string) - Date.parse(s.starts_at as string)).toBe(24 * 3600 * 1000);
  const again = await raw({ path: "/api/vote/admin/start", body: { confirm: "START perc-fee-policy-2026-11" }, headers: { authorization: `Bearer ${ADMIN}` } });
  expect(again.status).toBe(409);
  expect(again.json).toMatchObject({ status: "already_started", ends_at: s.ends_at });
});

test("API: genuine signed vote, replay, concurrent replay, binding, eligibility, vote change", async () => {
  // V0: weekly, then changes to buy-and-burn (last valid vote wins)
  const first = await vote(V[0]!, "weekly-fee-claims");
  expect(first.json).toMatchObject({ status: "recorded", choice: "weekly-fee-claims", revision: 1 });

  // replay of a used challenge
  const c = await challenge(V[1]!, "weekly-fee-claims");
  const body = sign(V[1]!, c.json!);
  expect((await raw({ path: "/api/vote/submit", body })).status).toBe(200);
  expect((await raw({ path: "/api/vote/submit", body })).json).toMatchObject({ status: "bad_nonce" });

  // concurrent replay of one fresh challenge: exactly one recorded
  const c2 = await challenge(V[3]!, "buy-and-burn");
  const b2 = sign(V[3]!, c2.json!);
  const rs = await Promise.all(Array.from({ length: 8 }, () => raw({ path: "/api/vote/submit", body: b2 })));
  expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
  expect(rs.filter((r) => r.json?.status === "bad_nonce")).toHaveLength(7);

  // choice swapped after signing -> signature check fails
  const c3 = await challenge(V[2]!, "buy-and-burn");
  const swapped = { ...sign(V[2]!, c3.json!), choice: "weekly-fee-claims" };
  expect((await raw({ path: "/api/vote/submit", body: swapped })).status).toBe(401);
  // a valid signature for the other choice with this challenge -> nonce/choice binding refuses it
  expect((await raw({ path: "/api/vote/submit", body: sign(V[2]!, c3.json!, "weekly-fee-claims") })).json).toMatchObject({ status: "bad_nonce" });
  // another wallet cannot use V2's challenge
  expect((await raw({ path: "/api/vote/submit", body: { ...sign(V[3]!, c3.json!), wallet: addr(V[3]!) } })).json).toMatchObject({ status: "bad_nonce" });

  // ineligible: excluded and unknown wallets
  expect((await challenge(X!, "buy-and-burn")).json).toMatchObject({ status: "not_eligible" });
  expect((await challenge(nacl.sign.keyPair(), "buy-and-burn")).status).toBe(403);

  // strict validation
  expect((await raw({ path: "/api/vote/challenge", body: [{ wallet: addr(V[0]!), choice: "buy-and-burn" }] })).status).toBe(400);
  expect((await raw({ path: "/api/vote/challenge", body: "x".repeat(5000) })).status).toBe(413);
  expect((await raw({ path: "/api/vote/challenge", body: { wallet: addr(V[0]!), choice: "buy-and-burn" }, headers: { origin: "https://evil.example" } })).status).toBe(403);

  // change of vote
  const changed = await vote(V[0]!, "buy-and-burn");
  expect(changed.json).toMatchObject({ status: "recorded", choice: "buy-and-burn", revision: 2 });

  // results hidden while open
  expect((await raw({ path: "/api/vote/results" })).json).toMatchObject({ status: "open", final: false });
});

test("UI: connect an injected Wallet Standard wallet, sign, vote recorded (desktop + mobile)", async ({ page, browser }) => {
  await injectWallet(page, V[2]!);
  await page.setExtraHTTPHeaders({ ...(REMOTE ? PROTECT : {}), "x-real-ip": ip() });
  await page.goto(`${BASE}/vote`);
  await expect(page.getByTestId("vote-state")).toHaveAttribute("data-state", "open");
  await page.getByRole("button", { name: "Connect E2E Test Wallet" }).click();
  await page.getByLabel("Weekly fee claims").check();
  await page.getByTestId("vote-submit").click();
  await expect(page.getByTestId("vote-result")).toHaveAttribute("data-status", "recorded");
  await expect(page.getByTestId("vote-result")).toContainText("Vote recorded: Weekly fee claims");
  await shot(page, "02-open-voted-desktop");

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, extraHTTPHeaders: REMOTE ? PROTECT : {} });
  const m = await mobile.newPage();
  await m.setExtraHTTPHeaders({ ...(REMOTE ? PROTECT : {}), "x-real-ip": ip() });
  await m.goto(`${BASE}/vote`);
  await expect(m.getByTestId("vote-state")).toHaveAttribute("data-state", "open");
  await expect(m.getByText("No Solana wallet with message signing was found in this browser.")).toBeVisible();
  await shot(m, "03-open-no-wallet-mobile");
  await mobile.close();
});

test("after close: writes refused; final aggregate is an exact balance tie -> buy-and-burn", async ({ page }) => {
  // Votes: V0 burn 1.0, V1 weekly 2.0, V2 weekly 3.0 (UI), V3 burn 4.0 => 5.0 vs 5.0 tie.
  const su = superClient();
  await su.connect();
  try {
    // Test-only time travel in the throwaway DB: move window AND ballots back by the same amount.
    const r = await su.query("select extract(epoch from (clock_timestamp() - starts_at + interval '24 hours 61 seconds'))::text as s from perc_vote.poll");
    const secs = r.rows[0].s as string;
    await su.query("update perc_vote.ballot set cast_at = cast_at - make_interval(secs => $1::float8)", [secs]);
    await su.query("update perc_vote.poll set starts_at = starts_at - make_interval(secs => $1::float8), ends_at = ends_at - make_interval(secs => $1::float8)", [secs]);
  } finally {
    await su.end();
  }
  expect((await raw({ path: "/api/vote/status" })).json!.state).toBe("closed");
  expect((await challenge(V[1]!, "buy-and-burn")).json).toMatchObject({ status: "closed" });
  const res = await raw({ path: "/api/vote/results" });
  expect(res.status).toBe(200);
  expect(res.json).toMatchObject({
    status: "final",
    winner: "buy-and-burn",
    results: {
      "weekly-fee-claims": { balance: "5", wallets: 2, share_of_votes_percent: "50.00" },
      "buy-and-burn": { balance: "5", wallets: 2, share_of_votes_percent: "50.00" },
    },
    turnout: { voted_balance: "10", eligible_balance: "10", eligible_wallets: 4, percent: "100.00" },
  });
  expect(res.text).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
  await page.setExtraHTTPHeaders({ ...(REMOTE ? PROTECT : {}), "x-real-ip": ip() });
  await page.goto(`${BASE}/vote`);
  await expect(page.getByTestId("vote-results")).toContainText("Result: Buy and burn");
  await shot(page, "04-closed-tie-buy-and-burn");
});
