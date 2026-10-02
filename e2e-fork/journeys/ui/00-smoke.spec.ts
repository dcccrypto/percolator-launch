import { test, expect } from "@playwright/test";
import { Keypair } from "@solana/web3.js";
import { installTestWallet } from "../../wallet/inject.ts";

test("smoke: markets list renders 6 fork markets and the test wallet connects", async ({ page }) => {
  const kp = Keypair.generate();
  await installTestWallet(page, kp);
  const errs: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  await page.goto("/markets");
  await page.waitForTimeout(8000);
  await page.screenshot({ path: ".run/shots/00-markets.png", fullPage: true });
  const short = kp.publicKey.toBase58().slice(0, 4);
  const body = await page.locator("body").innerText();
  console.log("wallet shown:", body.includes(short), "errors:", errs.slice(0, 5));
  for (const s of ["SOL", "JUP", "TRUMP", "PENGU", "BURNIE", "Percolator"]) expect(body).toContain(s);
});
