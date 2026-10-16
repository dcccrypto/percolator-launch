/** Fee staking: select a pool, deposit, then withdraw; each prompt checked on chain. */
import { openSession, connectViaUi, dump, sigStatus, tokenBalance, USDC_V22, traceRpc } from "./harness.mts";
const flow = process.argv[2]; const pool = process.argv[3] ?? "SOL"; const amt = process.env.AMT ?? "20";
const s = await openSession(flow, { keypair: process.env.E2E_KEYPAIR });
const { page } = s; const trace: string[] = []; await traceRpc(page, trace);
const watch = async (label: string, from: number) => {
  for (let k = 0; k < 12; k++) { await page.waitForTimeout(2500); const st = (await page.locator("[data-testid^=status-line], [role=status], [role=alert], [data-testid*=stake-result], [data-testid*=stake-error]").allTextContents().catch(() => [])).join(" | ").trim(); if (st) s.note(`${label} t+${(k + 1) * 2.5}s: ${st.slice(0, 260)}`); }
  for (const e of s.log.slice(from)) if (e.sig) s.note(`${label} prompt ixs=${e.ixCount} ${JSON.stringify(await sigStatus(e.sig))}`);
  s.note(`${label} prompts ${s.log.length - from}; USDC ${await tokenBalance(s.kp.publicKey, USDC_V22)}`);
};
try {
  await connectViaUi(s);
  await page.goto(new URL("/stake", page.url()).toString());
  await page.getByRole("button", { name: new RegExp(`^Select ${pool} pool`) }).click({ timeout: 30_000 });
  await page.waitForTimeout(3000);
  if (process.env.SKIP_DEPOSIT !== "1") {
    const n0 = s.log.length;
    await page.getByTestId("stake-deposit-input").fill(amt);
    if (await page.getByTestId("consent-check").isVisible().catch(() => false)) await page.getByTestId("consent-check").check();
    await page.waitForTimeout(1500);
    const dsub = page.locator("[data-testid=first-loss-submit], [data-testid=stake-deposit-submit]").first();
    s.note(`deposit submit: ${await dsub.textContent()}`);
    await s.shot("deposit-filled");
    await dsub.click();
    await watch("deposit", n0);
    await s.shot("after-deposit");
    s.note(`pool row: ${await page.getByRole("button", { name: new RegExp(`^Select ${pool} pool`) }).textContent()}`);
  }
  await page.getByTestId("stake-tab-withdraw").click();
  await page.waitForTimeout(3000);
  console.log("---- withdraw ----\n" + (await dump(page, "main")).split("\n").filter((l) => /stake|withdraw|max|%|cool|unlock|share/i.test(l)).slice(-25).join("\n"));
  await s.shot("withdraw-tab");
  if (process.env.WITHDRAW !== "0") {
    const n1 = s.log.length;
    await page.getByRole("button", { name: /^(MAX|100%)$/ }).last().click().catch(() => s.note("no MAX"));
    await page.waitForTimeout(1500);
    console.log("---- withdraw panel ----\n" + (await dump(page, "main")).split("\n").filter((l) => /#(stake|first-loss|fl-|withdraw)/.test(l)).join("\n"));
    const submit = page.locator("[data-testid=stake-withdraw-submit], [data-testid=first-loss-withdraw-submit]").first();
    s.note(`withdraw submit: ${await submit.textContent().catch(() => "?")}`);
    await submit.click({ timeout: 10_000 });
    await watch("withdraw", n1);
    await s.shot("after-withdraw");
  }
} catch (e) { s.note(`FAIL ${String(e).slice(0, 600)}`); await s.shot("fail"); } finally {
  s.note(`rpc errors: ${trace.filter((l) => /err=\{|rpcerr/.test(l)).map((l) => l.slice(25, 300)).join("\n")}`);
  await s.close();
}
