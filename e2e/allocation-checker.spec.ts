/**
 * /allocation end to end against a production server (`next start`) and a
 * local Postgres, driven by app/scripts/allocation/e2e-local.ts.
 *
 * SKIPPED unless ALLOC_E2E_PORT and ALLOC_E2E_CASES are set (CI does not run
 * the local database harness). Cases come from a JSON file outside the repo:
 * synthetic for the tracked run, private for the real-data run. Test titles
 * and logs never include a wallet address.
 */
import { test, expect, devices, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

interface Cases {
  eligible: { wallet: string; balance: string; usd: string }[];
  excluded: { wallet: string; reasons: string[] };
  /** optional: an owner counted under an approved balance exception */
  exception?: { wallet: string; balance: string; usd: string };
  unknown: string;
  screenshots: boolean;
}

const PORT = Number(process.env.ALLOC_E2E_PORT);
const CASES_PATH = process.env.ALLOC_E2E_CASES;
const SHOTS = process.env.ALLOC_E2E_SHOTS;
const enabled = Number.isInteger(PORT) && PORT > 0 && !!CASES_PATH;
const cases: Cases = enabled ? JSON.parse(fs.readFileSync(CASES_PATH!, "utf8")) : ({} as Cases);
const BASE = `http://percolator.trade:${PORT}`;

test.skip(!enabled, "local allocation E2E harness not configured");

// Both hostnames resolve to the local server; the app routes on the Host header.
test.use({
  launchOptions: {
    args: [`--host-resolver-rules=MAP percolator.trade 127.0.0.1, MAP mainnet.percolatorlaunch.com 127.0.0.1`],
  },
});

let ipSeq = 10;
/** A fresh client identity per test so the per-client limiter is exercised deliberately, not by accident. */
async function freshClient(page: Page) {
  await page.setExtraHTTPHeaders({ "x-real-ip": `198.51.100.${ipSeq++}` });
}

function raw(opts: { host: string; path: string; method?: string; body?: string; headers?: Record<string, string> }) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port: PORT, path: opts.path, method: opts.method ?? "GET", headers: { host: `${opts.host}:${PORT}`, ...opts.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    r.on("error", reject);
    if (opts.body !== undefined) r.write(opts.body);
    r.end();
  });
}
const check = (body: string, ip: string, host = "percolator.trade", type = "application/json") =>
  raw({ host, path: "/api/allocation/check", method: "POST", body, headers: { "content-type": type, "x-real-ip": ip } });

const group = (d: string) => {
  const [i, f] = d.split(".");
  const g = i!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return f ? `${g}.${f}` : g;
};

async function lookUp(page: Page, wallet: string) {
  await page.getByPlaceholder("Solana wallet address").fill(wallet);
  await page.getByRole("button", { name: "Check" }).click();
  await expect(page.getByTestId("alloc-result")).toBeVisible();
}

test.describe("desktop", () => {
  test("three eligible wallets show their exact balance and provisional allocation", async ({ page }) => {
    await freshClient(page);
    await page.goto(`${BASE}/allocation`);
    await expect(page.getByRole("heading", { name: "PERC allocation checker" })).toBeVisible();
    expect(cases.eligible).toHaveLength(3);
    for (const c of cases.eligible) {
      await lookUp(page, c.wallet);
      await expect(page.getByTestId("alloc-result")).toHaveAttribute("data-status", "eligible");
      await expect(page.getByTestId("alloc-balance-label")).toHaveText("Snapshot balance (7 Nov 2026)");
      await expect(page.getByTestId("alloc-balance")).toHaveText(`${group(c.balance)} PERC`);
      await expect(page.getByTestId("alloc-usd")).toHaveText(`$${group(c.usd)}`);
    }
  });

  test("an approved-exception owner is eligible with a neutral 'counted balance' label", async ({ page }) => {
    test.skip(!cases.exception, "no exception case supplied");
    await freshClient(page);
    await page.goto(`${BASE}/allocation`);
    await lookUp(page, cases.exception!.wallet);
    await expect(page.getByTestId("alloc-result")).toHaveAttribute("data-status", "eligible");
    await expect(page.getByTestId("alloc-balance-label")).toHaveText("Counted balance (approved exception)");
    await expect(page.getByTestId("alloc-balance")).toHaveText(`${group(cases.exception!.balance)} PERC`);
    await expect(page.getByTestId("alloc-usd")).toHaveText(`$${group(cases.exception!.usd)}`);
    await expect(page.getByTestId("alloc-result")).not.toContainText(/founder|team/i);
  });

  test("a known excluded wallet shows its exclusion reasons and no allocation", async ({ page }) => {
    await freshClient(page);
    await page.goto(`${BASE}/allocation`);
    await lookUp(page, cases.excluded.wallet);
    await expect(page.getByTestId("alloc-result")).toHaveAttribute("data-status", "excluded");
    for (const r of cases.excluded.reasons) await expect(page.getByTestId("alloc-reasons")).toContainText(r);
    await expect(page.getByTestId("alloc-usd")).toHaveCount(0);
  });

  test("a valid unknown wallet is 'not in the snapshot' with no figures", async ({ page }) => {
    await freshClient(page);
    await page.goto(`${BASE}/allocation`);
    await lookUp(page, cases.unknown);
    await expect(page.getByTestId("alloc-result")).toHaveAttribute("data-status", "not_found");
    await expect(page.getByTestId("alloc-result")).toContainText("This wallet is not in the 7 Nov 2026 snapshot.");
    await expect(page.getByTestId("alloc-balance")).toHaveCount(0);
    await expect(page.getByTestId("alloc-usd")).toHaveCount(0);
  });

  test("editing the address clears the previous wallet's result", async ({ page }) => {
    await freshClient(page);
    await page.goto(`${BASE}/allocation`);
    await lookUp(page, cases.eligible[0]!.wallet);
    await page.getByPlaceholder("Solana wallet address").fill(cases.unknown);
    await expect(page.getByTestId("alloc-result")).toHaveCount(0);
  });

  test("invalid input in the UI shows the validation message", async ({ page }) => {
    await freshClient(page);
    await page.goto(`${BASE}/allocation`);
    await lookUp(page, "0OIl" + "1".repeat(30));
    await expect(page.getByTestId("alloc-result")).toHaveAttribute("data-status", "invalid");
    await lookUp(page, `${cases.eligible[0]!.wallet} ${cases.eligible[1]!.wallet}`);
    await expect(page.getByTestId("alloc-result")).toHaveAttribute("data-status", "invalid");
    await page.getByPlaceholder("Solana wallet address").fill("");
    await expect(page.getByRole("button", { name: "Check" })).toBeDisabled();
  });
});

test.describe("API: invalid and abusive input", () => {
  const W = () => cases.eligible[0]!.wallet;
  const cases400: [string, () => string][] = [
    ["array body", () => JSON.stringify([{ wallet: W() }])],
    ["wallet array", () => JSON.stringify({ wallet: [W(), cases.unknown] })],
    ["extra key", () => JSON.stringify({ wallet: W(), extra: 1 })],
    ["comma batch", () => JSON.stringify({ wallet: `${W()},${cases.unknown}` })],
    ["newline batch", () => JSON.stringify({ wallet: `${W()}\n${cases.unknown}` })],
    ["non-canonical (extra leading 1)", () => JSON.stringify({ wallet: "1" + W() })],
    ["sql-ish", () => JSON.stringify({ wallet: "' or 1=1 --" })],
    ["not json", () => "{wallet:"],
  ];
  for (const [label, body] of cases400) {
    test(`${label} -> 400`, async () => {
      const r = await check(body(), "203.0.113.200");
      expect(r.status).toBe(400);
      expect(JSON.parse(r.body).status).toBe("invalid");
      expect(r.headers["cache-control"]).toMatch(/no-store/);
    });
  }
  test("oversize -> 413, form-encoded -> 415, GET -> 405", async () => {
    expect((await check(JSON.stringify({ wallet: "1".repeat(5000) }), "203.0.113.201")).status).toBe(413);
    expect((await check(`wallet=${W()}`, "203.0.113.201", "percolator.trade", "application/x-www-form-urlencoded")).status).toBe(415);
    expect((await raw({ host: "percolator.trade", path: "/api/allocation/check" })).status).toBe(405);
  });
});

test.describe("rate limit (durable, database-backed)", () => {
  test("10 lookups per client per minute, then 429 with Retry-After; another client is unaffected", async () => {
    const ip = "203.0.113.77";
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await check(JSON.stringify({ wallet: cases.unknown }), ip)).status);
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
    const last = await check(JSON.stringify({ wallet: cases.unknown }), ip);
    expect(last.status).toBe(429);
    expect(Number(last.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(last.body)).toMatchObject({ status: "rate_limited" });
    expect((await check(JSON.stringify({ wallet: cases.unknown }), "203.0.113.78")).status).toBe(200);
  });

  test("the UI shows the rate-limit message", async ({ page }) => {
    await page.setExtraHTTPHeaders({ "x-real-ip": "203.0.113.79" });
    for (let i = 0; i < 10; i++) await check(JSON.stringify({ wallet: cases.unknown }), "203.0.113.79");
    await page.goto(`${BASE}/allocation`);
    await lookUp(page, cases.unknown);
    await expect(page.getByTestId("alloc-result")).toHaveAttribute("data-status", "rate_limited");
  });
});

test.describe("host lock, noindex, existing surfaces", () => {
  for (const host of ["mainnet.percolatorlaunch.com", "localhost", "127.0.0.1", "percolator-launch.vercel.app", "www.percolator.trade.evil.com"]) {
    test(`${host}: page and API 404, before any lookup`, async () => {
      expect((await raw({ host, path: "/allocation" })).status).toBe(404);
      expect((await raw({ host, path: "/api/allocation/status" })).status).toBe(404);
      const r = await check(JSON.stringify({ wallet: cases.eligible[0]!.wallet }), "203.0.113.90", host);
      expect(r.status).toBe(404);
      expect(r.body).not.toMatch(/eligible|snapshot|PERC/);
    });
  }

  test("browser on mainnet.percolatorlaunch.com gets 404 for /allocation", async ({ page }) => {
    const res = await page.goto(`http://mainnet.percolatorlaunch.com:${PORT}/allocation`);
    expect(res!.status()).toBe(404);
  });

  test("percolator.trade: /allocation is noindex; homepage/waitlist and disabled vote preserved", async ({ page }) => {
    const res = await page.goto(`${BASE}/allocation`);
    expect(res!.headers()["x-robots-tag"]).toBe("noindex, nofollow");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    const home = await page.goto(`${BASE}/`);
    expect(home!.status()).toBe(200);
    expect(await page.locator('a[href*="allocation"]').count()).toBe(0);
    await page.goto(`${BASE}/vote`);
    await expect(page.getByText("Voting is not open.")).toBeVisible();
    const vs = await raw({ host: "percolator.trade", path: "/api/vote/status" });
    expect(JSON.parse(vs.body)).toEqual({ state: "UNAVAILABLE", open: false });
  });

  test("page HTML and RSC payload carry no case wallet", async () => {
    const html = await raw({ host: "percolator.trade", path: "/allocation" });
    const rsc = await raw({ host: "percolator.trade", path: "/allocation", headers: { RSC: "1" } });
    for (const w of [...cases.eligible.map((c) => c.wallet), cases.excluded.wallet]) {
      expect(html.body.includes(w)).toBe(false);
      expect(rsc.body.includes(w)).toBe(false);
    }
  });
});

test.describe("mobile", () => {
  // defaultBrowserType cannot be set per describe group; the rest of the device profile can.
  const { defaultBrowserType: _ignored, ...pixel5 } = devices["Pixel 5"];
  test.use(pixel5);

  test("mobile success: eligible result fits the screen", async ({ page }) => {
    await freshClient(page);
    await page.goto(`${BASE}/allocation`);
    const c = cases.eligible[2]!;
    await lookUp(page, c.wallet);
    await expect(page.getByTestId("alloc-usd")).toHaveText(`$${group(c.usd)}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    if (cases.screenshots && SHOTS) await page.screenshot({ path: path.join(SHOTS, "mobile-success.png"), fullPage: true });
  });

  test("mobile error: invalid input message", async ({ page }) => {
    await freshClient(page);
    await page.goto(`${BASE}/allocation`);
    await lookUp(page, "not-a-wallet");
    await expect(page.getByTestId("alloc-result")).toHaveAttribute("data-status", "invalid");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    if (cases.screenshots && SHOTS) await page.screenshot({ path: path.join(SHOTS, "mobile-error.png"), fullPage: true });
  });
});
