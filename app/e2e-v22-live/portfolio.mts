import { openSession, connectViaUi, dump, traceRpc } from "./harness.mts";
const flow = process.argv[2];
const s = await openSession(flow, { keypair: process.env.E2E_KEYPAIR });
const { page } = s; const trace: string[] = []; await traceRpc(page, trace);
const fails: string[] = [];
page.on("requestfailed", (r) => fails.push(`${r.method()} ${r.url().slice(0, 120)} ${r.failure()?.errorText}`));
page.on("response", (r) => { if (r.status() >= 400) fails.push(`${r.status()} ${r.url().slice(0, 140)}`); });
try {
  await connectViaUi(s);
  await page.goto(new URL("/portfolio", page.url()).toString());
  await page.waitForTimeout(15_000);
  await s.shot("overview");
  console.log("---- overview ----\n" + (await dump(page, "main")).split("\n").slice(0, 40).join("\n"));
  await page.getByRole("button", { name: /^Positions$/ }).click();
  await page.waitForTimeout(6000);
  await s.shot("positions");
  console.log("---- positions ----\n" + (await dump(page, "main")).split("\n").slice(0, 40).join("\n"));
  await page.getByRole("button", { name: /^Wallet$/ }).click();
  await page.waitForTimeout(5000);
  await s.shot("wallet");
  console.log("---- wallet ----\n" + (await dump(page, "main")).split("\n").slice(0, 25).join("\n"));
} catch (e) { s.note(`FAIL ${String(e).slice(0, 600)}`); await s.shot("fail"); } finally {
  s.note(`failed requests:\n${[...new Set(fails)].join("\n")}`);
  s.note(`console: ${s.events.filter((x) => /usePortfolio|pageerror/.test(x)).map((x) => x.slice(0, 200)).join("\n")}`);
  await s.close();
}
