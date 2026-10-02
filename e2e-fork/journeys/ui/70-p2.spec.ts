/**
 * P2 journeys on the release set: wrapper P1+P3 FINAL, matcher P2 4a0f696 (sha 7d16a4b4), seed P3 + P3_AUTO_PIN
 * (+ MATCHER_V2=1, which sets matcher_ext_mode 1 in tag 93), app #2700 with LIMITS_P1/P2/P3.
 *  P2-1 quote vs realised fill: the ticket's pre-trade quote (data-kind must match the ON-CHAIN ctx kind) vs what
 *       the chain did: filled size, pnl at the fill (does it "Settle at Mark"?), fee charged — against a Node-signed
 *       control trade of the same size on the same market.
 *  P2-2 zero fill "Market at capacity": the LP's exposure headroom goes to 0 between the ticket's quote and the
 *       signature (tag 93 lp_exposure_k_bps = 1, applied in the wallet's beforeSign hook). The wrapper clips to 0 and
 *       returns Ok → the tx LANDS, the position is unchanged, the UI says "Market at capacity — no fill", never "Confirmed!".
 *  P2-3 the wizard's auto-pinned matcher (market from 60-p3 P3-5): pinned ctx kind + caps on-chain; the trade page's
 *       quote kind agrees with it.
 */
import { test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { deriveProgramDataAddressP3, decodeAssetVaultLpP3, deriveLpVaultRegistry, deriveMatcherDelegate } from "@percolatorct/sdk";
import { installTestWallet } from "../../wallet/inject.ts";
import * as P from "../../lib/perc.ts";
import { check, record } from "../../lib/results.ts";

test.describe.configure({ mode: "default", timeout: 10 * 60_000 });
const shot = (page: Page, n: string) => page.screenshot({ path: `.run/shots/${n}.png`, fullPage: true }).catch(() => undefined);
const seedLimits = (sym: string) => JSON.parse(fs.readFileSync(path.join(P.RUN, "seed-state.json"), "utf8")).markets[sym].p1RiskLimits as Record<string, string>;
function t93(m: P.SeedMarket, sym: string, over: Partial<Record<string, string>> = {}) {
  const L = { ...seedLimits(sym), ...over };
  const [programData] = deriveProgramDataAddressP3(P.WRAPPER);
  const d = Buffer.alloc(44); let i = 0; d[i++] = 93; d.writeUInt16LE(0, i); i += 2;
  d.writeUInt16LE(Number(L.exec_band_bps), i); i += 2; d.writeUInt32LE(Number(L.lp_exposure_k_bps), i); i += 4;
  const w = (v: bigint) => { d.writeBigUInt64LE(v & 0xffffffffffffffffn, i); d.writeBigUInt64LE(v >> 64n, i + 8); i += 16; };
  w(BigInt(L.lp_floor_atoms)); w(BigInt(L.side_oi_cap_q)); d[i++] = Number(L.matcher_ext_mode); d.writeUInt16LE(Number(L.max_requested_fee_bps), i);
  return new TransactionInstruction({ programId: P.WRAPPER, data: d, keys: [{ pubkey: P.admin.publicKey, isSigner: true, isWritable: false }, { pubkey: programData, isSigner: false, isWritable: false }, { pubkey: P.pk(m.slab), isSigner: false, isWritable: true }] });
}
const u128 = (c: Uint8Array, o: number) => { const v = new DataView(c.buffer, c.byteOffset); return (v.getBigUint64(o + 8, true) << 64n) | v.getBigUint64(o, true); };
async function ctxInfo(ctx: PublicKey) { const c = new Uint8Array((await P.conn.getAccountInfo(ctx))!.data); return { kind: c[64 + 12], maxFill: u128(c, 64 + 80), maxInv: u128(c, 64 + 128), lpPda: new PublicKey(c.subarray(64 + 16, 64 + 48)) }; }
async function quoteRows(page: Page) {
  const kind = await page.locator('[data-testid="limits-quote"]').first().getAttribute("data-kind", { timeout: 30_000 }).catch(() => null);
  const rows: Record<string, string> = {};
  for (const r of await page.locator('[data-testid="limits-quote-row"]').all()) { const k = await r.getAttribute("data-row"); if (k) rows[k] = (await r.innerText()).replace(/\s+/g, " ").trim(); }
  return { kind, rows };
}
async function openCapital(kp: import("@solana/web3.js").Keypair, m: P.SeedMarket, amt = 1_000_000_000n) {
  const port = await P.createPortfolio(kp, m);
  await P.mustSend("deposit", [await P.depositIx(kp.publicKey, m, port, amt)], [kp]);
  return port;
}
const lpPos = async (m: P.SeedMarket) => (await P.readPortfolio(P.pk(m.lpPortfolio))).legs[0]?.basisPosQ ?? 0n;
async function uiTrade(page: Page, side: "long" | "short", usd: string) {
  await page.getByTestId(`trade-side-${side}`).click({ timeout: 60_000 });
  await page.getByTestId("trade-size-input").fill(usd);
  await P.sleep(3000);
}
async function submit(page: Page) {
  await page.getByTestId("trade-submit").click({ timeout: 30_000 });
  if (await page.getByTestId("trade-confirm").isVisible({ timeout: 5000 }).catch(() => false)) await page.getByTestId("trade-confirm").click();
}

const S1 = process.env.P2_SYM ?? "PENGU";
test(`P2-1 quote vs realised fill (${S1})`, async ({ page }) => {
  const J = "P2-quote-vs-fill"; const m = P.markets()[S1];
  const ci = await ctxInfo(P.pk(m.matcherCtx));
  record({ journey: J, market: S1, step: "on-chain pinned matcher ctx", ok: true, actual: `ctx=${m.matcherCtx} kind=${ci.kind} maxFill=${ci.maxFill} maxInv=${ci.maxInv}` });
  // Node control: same $ size, signed directly
  const C = await P.newWallet({ usdc: 2_000_000_000n }); const pc = await openCapital(C, m);
  const qC = await P.qForUsd(m, 150);
  const cc0 = (await P.readPortfolio(pc)).capital;
  const rc = await P.send([await P.tradeIx(C.publicKey, m, pc, qC)], [C]);
  const pC = await P.readPortfolio(pc); const mk = (await P.readMarket(m)).markE6;
  const feeC = cc0 - pC.capital; const notC = Number(qC) * Number(mk) / 1e12;
  record({ journey: J, market: S1, step: "control trade (Node-signed, $150 long)", ok: rc.ok, actual: `ok=${rc.ok} q=${qC} fee=${feeC} (${(Number(feeC) / 1e6 / notC * 1e4).toFixed(2)} bps) pnlAtFill=${pC.pnl} ${rc.err ?? ""}`, sigs: rc.sig ? [rc.sig] : [] });
  // UI trade
  const kp = await P.newWallet({ usdc: 2_000_000_000n }); const port = await openCapital(kp, m);
  const log = await installTestWallet(page, kp);
  await page.goto(`/trade/${m.slab}`);
  await uiTrade(page, "long", "150");
  const q = await quoteRows(page);
  await shot(page, "P2-1-quote");
  record({ journey: J, market: S1, step: "UI pre-trade quote", ok: true, actual: `data-kind=${q.kind} ${JSON.stringify(q.rows)}` });
  const c0 = (await P.readPortfolio(port)).capital;
  await submit(page);
  let leg = 0n; for (let i = 0; i < 30 && !leg; i++) { await P.sleep(2000); leg = (await P.readPortfolio(port)).legs[0]?.basisPosQ ?? 0n; }
  const p1 = await P.readPortfolio(port); const mark = (await P.readMarket(m)).markE6;
  const notional = Number(leg) * Number(mark) / 1e12; const fee = c0 - p1.capital;
  const feeBps = notional ? Number(fee) / 1e6 / notional * 1e4 : NaN; const pnlBps = notional ? Number(p1.pnl) / 1e6 / notional * 1e4 : NaN;
  await P.sleep(2000); await shot(page, "P2-1-filled");
  const body = await page.locator("body").innerText();
  const expectKind = ci.kind === 2 ? "adaptive" : "legacy";
  check(J, S1, "quote kind agrees with the on-chain ctx kind (kind 2 → adaptive, else legacy)", q.kind === expectKind, expectKind, `data-kind=${q.kind} ctx.kind=${ci.kind}`);
  check(J, S1, "realised fill = requested (≈$150, full fill), settles at mark (pnl at fill ≈ 0) as the 'Settles at: Mark' row says",
    leg > 0n && Math.abs(notional - 150) / 150 < 0.05 && Math.abs(pnlBps) < 1 && /Mark/.test(q.rows["settles"] ?? ""),
    "≈$150, |pnl| < 1 bps, row 'Settles at Mark'", `leg=${leg} ≈$${notional.toFixed(2)} pnl=${p1.pnl} (${pnlBps.toFixed(2)} bps) settles-row="${q.rows["settles"] ?? q.rows["fee-charged"]}"`, log.filter((e) => e.sig).map((e) => e.sig!).slice(-1));
  check(J, S1, "fee charged on the UI fill = the control trade's fee rate (fee channel off: base fee only)", Math.abs(feeBps - Number(feeC) / 1e6 / notC * 1e4) < 0.5,
    "equal within 0.5 bps", `ui ${fee} atoms = ${feeBps.toFixed(2)} bps; control ${(Number(feeC) / 1e6 / notC * 1e4).toFixed(2)} bps; toast-confirmed=${/Confirmed!/.test(body)}`);
  if (leg) await P.send([await P.tradeIx(kp.publicKey, m, port, -leg)], [kp]);
  if (pC.legs[0]) await P.send([await P.tradeIx(C.publicKey, m, pc, -pC.legs[0].basisPosQ)], [C]);
});

const S2 = process.env.P2_ZERO_SYM ?? "PENGU";
test(`P2-2 zero fill "Market at capacity" (${S2})`, async ({ page }) => {
  const J = "P2-zero-fill"; const m = P.markets()[S2];
  // make the LP carry a position so the direction that grows it is well defined
  const T1 = await P.newWallet({ usdc: 2_000_000_000n }); const p1 = await openCapital(T1, m);
  if ((await lpPos(m)) === 0n) await P.mustSend("T1 long", [await P.tradeIx(T1.publicKey, m, p1, await P.qForUsd(m, 200))], [T1]);
  const lp0 = await lpPos(m);
  const side: "long" | "short" = lp0 < 0n ? "long" : "short"; // a taker long grows a short LP
  const T2 = await P.newWallet({ usdc: 2_000_000_000n }); const p2 = await openCapital(T2, m);
  let squeezed: { ok: boolean; sig?: string; err?: string } | null = null;
  const log = await installTestWallet(page, T2, {
    beforeSign: async () => { if (!squeezed) { squeezed = await P.send([t93(m, S2, { lp_exposure_k_bps: "1" })], [P.admin]); } },
  });
  try {
    await page.goto(`/trade/${m.slab}`);
    await uiTrade(page, side, "100");
    const q = await quoteRows(page);
    const pre = await page.locator('[data-testid="limits-fill-result"]').count();
    await shot(page, "P2-2-before");
    await submit(page);
    let seen = false;
    for (let i = 0; i < 20 && !seen; i++) { await P.sleep(1500); seen = await page.locator('[data-testid="limits-fill-result"]').first().isVisible().catch(() => false); }
    const kind = await page.locator('[data-testid="limits-fill-result"]').first().getAttribute("data-kind").catch(() => null);
    const txt = await page.locator('[data-testid="limits-fill-result"]').first().innerText().catch(() => "");
    await P.sleep(2000);
    const body = await page.locator("body").innerText();
    await shot(page, "P2-2-zero-fill");
    const legs = (await P.readPortfolio(p2)).legs.length; const lp1 = await lpPos(m);
    const sig = log.filter((e) => e.kind === "tx" && e.sig).at(-1)?.sig;
    const tx = sig ? await P.conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }) : null;
    record({ journey: J, market: S2, step: "setup: LP position, taker side that GROWS it, headroom squeezed to 0 at sign time (tag 93 k=1 bps)", ok: !!squeezed?.ok,
      actual: `lpPos=${lp0} side=${side} quoteKind=${q.kind} tag93=${squeezed?.ok ? squeezed.sig : squeezed?.err} fill-result before=${pre}` });
    check(J, S2, "zero fill: the tx LANDS Ok, taker position unchanged, LP unchanged",
      !!tx && !tx.meta?.err && legs === 0 && lp1 === lp0, "landed Ok, 0 legs, LP unchanged", `tx=${tx ? (tx.meta?.err ? JSON.stringify(tx.meta.err) : "Ok") : "none"} legs=${legs} lp ${lp0}→${lp1}`, sig ? [sig] : []);
    check(J, S2, "UI: 'Market at capacity — no fill' (limits-fill-result data-kind=zero), never 'Confirmed!'",
      seen && /Market at capacity/i.test(body) && !/Confirmed!/.test(body), "zero notice, no Confirmed!", `visible=${seen} data-kind=${kind} text="${txt.replace(/\s+/g, " ").slice(0, 200)}" confirmed=${/Confirmed!/.test(body)}`);
  } finally {
    const r = await P.send([t93(m, S2)], [P.admin]);
    record({ journey: J, market: S2, step: "restore seed P1 limits (tag 93)", ok: r.ok, actual: r.ok ? `${r.sig}` : `${r.err}` });
    for (const [kp, pp] of [[T1, p1], [T2, p2]] as const) { const l = (await P.readPortfolio(pp)).legs[0]; if (l) await P.send([await P.tradeIx(kp.publicKey, m, pp, -l.basisPosQ)], [kp]); }
  }
});

test("P2-3 wizard market: auto-pinned matcher kind on-chain; trade page quote agrees", async ({ page }) => {
  const J = "P2-wizard-autopin";
  const f = path.join(P.RUN, "p3-wizard-market.json");
  test.skip(!fs.existsSync(f), "run 60-p3 P3-5 first");
  const { slab } = JSON.parse(fs.readFileSync(f, "utf8")) as { slab: string };
  const sp = new PublicKey(slab);
  const av = decodeAssetVaultLpP3(new Uint8Array((await P.conn.getAccountInfo(sp))!.data), 0);
  const [registry] = deriveLpVaultRegistry(P.WRAPPER, sp);
  let found: { ctx: PublicKey; info: Awaited<ReturnType<typeof ctxInfo>> } | null = null;
  for (const a of await P.conn.getProgramAccounts(P.MATCHER, { dataSlice: { offset: 0, length: 0 } })) {
    const info = await ctxInfo(a.pubkey).catch(() => null);
    if (!info || !av.vaultLpPortfolio) continue;
    const [del] = deriveMatcherDelegate(P.WRAPPER, sp, av.vaultLpPortfolio, registry, P.MATCHER, a.pubkey);
    if (info.lpPda.equals(del)) { found = { ctx: a.pubkey, info }; break; }
  }
  check(J, "WIF", "wizard market: tag 94 auto-pinned the canonical matcher; ctx found by delegate, kind ∈ {1,2}, finite caps",
    !!found && [1, 2].includes(found.info.kind) && !!av.approvedMatcherProgram?.equals(P.MATCHER) && found.info.maxFill > 0n,
    "pinned, kind 1|2", `slab=${slab} approved=${av.approvedMatcherProgram?.toBase58()} ctx=${found?.ctx.toBase58()} kind=${found?.info.kind} maxFill=${found?.info.maxFill} maxInv=${found?.info.maxInv}`);
  const kp = await P.newWallet({ usdc: 1_000_000_000n });
  await installTestWallet(page, kp);
  await page.goto(`/trade/${slab}`);
  // the ticket is disabled without an account: deposit through the UI first (as P3-5 does)
  await page.getByTestId("deposit-amount-input").first().fill("300", { timeout: 60_000 });
  await page.getByTestId("deposit-submit").first().click();
  for (let i = 0; i < 30; i++) { const ps = await P.findPortfolios(kp.publicKey, { slab } as unknown as P.SeedMarket); if (ps.length && (await P.readPortfolio(ps[0])).capital > 0n) break; await P.sleep(3000); }
  await uiTrade(page, "long", "20");
  const q = await quoteRows(page);
  await shot(page, "P2-3-wizard-quote");
  const expectKind = found?.info.kind === 2 ? "adaptive" : "legacy";
  check(J, "WIF", "trade page quote kind agrees with the pinned ctx kind", q.kind === expectKind, expectKind, `data-kind=${q.kind} rows=${JSON.stringify(q.rows)}`);
});
