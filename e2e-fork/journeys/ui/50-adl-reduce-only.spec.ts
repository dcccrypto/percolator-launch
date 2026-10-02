/**
 * F3-ADL (F-3 per triage: the engine's ADL reduce-only state, not a freeze). KEEPER RUNNING.
 *  1. bankruptcy after a large price move: A ~9x long vs the LP; B long / C short (TradeNoCpi);
 *     the DEX pool the keeper reads drops `DROP`% (sqrt surgery on the loaded mainnet snapshot);
 *     the keeper pushes, cranks and liquidates.
 *  2. market shows reduce-only: on-chain A_long|A_short != ADL_ONE, fresh open refused;
 *     UI `limits-adl-reduce-only` notice (limits-ui branch; not flag-gated).
 *  3. the trader on the SAME side as the LP closes in the UI — the landed tx must be wrapper tag 44.
 *  4. every remaining position exits (tag 44, owner-signed); keeper cranks/finalizes between.
 *  5. the market reopens (A back to ADL_ONE, a fresh open + close lands) and every account withdraws.
 * Requires APP_DIR = feat/limits-ui (tag 44 wiring). On the p0b app step 3 is recorded as "not wired".
 */
import { test, type Page } from "@playwright/test";
import { PublicKey, TransactionInstruction, Keypair } from "@solana/web3.js";
import { buildIx, buildAccountMetas, ACCOUNTS_TRADE_NOCPI, encodeTradeNoCpi } from "@percolatorct/sdk";
import { installTestWallet, type SignLogEntry } from "../../wallet/inject.ts";
import * as P from "../../lib/perc.ts";
import { rpc } from "../../lib/chain.ts";
import { check, record } from "../../lib/results.ts";

const SYM = process.env.ADL_SYM ?? "SOL";
const DROP = Number(process.env.ADL_DROP ?? 25);
const shot = (page: Page, n: string) => page.screenshot({ path: `.run/shots/${n}.png`, fullPage: true }).catch(() => undefined);
const txSigs = (log: SignLogEntry[]) => log.filter((e) => e.kind === "tx").map((e) => e.sig!).filter(Boolean);
async function until<T>(fn: () => Promise<T | null | false | undefined>, ms: number, every = 4000): Promise<T | null> {
  const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn().catch(() => null); if (v) return v as T; await P.sleep(every); } return null;
}
function tag44(owner: PublicKey, slab: PublicKey, port: PublicKey, pid: bigint, epoch: bigint, q: bigint) {
  const d = Buffer.alloc(35); d[0] = 44; d.writeBigUInt64LE(pid, 1); d.writeBigUInt64LE(epoch, 9); d.writeUInt16LE(0, 17);
  d.writeBigUInt64LE(q & ((1n << 64n) - 1n), 19); d.writeBigUInt64LE(q >> 64n, 27);
  return new TransactionInstruction({ programId: P.WRAPPER, keys: [{ pubkey: owner, isSigner: true, isWritable: true }, { pubkey: slab, isSigner: false, isWritable: true }, { pubkey: port, isSigner: false, isWritable: true }], data: d });
}

test(`F3-ADL ${SYM}: bankruptcy → reduce-only → LP-side trader exits via tag 44 (UI) → all exit → reopen`, async ({ page }) => {
  test.setTimeout(45 * 60_000);
  const J = "F3-ADL-reduce-only"; const m = P.markets()[SYM];
  if (m.dexType !== "raydium-clmm") throw new Error("price surgery implemented for raydium-clmm");
  // 1. positions
  const users: { name: string; kp: Keypair; port: PublicKey }[] = [];
  for (const [name, dep] of [["A-long-vs-LP", 200_000_000n], ["B-long", 1_000_000_000n], ["C-short", 1_000_000_000n]] as const) {
    const kp = await P.newWallet({ usdc: dep + 10_000_000n });
    const port = await P.createPortfolio(kp, m);
    await P.mustSend(`${name} deposit`, [await P.depositIx(kp.publicKey, m, port, dep)], [kp]);
    users.push({ name, kp, port });
  }
  const [A, B, C] = users;
  await P.mustSend("A 9x long", [await P.tradeIx(A.kp.publicKey, m, A.port, await P.qForUsd(m, 1800))], [A.kp]);
  const st0 = await P.readMarket(m);
  const [ib, ic] = [await P.readPortfolio(B.port), await P.readPortfolio(C.port)];
  // P3 wrappers refuse TradeNoCpi (Custom 77: every fill goes through the vault LP), so B and C each trade the LP;
  // net LP exposure from B+C is zero, as with the old B<->C NoCpi pair.
  void ib; void ic; void buildIx; void buildAccountMetas; void ACCOUNTS_TRADE_NOCPI; void encodeTradeNoCpi;
  await P.mustSend("B long vs LP", [await P.tradeIx(B.kp.publicKey, m, B.port, await P.qForUsd(m, 500))], [B.kp]);
  await P.mustSend("C short vs LP", [await P.tradeIx(C.kp.publicKey, m, C.port, -(await P.qForUsd(m, 500)))], [C.kp]);
  // price move on the DEX the keeper reads
  const pool = P.pk(m.pool); const ai = (await P.conn.getAccountInfo(pool))!; const orig = Buffer.from(ai.data.subarray(253, 269));
  const d = Buffer.from(ai.data); const sqrt = d.readBigUInt64LE(253) | (d.readBigUInt64LE(261) << 64n);
  const ns = (sqrt * BigInt(Math.round(Math.sqrt(1 - DROP / 100) * 1e9))) / 1_000_000_000n;
  d.writeBigUInt64LE(ns & ((1n << 64n) - 1n), 253); d.writeBigUInt64LE(ns >> 64n, 261);
  await rpc(P.RPC, "surfnet_setAccount", [pool.toBase58(), { data: d.toString("hex"), owner: ai.owner.toBase58(), lamports: ai.lamports }]);
  try {
    const liq = await until(async () => { const p = await P.readPortfolio(A.port); const s = await P.readMarket(m); return p.legs.length === 0 || s.reduceOnly ? { p, s } : null; }, 25 * 60_000, 6000);
    const s1 = await P.readMarket(m);
    check(J, SYM, `1. bankruptcy after a ${DROP}% move (keeper pushes + liquidates)`, !!liq, "A liquidated or ADL engaged", `mark ${st0.markE6}→${s1.markE6}; A legs=${(await P.readPortfolio(A.port)).legs.length}; aLong=${s1.aLong} aShort=${s1.aShort}`);
    // 2. reduce-only on-chain + UI
    await until(async () => (await P.readMarket(m)).reduceOnly, 120_000);
    const s2 = await P.readMarket(m);
    const fresh = await P.newWallet({ usdc: 300_000_000n }); const fp = await P.createPortfolio(fresh, m);
    await P.mustSend("fresh deposit", [await P.depositIx(fresh.publicKey, m, fp, 200_000_000n)], [fresh]);
    const openTry = await P.send([await P.tradeIx(fresh.publicKey, m, fp, await P.qForUsd(m, 20))], [fresh], { simulateOnly: true });
    check(J, SYM, "2. market is ADL reduce-only on-chain (A != ADL_ONE) and a fresh open is refused", s2.reduceOnly && !openTry.ok, "reduceOnly, open 21", `aLong=${s2.aLong} aShort=${s2.aShort} open=${openTry.ok ? "ok" : openTry.err}`);
    if (!s2.reduceOnly) { record({ journey: J, market: SYM, step: "ADL state not reached — keeper liquidated without socialisation (no F-3 on this path)", ok: true, actual: "see step 1" }); return; }
    const lpLeg = (await P.readPortfolio(P.pk(m.lpPortfolio))).legs[0];
    const lpSide = lpLeg ? (lpLeg.basisPosQ > 0n ? 1 : -1) : 0;
    const holders = [...users, { name: "LP", kp: P.admin, port: P.pk(m.lpPortfolio) }];
    const sameSide = [];
    for (const u of users) { const l = (await P.readPortfolio(u.port)).legs[0]; if (l && (l.basisPosQ > 0n ? 1 : -1) === lpSide) sameSide.push(u); }
    const T = sameSide[0];
    record({ journey: J, market: SYM, step: "LP side / same-side traders", ok: true, actual: `LP side ${lpSide}; same side: ${sameSide.map((u) => u.name).join(",") || "none"}` });
    // 3. same-side trader closes in the UI
    if (T) {
      const log = await installTestWallet(page, T.kp);
      await page.goto("/markets");
      const badge = await page.locator(`[data-market="${m.slab}"] [data-testid="market-health-badge"][data-badge="adl-reduce-only"]`).first().waitFor({ state: "attached", timeout: 60_000 }).then(() => true).catch(() => false);
      await shot(page, "F3ADL-markets-badge");
      check(J, SYM, "2a. /markets shows the adl-reduce-only health badge (launch#2700 §8)", badge, 'market-health-badge[data-badge="adl-reduce-only"]', badge ? "present" : "absent");
      await page.goto(`/trade/${m.slab}`);
      const notice = await page.locator('[data-testid="limits-adl-reduce-only"]').first().waitFor({ state: "visible", timeout: 60_000 }).then(() => true).catch(() => false);
      await shot(page, "F3ADL-reduce-only");
      check(J, SYM, "2b. UI shows the ADL reduce-only notice", notice, 'limits-adl-reduce-only visible', notice ? "visible" : "absent (app without limits-ui?)");
      await page.locator('[data-testid="trade-mode-tab"][data-mode="close"]').click().catch(() => undefined);
      const route = await page.locator('[data-testid="limits-adl-close-route"]').first().isVisible({ timeout: 10_000 }).catch(() => false);
      record({ journey: J, market: SYM, step: "2c. Close tab shows limits-adl-close-route", ok: true, actual: route ? "visible" : "absent" });
      await page.locator('[data-testid="trade-mode-tab"][data-mode="open"]').click().catch(() => undefined);
      await page.getByTestId("position-close").first().click({ timeout: 60_000 });
      await page.locator('[data-testid="close-percent-chip"][data-percent="100"]').first().click();
      await page.getByTestId("close-confirm").click();
      const closed = await until(async () => ((await P.readPortfolio(T.port)).legs.length === 0 ? true : null), 90_000, 3000);
      const sigs = txSigs(log); const ixs = sigs.length ? await P.txIxs(sigs.at(-1)!) : [];
      await shot(page, "F3ADL-ui-close");
      const errTxt = await page.locator('[data-testid="close-error"]:visible, [data-testid="position-close-error"]:visible').first().innerText({ timeout: 1500 }).catch(() => "");
      check(J, SYM, `3. ${T.name} (same side as the LP) closes in the UI via tag 44`, !!closed && ixs.some((i) => i.program === P.WRAPPER.toBase58() && i.tag === 44),
        "0 legs, landed tx has wrapper tag 44", `legs=${(await P.readPortfolio(T.port)).legs.length} ixs=${JSON.stringify(ixs.map((i) => `${i.program.slice(0, 4)}:${i.tag}`))} ${errTxt}`, sigs.slice(-1));
    }
    // 4. every remaining holder exits with tag 44 (keeper keeps cranking/finalizing)
    for (const u of holders) {
      for (let i = 0; i < 10; i++) {
        const p = await P.readPortfolio(u.port); const l = p.legs[0]; if (!l) break;
        const q = l.basisPosQ < 0n ? -l.basisPosQ : l.basisPosQ;
        const r = await P.send([tag44(u.kp.publicKey, P.pk(m.slab), u.port, p.portfolioId, p.positionEpoch, q)], [u.kp]);
        if (r.ok) break; await P.sleep(12_000); // let the keeper crank / FinalizeResetSide
      }
    }
    const legsLeft = await Promise.all(holders.map(async (u) => `${u.name}:${(await P.readPortfolio(u.port)).legs.length}`));
    check(J, SYM, "4. all positions exit (tag 44; keeper running)", legsLeft.every((x) => x.endsWith(":0")), "0 legs everywhere", legsLeft.join(" "));
    // 5. reopen + withdrawals
    const reopened = await until(async () => { const s = await P.readMarket(m); if (s.reduceOnly) return null; const r = await P.send([await P.tradeIx(fresh.publicKey, m, fp, await P.qForUsd(m, 20))], [fresh]); return r.ok ? r : null; }, 5 * 60_000, 8000);
    const s5 = await P.readMarket(m);
    check(J, SYM, "5. market reopens: A back to ADL_ONE and a fresh open lands", !!reopened, "reduceOnly=false, open ok", `aLong=${s5.aLong} aShort=${s5.aShort}`, reopened?.sig ? [reopened.sig] : []);
    const fl = (await P.readPortfolio(fp)).legs[0]; if (fl) await P.send([await P.tradeIx(fresh.publicKey, m, fp, -fl.basisPosQ)], [fresh]);
    for (const u of [...users, { name: "fresh", kp: fresh, port: fp }]) {
      const p = await P.readPortfolio(u.port); if (p.capital === 0n) { record({ journey: J, market: SYM, step: `5. ${u.name}: nothing to withdraw`, ok: true, actual: "capital 0" }); continue; }
      const w0 = await P.usdcBalance(u.kp.publicKey);
      const r = await P.send([await P.withdrawIx(u.kp.publicKey, m, u.port, p.capital)], [u.kp]);
      check(J, SYM, `5. ${u.name} withdraws all capital`, r.ok && (await P.usdcBalance(u.kp.publicKey)) - w0 === p.capital, `+${p.capital}`, r.ok ? `+${(await P.usdcBalance(u.kp.publicKey)) - w0}` : `${r.err}`, r.sig ? [r.sig] : []);
    }
  } finally {
    const d2 = Buffer.from((await P.conn.getAccountInfo(pool))!.data); orig.copy(d2, 253);
    await rpc(P.RPC, "surfnet_setAccount", [pool.toBase58(), { data: d2.toString("hex"), owner: ai.owner.toBase58(), lamports: ai.lamports }]);
  }
});
