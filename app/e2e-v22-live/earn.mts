/** Earn: select a vault row, deposit, then withdraw from the same rail; each prompt checked on chain. */
import { openSession, connectViaUi, dump, sigStatus, tokenBalance, USDC_V22, traceRpc, OUT_DIR } from "./harness.mts";
import fs from "node:fs";
const flow = process.argv[2]; const market = process.argv[3] ?? "SOL"; const amt = process.env.AMT ?? "25";
const s = await openSession(flow, { keypair: process.env.E2E_KEYPAIR });
const { page } = s; const trace: string[] = []; await traceRpc(page, trace);
const step = async (label: string, from: number) => {
  for (let k = 0; k < 12; k++) { await page.waitForTimeout(2500); const st = (await page.locator("[data-testid^=status-line], [role=status], [role=alert]").allTextContents().catch(() => [])).join(" | ").trim(); if (st) s.note(`${label} t+${(k + 1) * 2.5}s: ${st.slice(0, 260)}`); }
  for (const e of s.log.slice(from)) if (e.sig) s.note(`${label} prompt ixs=${e.ixCount} ${JSON.stringify(await sigStatus(e.sig))}`);
  s.note(`${label} prompts: ${s.log.length - from}; wallet USDC ${await tokenBalance(s.kp.publicKey, USDC_V22)}`);
};
try {
  await connectViaUi(s);
  await page.goto(new URL("/earn", page.url()).toString());
  await page.getByTestId("vault-table").waitFor({ timeout: 30_000 });
  await page.getByTestId("vault-table").locator("button").filter({ hasText: new RegExp(`^\\s*${market}\\s*\\$`) }).first().click();
  await page.waitForTimeout(3000);
  s.note(`rail: ${(await page.locator("[data-testid^=earn-rail-figure]").allTextContents()).join(" · ")}`);
  if (process.env.SKIP_DEPOSIT !== "1") {
    const n0 = s.log.length;
    await page.getByTestId("earn-deposit-input").fill(amt);
    await page.waitForTimeout(1500);
    await s.shot("deposit-filled");
    await page.getByTestId("earn-deposit-submit").click();
    await step("deposit", n0);
    await s.shot("after-deposit");
    s.note(`rail: ${(await page.locator("[data-testid^=earn-rail-figure]").allTextContents()).join(" · ")}`);
  }
  await page.getByTestId("earn-tab").filter({ hasText: /withdraw/i }).click();
  await page.waitForTimeout(2500);
  console.log("---- withdraw rail ----\n" + (await dump(page, "main")).split("\n").filter((l) => /earn|withdraw|max|%|cool|exit/i.test(l)).slice(-30).join("\n"));
  await s.shot("withdraw-tab");
  if (process.env.WITHDRAW !== "0") {
    const n1 = s.log.length;
    const all = page.getByRole("button", { name: /^100%$|withdraw all|^max/i }).last();
    await all.click().catch(() => s.note("no max/100% button"));
    await page.waitForTimeout(1500);
    const submit = page.locator("[data-testid=earn-withdraw-submit], [data-testid=earn-withdraw-request]").first();
    s.note(`withdraw submit: ${await submit.textContent().catch(() => "?")}`);
    await submit.click({ timeout: 10_000 });
    await step("withdraw", n1);
    await s.shot("after-withdraw");
    console.log("---- after ----\n" + (await dump(page, "main")).split("\n").filter((l) => /earn|withdraw|claim|cool|exit|request/i.test(l)).slice(-25).join("\n"));
  }
} catch (e) { s.note(`FAIL ${String(e).slice(0, 600)}`); await s.shot("fail"); } finally {
  fs.writeFileSync(`${OUT_DIR}/${flow}-rpctrace.txt`, trace.join("\n"));
  s.note(`rpc errors: ${trace.filter((l) => /err=\{|rpcerr/.test(l)).map((l) => l.slice(25, 300)).join("\n")}`);
  await s.close();
}
