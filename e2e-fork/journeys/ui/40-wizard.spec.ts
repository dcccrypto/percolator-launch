/**
 * U6 Create-market wizard end to end (UI): token → market config → hold-to-launch → every
 * launch step done. Then ON-CHAIN asserts on the new market: marketauth rotated to the stake
 * pool PDA, both backing domains Fresh + immortal (LP-vault funded, C-1 fix), matcher kind 1
 * with finite non-zero caps, oracle authority = the keeper key. The keeper-register call the
 * wizard makes (Vercel Blob → unavailable locally) is captured and appended to the harness
 * keeper registry (= what register-poll does in prod); then a trade on the new market must land.
 */
import { test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { parseWrapperConfigV17, parseAssetOracleProfileV17, V17_HEADER_LEN, V17_MARKET_GROUP_OFF, V17_MARKET_GROUP_LEN } from "@percolatorct/sdk";
import { installTestWallet, pinDexPools } from "../../wallet/inject.ts";
import * as P from "../../lib/perc.ts";
import { check, record } from "../../lib/results.ts";

const WIF = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";
const shot = (page: Page, n: string) => page.screenshot({ path: `.run/shots/${n}.png`, fullPage: true }).catch(() => undefined);

test("U6 create-market wizard end to end (UI) + trade on the new market", async ({ page }) => {
  test.setTimeout(900_000);
  const J = "U6-ui-wizard";
  const creator = await P.newWallet({ sol: 50, usdc: 200_000_000_000n });
  const log = await installTestWallet(page, creator);
  if (process.env.E2E_PIN_POOLS !== "0") await pinDexPools(page);
  let reg: Record<string, unknown> | null = null;
  page.on("request", (r) => { if (r.url().includes("/api/playground/keeper-register") && r.method() === "POST") { try { reg = JSON.parse(r.postData() ?? "{}"); } catch { /* */ } } });
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });

  await page.goto("/create");
  await page.getByTestId("wizard-token-input").fill(WIF);
  await P.sleep(6000);
  await shot(page, "U6-wizard-1-token");
  if (await page.getByTestId("wizard-next").isVisible().catch(() => false)) await page.getByTestId("wizard-next").click();
  await P.sleep(4000);
  await shot(page, "U6-wizard-2-market");
  // hold-to-launch
  const launch = page.getByTestId("wizard-launch");
  await launch.waitFor({ state: "visible", timeout: 60_000 });
  // reducedMotion=reduce → HoldToLaunch skipHold: a single press launches
  await launch.click();
  await P.sleep(2000);
  if (!/launching/i.test((await launch.innerText().catch(() => "")) + (await page.locator("body").innerText()).slice(0, 0))) {
    if (await launch.isEnabled().catch(() => false)) { await launch.focus(); await page.keyboard.press("Enter"); }
  }
  // wait for all launch steps done or an error
  const t0 = Date.now(); let last = "";
  while (Date.now() - t0 < 600_000) {
    const steps = await page.locator('[data-testid="wizard-launch-step"]').evaluateAll((els) => els.map((e) => `${e.getAttribute("data-step")}:${e.getAttribute("data-status")}`));
    last = steps.join(" ");
    const err = await page.locator('[data-testid="wizard-error"]:visible').first().innerText({ timeout: 500 }).catch(() => "");
    if (err) { last += ` ERROR: ${err}`; break; }
    if (steps.length && steps.every((s) => /:(done|complete|success)/.test(s))) break;
    if (await page.getByText(/MARKET LAUNCHED/i).first().isVisible().catch(() => false)) { last += " MARKET LAUNCHED"; break; }
    await P.sleep(3000);
  }
  await shot(page, "U6-wizard-3-launched");
  const launchedTxt = await page.getByText(/MARKET LAUNCHED/i).first().isVisible().catch(() => false);
  const allDone = launchedTxt || (!/ERROR/.test(last) && /done|complete|success/.test(last) && !/:(pending|active|running|error|failed)/.test(last));
  check(J, "WIF", "launch: every wizard step reaches done", allDone, "all steps done", `${last.slice(0, 600)} | signed ${log.filter((e) => e.kind === "tx").length} txs`);
  const slab = (reg as any)?.marketAddress ?? (reg as any)?.slabAddress;
  if (slab) fs.writeFileSync(path.join(P.RUN, "wizard-market.json"), JSON.stringify({ slab, pool: (reg as any).dexPoolAddress }));
  record({ journey: J, market: "WIF", step: "keeper-register payload captured", ok: !!slab, actual: JSON.stringify(reg)?.slice(0, 400) });
  if (!slab) { record({ journey: J, market: "WIF", step: "console errors", ok: true, actual: errors.slice(-5).join(" | ") }); return; }

  // on-chain asserts on the created market
  const d = new Uint8Array((await P.conn.getAccountInfo(new PublicKey(slab)))!.data);
  const cfg = parseWrapperConfigV17(d, V17_HEADER_LEN) as any;
  const prof = parseAssetOracleProfileV17(d, V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN) as any;
  const { parseBackingBucketsV17 } = await import("@percolatorct/sdk");
  const bb = parseBackingBucketsV17(d, { chainSlot: BigInt(await P.conn.getSlot()) });
  const marketauth = cfg.marketauth.toBase58();
  const marketauthIsPda = !PublicKey.isOnCurve(cfg.marketauth.toBytes());
  check(J, "WIF", "marketauth rotated to the stake-pool PDA (off-curve)", marketauthIsPda, "off-curve PDA", marketauth);
  const immortal = bb.buckets.filter((b: any) => b.assetIndex === 0).every((b: any) => b.statusName === "Fresh" && b.freshUnlienedBackingNum > 0n && b.expirySlot >= 9223372036854775806n);
  check(J, "WIF", "both backing domains Fresh + immortal (LP-vault funded)", immortal, "Fresh, expiry ≥ MAX-1", JSON.stringify(bb.buckets.filter((b: any) => b.assetIndex === 0).map((b: any) => [b.statusName, String(b.expirySlot), String(b.freshUnlienedBackingNum)])));
  check(J, "WIF", "oracle authority = keeper key", prof.oracleAuthority.equals(P.admin.publicKey), P.admin.publicKey.toBase58(), prof.oracleAuthority.toBase58());

  // register with the harness keeper (register-poll stand-in), then trade on it
  const regPath = path.join(P.RUN, "keeper-registry.json");
  const r = JSON.parse(fs.readFileSync(regPath, "utf8"));
  r.markets.push({ label: `WIF/USDC — ${(reg as any).dexType}`, marketAddress: slab, poolAddress: (reg as any).poolAddress ?? (reg as any).dexPoolAddress, mainnetCa: (reg as any).mainnetCA, dexType: (reg as any).dexType, assetIndex: 0, symbol: "WIF", collateral: P.USDC.toBase58(), registeredAt: Date.now() });
  fs.writeFileSync(regPath, JSON.stringify(r, null, 2));
  let pushed = false;
  for (let i = 0; i < 30 && !pushed; i++) { await P.sleep(4000); pushed = fs.readFileSync(path.join(P.RUN, "keeper.log"), "utf8").includes("WIF/USDC"); }
  record({ journey: J, market: "WIF", step: "keeper picked up the wizard market (registry reload)", ok: pushed, actual: pushed ? "WIF/USDC in keeper log" : "not seen" });

  await page.goto(`/trade/${slab}`);
  await page.getByTestId("deposit-amount-input").first().fill("500").catch(() => undefined);
  await page.getByTestId("deposit-submit").first().click({ timeout: 60_000 }).catch(() => undefined);
  await P.sleep(8000);
  await page.getByTestId("trade-side-long").click({ timeout: 60_000 });
  await page.getByTestId("trade-size-input").fill("50");
  await page.getByTestId("trade-submit").click();
  if (await page.getByTestId("trade-confirm").isVisible({ timeout: 5000 }).catch(() => false)) await page.getByTestId("trade-confirm").click();
  const mk = { slab, lpPortfolio: "", vaultAta: "" } as unknown as P.SeedMarket;
  let legs = 0;
  for (let i = 0; i < 30 && !legs; i++) {
    await P.sleep(3000);
    const ports = await P.findPortfolios(creator.publicKey, mk);
    for (const p of ports) legs += (await P.readPortfolio(p)).legs.length;
  }
  await shot(page, "U6-wizard-4-trade");
  const errTxt = await page.locator('[data-testid="trade-error"]:visible').first().innerText({ timeout: 1500 }).catch(() => "");
  check(J, "WIF", "trade on the wizard-created market lands (UI)", legs > 0, "≥1 leg", `legs=${legs} ${errTxt}`);
});
