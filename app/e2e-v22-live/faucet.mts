import { openSession, connectViaUi, dump, tokenBalance, USDC_V22, sigStatus } from "./harness.mts";
const s = await openSession(process.argv[2] ?? "faucet", { keypair: process.argv[3] });
const { page } = s;
try {
  await connectViaUi(s);
  await page.goto(new URL("/faucet", page.url()).toString());
  await page.getByRole("button", { name: /fund my account/i }).waitFor({ timeout: 20_000 });
  s.note(`before USDC=${await tokenBalance(s.kp.publicKey, USDC_V22)}`);
  await page.getByRole("button", { name: /fund my account/i }).click();
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(3000);
    const b = await tokenBalance(s.kp.publicKey, USDC_V22);
    if (b > 0) { s.note(`USDC landed: ${b}`); break; }
  }
  await page.waitForTimeout(5000);
  await s.shot("after");
  s.note(`modal:\n${await dump(page, "[role=dialog]")}`);
  for (const e of s.log) if (e.sig) s.note(`prompt sig ${e.sig} ${JSON.stringify(await sigStatus(e.sig))}`);
  s.note(`prompts=${s.log.length} ${JSON.stringify(s.log.map((e) => ({ k: e.kind, p: e.programs, n: e.ixCount })))}`);
} catch (e) { s.note(`FAIL ${String(e).slice(0, 500)}`); await s.shot("fail"); } finally { await s.close(); }
