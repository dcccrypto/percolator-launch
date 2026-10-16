import { openSession, connectViaUi, dump, sigStatus } from "./harness.mts";
const s = await openSession(process.argv[2], { keypair: process.env.E2E_KEYPAIR });
const { page } = s;
try {
  await connectViaUi(s);
  await page.goto(new URL("/portfolio", page.url()).toString());
  await page.waitForTimeout(8000);
  await page.getByRole("button", { name: /^Positions$/ }).click();
  await page.waitForTimeout(5000);
  const n0 = s.log.length;
  await page.getByRole("button", { name: /^Close$/ }).first().click();
  await page.waitForTimeout(2000);
  await s.shot("close-dialog");
  console.log(await dump(page, "[role=dialog]"));
  await page.locator("[data-testid=close-confirm]").click({ timeout: 10_000 });
  for (let k = 0; k < 10; k++) { await page.waitForTimeout(2500); }
  for (const e of s.log.slice(n0)) if (e.sig) s.note(`close prompt ixs=${e.ixCount} ${JSON.stringify(await sigStatus(e.sig))}`);
  await page.getByRole("button", { name: /^Refresh$/ }).click().catch(() => {});
  await page.waitForTimeout(5000);
  await s.shot("after");
  s.note(`after: ${(await dump(page, "main")).split("\n").filter((l) => /position|Close|empty|No open/i.test(l)).join(" | ")}`);
  s.note(`errors: ${s.events.filter((x) => /^rpc .*err|pageerror/.test(x)).join("\n").slice(0, 1500)}`);
} catch (e) { s.note(`FAIL ${String(e).slice(0, 600)}`); await s.shot("fail"); } finally { await s.close(); }
