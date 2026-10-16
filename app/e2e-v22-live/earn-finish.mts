import { openSession, connectViaUi, dump, sigStatus, tokenBalance, USDC_V22, traceRpc } from "./harness.mts";
const flow = process.argv[2]; const market = process.argv[3] ?? "SOL";
const s = await openSession(flow, { keypair: process.env.E2E_KEYPAIR });
const { page } = s; const trace: string[] = []; await traceRpc(page, trace);
try {
  await connectViaUi(s);
  await page.goto(new URL("/earn", page.url()).toString());
  await page.getByTestId("vault-table").waitFor({ timeout: 30_000 });
  await page.getByTestId("vault-table").locator("button").filter({ hasText: new RegExp(`^\\s*${market}\\s*\\$`) }).first().click();
  await page.getByTestId("earn-tab").filter({ hasText: /withdraw/i }).click();
  await page.waitForTimeout(4000);
  const before = await tokenBalance(s.kp.publicKey, USDC_V22);
  console.log((await dump(page, "[data-testid=earn-pending-withdrawal]")));
  const btn = page.getByTestId("earn-pending-withdrawal").getByRole("button").first();
  for (let k = 0; k < 40 && !(await btn.isEnabled().catch(() => false)); k++) await page.waitForTimeout(3000);
  s.note(`finish button: ${await btn.textContent()}`);
  const n0 = s.log.length;
  await btn.click();
  for (let k = 0; k < 12; k++) { await page.waitForTimeout(2500); const st = (await page.locator("[data-testid^=status-line], [role=status], [role=alert], [data-testid=earn-pending-withdrawal]").allTextContents().catch(() => [])).join(" | ").trim(); if (st) s.note(`t+${(k + 1) * 2.5}s: ${st.slice(0, 260)}`); }
  for (const e of s.log.slice(n0)) if (e.sig) s.note(`finish prompt ixs=${e.ixCount} ${JSON.stringify(await sigStatus(e.sig))}`);
  s.note(`prompts ${s.log.length - n0}; USDC ${before} -> ${await tokenBalance(s.kp.publicKey, USDC_V22)}`);
  s.note(`rail: ${(await page.locator("[data-testid^=earn-rail-figure]").allTextContents()).join(" · ")}`);
  await s.shot("after-finish");
} catch (e) { s.note(`FAIL ${String(e).slice(0, 600)}`); await s.shot("fail"); } finally {
  s.note(`rpc errors: ${trace.filter((l) => /err=\{|rpcerr/.test(l)).map((l) => l.slice(25, 300)).join("\n")}`);
  await s.close();
}
