import { openSession, connectViaUi, dump } from "./harness.mts";
const [flow, route, scope] = [process.argv[2], process.argv[3], process.argv[4] ?? "main"];
const s = await openSession(flow, { keypair: process.argv[5] });
const { page } = s;
try {
  await connectViaUi(s);
  await page.goto(new URL(route, page.url()).toString());
  await page.waitForTimeout(9000);
  await s.shot("page");
  console.log(await dump(page, scope));
} catch (e) { s.note(`FAIL ${String(e).slice(0, 500)}`); await s.shot("fail"); } finally { await s.close(); }
