import { test } from "@playwright/test";
import fs from "node:fs";
import { installTestWallet } from "../../wallet/inject.ts";
import * as P from "../../lib/perc.ts";

test.skip(!process.env.EXPLORE, "exploration only (EXPLORE=1)");
test("explore trade page", async ({ page }) => {
  const kp = await P.newWallet({ sol: 5, usdc: 5_000_000_000n });
  await installTestWallet(page, kp);
  const m = P.markets()[process.env.SYM ?? "SOL"];
  await page.goto(process.env.PATHNAME ?? `/trade/${m.slab}`);
  await page.waitForTimeout(15000);
  await page.screenshot({ path: `.run/shots/explore-${process.env.TAG ?? "trade"}.png`, fullPage: true });
  const btns = await page.getByRole("button").evaluateAll((els) => els.map((e) => (e.getAttribute("aria-label") || e.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60)).filter(Boolean));
  const inputs = await page.locator("input").evaluateAll((els) => els.map((e) => `${e.getAttribute("aria-label") ?? ""}|${e.getAttribute("placeholder") ?? ""}|${e.getAttribute("type")}`));
  fs.writeFileSync(`.run/explore-${process.env.TAG ?? "trade"}.json`, JSON.stringify({ btns, inputs, text: (await page.locator("body").innerText()).slice(0, 6000) }, null, 1));
});
