import { openSession, connectViaUi } from "./harness.mts";

const s = await openSession("probe");
try {
  const { page } = s;
  s.note(`url after enter: ${page.url()}`);
  const footer = await page.locator("text=/build [0-9a-f]{7,}/").first().textContent({ timeout: 10_000 }).catch(() => null);
  s.note(`footer: ${footer}`);
  s.note(`__v22Build: ${JSON.stringify(await page.evaluate(() => (window as unknown as { __v22Build?: unknown }).__v22Build ?? null))}`);
  await s.shot("landing");
  await connectViaUi(s);
  s.note("connected");
  await s.shot("connected");
  for (const p of ["/markets", "/create", "/earn", "/stake", "/portfolio", "/faucet"]) {
    await page.goto(new URL(p, page.url()).toString(), { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
    s.note(`${p}: ${page.url()} h1=${await page.locator("h1").first().textContent({ timeout: 3000 }).catch(() => "-")}`);
    await s.shot(p.slice(1));
  }
} catch (e) {
  s.note(`FAIL ${String(e).slice(0, 500)}`);
  await s.shot("fail");
} finally {
  await s.close();
}
