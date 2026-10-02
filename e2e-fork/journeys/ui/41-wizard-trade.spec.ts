/** U6b: trade (UI) on the market the wizard created in U6 (.run/wizard-market.json). */
import { test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { installTestWallet } from "../../wallet/inject.ts";
import * as P from "../../lib/perc.ts";
import { check } from "../../lib/results.ts";

test("U6b trade on the wizard-created market (UI)", async ({ page }) => {
  const f = path.join(P.RUN, "wizard-market.json");
  test.skip(!fs.existsSync(f), "no wizard market");
  const { slab } = JSON.parse(fs.readFileSync(f, "utf8"));
  const mk = { slab } as unknown as P.SeedMarket;
  // wait for the keeper to price it (lastGoodOracleSlot recent)
  let fresh = false;
  for (let i = 0; i < 60 && !fresh; i++) { const s = await P.readMarket(mk).catch(() => null); fresh = !!s && s.chainSlot - s.lastGoodOracleSlot < 150n; if (!fresh) await P.sleep(3000); }
  check("U6-ui-wizard", "WIF", "keeper prices the wizard market (fresh AuthMark)", fresh, "last_good_oracle_slot within 100 slots", `${fresh}`);
  const kp = await P.newWallet({ usdc: 2_000_000_000n });
  await installTestWallet(page, kp);
  await page.goto(`/trade/${slab}`);
  await page.getByTestId("deposit-amount-input").first().fill("500");
  await page.getByTestId("deposit-submit").first().click();
  let port: import("@solana/web3.js").PublicKey | undefined;
  for (let i = 0; i < 30 && !port; i++) { await P.sleep(3000); port = (await P.findPortfolios(kp.publicKey, mk))[0]; }
  await P.sleep(3000);
  await page.getByTestId("trade-side-long").click();
  await page.getByTestId("trade-size-input").fill("50");
  await page.getByTestId("trade-submit").click({ timeout: 60_000 });
  if (await page.getByTestId("trade-confirm").isVisible({ timeout: 5000 }).catch(() => false)) await page.getByTestId("trade-confirm").click();
  let legs = 0;
  for (let i = 0; i < 30 && port && !legs; i++) { await P.sleep(3000); legs = (await P.readPortfolio(port)).legs.length; }
  await page.screenshot({ path: ".run/shots/U6b-wizard-trade.png", fullPage: true });
  const errTxt = await page.locator('[data-testid="trade-error"]:visible').first().innerText({ timeout: 1500 }).catch(() => "");
  check("U6-ui-wizard", "WIF", "trade on the wizard-created market lands (UI, kind-1 matcher)", legs > 0, "≥1 leg", `legs=${legs} ${errTxt}`);
});
