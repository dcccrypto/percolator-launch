/** Open (and optionally close) a position from the ticket; every prompt's signature is checked on chain. */
import { openSession, connectViaUi, dump, sigStatus, traceRpc, type RpcFault, OUT_DIR } from "./harness.mts";
import fs from "node:fs";
const flow = process.argv[2]; const slab = process.argv[3];
const side = (process.env.SIDE ?? "long") as "long" | "short"; const size = process.env.SIZE ?? "10"; const lev = process.env.LEV ?? "2x";
const doOpen = process.env.OPEN !== "0"; const doClose = process.env.CLOSE === "1";
const s = await openSession(flow, { keypair: process.env.E2E_KEYPAIR });
const { page } = s;
const trace: string[] = [];
const faultMod = process.env.FAULT ? await import(`./faults/${process.env.FAULT}.mts`) : null;
await traceRpc(page, trace, faultMod ? (faultMod.default as (note: (x: string) => void) => RpcFault)(s.note) : undefined);
const landed = async (from: number, what: string) => {
  const sigs = s.log.slice(from).filter((e) => e.sig);
  for (const e of sigs) s.note(`${what} prompt ixs=${e.ixCount} bytes=${e.bytes} ${JSON.stringify(await sigStatus(e.sig!))}`);
  return sigs.length;
};
try {
  await connectViaUi(s);
  await page.goto(new URL(`/trade/${slab}`, page.url()).toString());
  await page.getByTestId("trade-size-input").waitFor({ timeout: 60_000 });
  await page.waitForTimeout(5000);
  if (doOpen) {
    const n0 = s.log.length;
    await page.getByTestId(`trade-side-${side}`).click();
    await page.getByTestId("trade-size-input").fill(size);
    await page.getByTestId("trade-leverage-preset").filter({ hasText: new RegExp(`^${lev}$`) }).click().catch(() => s.note(`no ${lev} preset`));
    await page.waitForTimeout(1500);
    s.note(`submit label: ${await page.getByTestId("trade-submit").textContent()}`);
    await s.shot("ticket");
    await page.getByTestId("trade-submit").click();
    if (await page.getByTestId("trade-confirm").isVisible({ timeout: 5000 }).catch(() => false)) { await s.shot("confirm"); await page.getByTestId("trade-confirm").click(); }
    for (let k = 0; k < 10; k++) { await page.waitForTimeout(2500); const st = await page.locator("[data-testid^=status-line], [role=status]").allTextContents().catch(() => []); if (st.join("").trim()) s.note(`t+${(k + 1) * 2.5}s status: ${st.join(" | ").slice(0, 300)}`); }
    await s.shot("after-open");
    s.note(`open prompts: ${await landed(n0, "open")}`);
    s.note(`status lines: ${(await page.locator("[data-testid^=status-line], [role=status], [role=alert]").allTextContents()).join(" | ").slice(0, 800)}`);
  }
  await page.waitForTimeout(4000);
  console.log("---- dock ----\n" + (await dump(page, "[data-testid=positions-dock], main")).split("\n").filter((l) => /position|close|row|pnl|dock/i.test(l)).join("\n"));
  if (doClose) {
    const n1 = s.log.length;
    const closeBtn = page.getByTestId(process.env.CLOSE_TID ?? "position-close").first();
    await closeBtn.click({ timeout: 15_000 });
    await page.waitForTimeout(1500); await s.shot("close-modal");
    console.log("---- dialog ----\n" + (await dump(page, "[role=dialog]")));
    const confirm = page.locator("[role=dialog]").getByRole("button", { name: /close|confirm/i }).last();
    await confirm.click({ timeout: 10_000 });
    await page.waitForTimeout(25_000);
    await s.shot("after-close");
    s.note(`close prompts: ${await landed(n1, "close")}`);
  }
} catch (e) { s.note(`FAIL ${String(e).slice(0, 600)}`); await s.shot("fail"); } finally {
  s.note(`rpc/page errors: ${s.events.filter((x) => /^rpc|pageerror/.test(x)).join("\n").slice(0, 2500)}`);
  fs.writeFileSync(`${OUT_DIR}/${flow}-rpctrace.txt`, trace.join("\n"));
  console.log("---- rpc trace ----\n" + trace.map((l) => l.slice(25, 260)).join("\n"));
  await s.close();
}
