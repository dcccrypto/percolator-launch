/** Launch-market wizard: paste the mint, walk the steps (dumping each), launch, then check every prompt on chain. */
import { openSession, connectViaUi, dump, sigStatus, traceRpc, OUT_DIR } from "./harness.mts";
import fs from "node:fs";
const flow = process.argv[2]; const mint = process.argv[3] ?? "8PzFWyLpCVEmbZmVJcaRTU5r69XKJx1rd7YGpWvnpump";
const LAUNCH = process.env.LAUNCH === "1";
const s = await openSession(flow, { keypair: process.env.E2E_KEYPAIR });
const { page } = s; const trace: string[] = []; await traceRpc(page, trace);
const out = OUT_DIR;
try {
  await connectViaUi(s);
  await page.goto(new URL("/create", page.url()).toString());
  await page.getByTestId("wizard-token-input").fill(mint);
  await page.waitForTimeout(8000);
  for (let stepN = 1; stepN <= 8; stepN++) {
    await s.shot(`step${stepN}`);
    const d = await dump(page, "main");
    console.log(`---- step ${stepN} ----\n${d.split("\n").filter((l) => !/^div$|^button$/.test(l)).slice(0, 60).join("\n")}`);
    const launch = page.locator("[data-testid=wizard-launch], [data-testid=create-market-submit], [data-testid=launch-submit]").first();
    if (await launch.isVisible().catch(() => false)) {
      s.note(`launch button: "${await launch.textContent()}" enabled=${await launch.isEnabled()}`);
      if (!LAUNCH) break;
      const n0 = s.log.length;
      await launch.click();
      for (let k = 0; k < 72; k++) {
        await page.waitForTimeout(5000);
        const st = (await page.locator("[data-testid^=status-line], [role=status], [role=alert], [data-testid*=launch-progress], [data-testid*=launch-step], [data-testid*=create-progress]").allTextContents().catch(() => [])).join(" | ").replace(/\s+/g, " ").trim();
        if (st) s.note(`t+${(k + 1) * 5}s prompts=${s.log.length - n0}: ${st.slice(0, 300)}`);
        if (await page.locator("[data-testid=launch-success], [data-testid*=launch-success]").first().isVisible().catch(() => false)) { s.note("SUCCESS panel visible"); break; }
      }
      await s.shot("after-launch");
      console.log("---- after ----\n" + (await dump(page, "main")).split("\n").slice(0, 50).join("\n"));
      for (const e of s.log.slice(n0)) s.note(`prompt ${e.kind} ixs=${e.ixCount} bytes=${e.bytes} progs=${(e.programs ?? []).map((p) => p.slice(0, 4)).join(",")} ${e.sig ? JSON.stringify(await sigStatus(e.sig)) : ""}`);
      break;
    }
    const next = page.getByTestId("wizard-next");
    if (!(await next.isVisible().catch(() => false))) { s.note("no next button"); break; }
    if (!(await next.isEnabled())) { s.note(`next disabled at step ${stepN}`); break; }
    await next.click();
    await page.waitForTimeout(5000);
  }
} catch (e) { s.note(`FAIL ${String(e).slice(0, 600)}`); await s.shot("fail"); } finally {
  fs.writeFileSync(`${out}/${flow}-rpctrace.txt`, trace.join("\n"));
  s.note(`rpc errors:\n${trace.filter((l) => /err=\{|rpcerr/.test(l)).map((l) => l.slice(25, 320)).join("\n")}`);
  s.note(`console: ${s.events.filter((x) => /pageerror|useCreate|launch/i.test(x)).map((x) => x.slice(0, 300)).join("\n")}`);
  await s.close();
}
