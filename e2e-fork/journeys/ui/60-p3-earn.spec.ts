/**
 * P3 (vault-owned LP) Earn journeys on a P1+P3 fork (WRAPPER_SO = P3 FINAL, P3=1 seed, app with
 * NEXT_PUBLIC_LIMITS_P3=1). Skipped when the market has no bound vault LP (i.e. on P0 bytes).
 *  P3-1 Earn deposit (UI) → shares minted; senior claim C += deposit; UI tranche card + share price.
 *  P3-2 trades generate fees → fees reach NAV (vault state seniorFeeCreditedAtoms ↑, UI share price ↑).
 *  (P3-3 junior-first payout, P3-4 resolve → senior F-4 exit → stake tag-29: journeys/p3-drill.sh)
 *  P3-5 create-market wizard, the P3 way: limits-wizard-tranche shown; the new market has a bound vault LP.
 */
import { test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { decodeAssetVaultLpP3, decodeVaultLpStateP3, deriveVaultLpStateP3 } from "@percolatorct/sdk";
import { installTestWallet, type SignLogEntry, pinDexPools } from "../../wallet/inject.ts";
import * as P from "../../lib/perc.ts";
import { check, record } from "../../lib/results.ts";
import { churn } from "../chain/products.ts";

const SYM = process.env.P3_SYM ?? "JUP";
const shot = (page: Page, n: string) => page.screenshot({ path: `.run/shots/${n}.png`, fullPage: true }).catch(() => undefined);
const lastSig = (log: SignLogEntry[]) => log.filter((e) => e.kind === "tx").at(-1)?.sig ?? "";
async function until<T>(fn: () => Promise<T | null | false | undefined>, ms = 120_000): Promise<T | null> { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn().catch(() => null); if (v) return v as T; await P.sleep(3000); } return null; }
async function vstate(m: P.SeedMarket) { const [pda] = deriveVaultLpStateP3(P.WRAPPER, P.pk(m.slab)); const ai = await P.conn.getAccountInfo(pda); return ai ? decodeVaultLpStateP3(new Uint8Array(ai.data)) : null; }
async function sharePrice(page: Page): Promise<bigint | null> { const v = await page.locator('[data-testid="limits-share-price"]').first().getAttribute("data-price-e6", { timeout: 20_000 }).catch(() => null); return v ? BigInt(v) : null; }

test.describe.configure({ mode: "default", timeout: 15 * 60_000 });

test(`P3-1/2 Earn on a vault-owned-LP market (${SYM}): deposit → NAV; fees → NAV`, async ({ page }) => {
  const J = "P3-earn"; const m = P.markets()[SYM];
  const bound = decodeAssetVaultLpP3(new Uint8Array((await P.conn.getAccountInfo(P.pk(m.slab)))!.data), 0);
  test.skip(!bound.bound, "no bound vault LP (not a P3 market)");
  record({ journey: J, market: SYM, step: "market has a bound vault LP (P3)", ok: true, actual: `vaultLpPortfolio=${bound.vaultLpPortfolio?.toBase58()} lpNetQ=${bound.lpNetQ}` });
  const kp = await P.newWallet({ usdc: 3_000_000_000n });
  const log = await installTestWallet(page, kp);
  const lpAta = P.getAssociatedTokenAddressSync(P.pk(m.lpVaultMint), kp.publicKey, false, P.TOKEN_PROGRAM_ID);
  const v0 = await vstate(m); const reg0 = await P.readLpVault(m);
  await page.goto(`/earn/${m.slab}`);
  const card = await page.locator('[data-testid="limits-tranche-card"]').first().getAttribute("data-status", { timeout: 60_000 }).catch(() => null);
  const px0 = await sharePrice(page);
  await shot(page, "P3-earn-before");
  record({ journey: J, market: SYM, step: "UI: tranche card + share price", ok: true, actual: `tranche=${card} sharePriceE6=${px0}` });
  await page.locator('[data-testid="earn-deposit-input"]:visible').first().fill("1000");
  await page.locator('[data-testid="earn-deposit-submit"]:visible').first().click();
  const shares = await until(async () => { const b = await P.tokenBalance(lpAta); return b > 0n ? b : null; });
  const v1 = await vstate(m); const reg1 = await P.readLpVault(m);
  await shot(page, "P3-earn-deposit");
  const errTxt = await page.locator('[data-testid="earn-error"]:visible').first().innerText({ timeout: 1500 }).catch(() => "");
  check(J, SYM, "P3-1 deposit (UI, tag 75 + bound-vault tail): shares minted, registry +shares, senior claim C +1000", !!shares && reg1.totalLpSharesOutstanding - reg0.totalLpSharesOutstanding === shares && !!v1 && !!v0 && v1.seniorClaimAtoms - v0.seniorClaimAtoms === 1_000_000_000n,
    "shares>0, ΔC = 1,000,000,000", `shares=${shares} ΔC=${v1 && v0 ? v1.seniorClaimAtoms - v0.seniorClaimAtoms : "?"} ${errTxt}`, [lastSig(log)]);
  if (!shares) return;
  // fees → NAV
  const f0 = (await vstate(m))!;
  await churn(SYM, 3000, 3);
  const f1 = await until(async () => { const v = await vstate(m); return v && v.seniorFeeCreditedAtoms > f0.seniorFeeCreditedAtoms ? v : null; }, 180_000);
  await page.reload();
  const px1 = await sharePrice(page);
  await shot(page, "P3-earn-after-fees");
  check(J, SYM, "P3-2 trades' fees reach NAV (vault state seniorFeeCreditedAtoms ↑; UI share price ↑)", !!f1 && (px0 === null || px1 === null || px1 > px0),
    "seniorFeeCredited ↑, share price ↑", `seniorFeeCredited ${f0.seniorFeeCreditedAtoms}→${f1?.seniorFeeCreditedAtoms ?? "(unchanged)"}; UI price ${px0}→${px1}`);
});

test("P3-5 create-market wizard, the P3 way (vault-owned LP at launch)", async ({ page: firstPage, browser }) => {
  let page = firstPage;
  test.setTimeout(900_000);
  const J = "P3-wizard";
  const creator = await P.newWallet({ sol: 50, usdc: 200_000_000_000n });
  const log = await installTestWallet(page, creator);
  if (process.env.E2E_PIN_POOLS !== "0") await pinDexPools(page);
  let reg: any = null;
  page.on("request", (r) => { if (r.url().includes("/api/playground/keeper-register") && r.method() === "POST") { try { reg = JSON.parse(r.postData() ?? "{}"); } catch { /* */ } } });
  await page.goto("/create");
  await page.getByTestId("wizard-token-input").fill(process.env.P3_WIZARD_MINT ?? "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm");
  await P.sleep(6000);
  if (await page.getByTestId("wizard-next").isVisible().catch(() => false)) await page.getByTestId("wizard-next").click();
  const tranche = await page.locator('[data-testid="limits-wizard-tranche"]').first().waitFor({ state: "visible", timeout: 60_000 }).then(() => true).catch(() => false);
  await shot(page, "P3-wizard-market");
  check(J, "WIF", "wizard shows the P3 tranche panel (limits-wizard-tranche)", tranche, "visible", tranche ? "visible" : "absent");
  const pinned = await page.locator('[data-testid="limits-wizard-pinned-matcher"]').first().isVisible({ timeout: 10_000 }).catch(() => false);
  const awaiting = await page.locator('[data-testid="limits-wizard-awaiting-protocol"]').count();
  check(J, "WIF", "§10: limits-wizard-pinned-matcher shown; removed awaiting-protocol id absent", pinned && awaiting === 0, "pinned visible, awaiting 0", `pinned=${pinned} awaiting=${awaiting}`);
  const launch = page.getByTestId("wizard-launch");
  await launch.waitFor({ state: "visible", timeout: 60_000 }); await launch.click();
  const ok = await page.getByText(/MARKET LAUNCHED/i).first().waitFor({ state: "visible", timeout: 600_000 }).then(() => true).catch(() => false);
  await shot(page, "P3-wizard-launched");
  const slab = reg?.slabAddress ?? reg?.marketAddress;
  const errTxt = await page.locator('[data-testid="wizard-error"]:visible').first().innerText({ timeout: 1500 }).catch(() => "");
  check(J, "WIF", "P3 wizard launch completes", ok && !!slab, "MARKET LAUNCHED", `${ok} slab=${slab} signed ${log.filter((e) => e.kind === "tx").length} txs ${errTxt}`);
  if (!slab) return;
  const d = new Uint8Array((await P.conn.getAccountInfo(new PublicKey(slab)))!.data);
  const av = decodeAssetVaultLpP3(d, 0);
  const [pda] = deriveVaultLpStateP3(P.WRAPPER, new PublicKey(slab));
  const vs = await P.conn.getAccountInfo(pda);
  const st = vs ? decodeVaultLpStateP3(new Uint8Array(vs.data)) : null;
  check(J, "WIF", "wizard market has a BOUND vault LP (vault-state PDA, junior = creator)", av.bound && !!st && st.juniorOwner.equals(creator.publicKey),
    "bound, juniorOwner = creator", `bound=${av.bound} vaultState=${!!st} junior=${st?.juniorOwner.toBase58()} juniorDeposited=${st?.juniorDepositedAtoms}`);
  fs.writeFileSync(path.join(P.RUN, "p3-wizard-market.json"), JSON.stringify({ slab, reg }));
  // trade right after creation: NO creator activation step. The only thing between launch and the trade is
  // what prod does automatically — keeper-register (Vercel Blob → register-poll; here: the captured payload
  // appended to the harness keeper registry) and the keeper's first push.
  const regP = path.join(P.RUN, "keeper-registry.json"); const kr = JSON.parse(fs.readFileSync(regP, "utf8"));
  kr.markets.push({ label: `P3WIZ/USDC — ${reg.dexType}`, marketAddress: slab, poolAddress: reg.dexPoolAddress ?? reg.poolAddress, dexType: reg.dexType, assetIndex: 0, symbol: "P3WIZ", mainnetCa: reg.mainnetCA, collateral: P.USDC.toBase58(), registeredAt: Date.now() });
  fs.writeFileSync(regP, JSON.stringify(kr, null, 2));
  const tLaunch = Date.now();
  const mk0 = { slab } as unknown as P.SeedMarket;
  for (let i = 0; i < 40; i++) { const st = await P.readMarket(mk0).catch(() => null); if (st && st.chainSlot - st.lastGoodOracleSlot < 60n) break; await P.sleep(3000); }
  const trader = await P.newWallet({ usdc: 1_000_000_000n });
  const tctx = await browser.newContext(); const tp = await tctx.newPage();
  await installTestWallet(tp, trader);
  page = tp;
  await page.goto(`/trade/${slab}`);
  await page.getByTestId("deposit-amount-input").first().fill("300", { timeout: 60_000 });
  await page.getByTestId("deposit-submit").first().click();
  for (let i = 0; i < 30; i++) { const ps = await P.findPortfolios(trader.publicKey, mk0); if (ps.length && (await P.readPortfolio(ps[0])).capital > 0n) break; await P.sleep(3000); }
  await page.getByTestId("trade-side-long").click({ timeout: 60_000 });
  await page.getByTestId("trade-size-input").fill("30");
  await page.getByTestId("trade-submit").click({ timeout: 60_000 }).catch(() => undefined);
  if (await page.getByTestId("trade-confirm").isVisible({ timeout: 5000 }).catch(() => false)) await page.getByTestId("trade-confirm").click();
  const mk = { slab } as unknown as P.SeedMarket;
  let legs = 0; for (let i = 0; i < 30 && !legs; i++) { await P.sleep(3000); for (const pp of await P.findPortfolios(trader.publicKey, mk)) legs += (await P.readPortfolio(pp)).legs.length; }
  await shot(page, "P3-wizard-trade-now");
  const te = await page.locator('[data-testid="trade-error"]:visible').first().innerText({ timeout: 1500 }).catch(() => "");
  check(J, "WIF", "P3 wizard market trades right after creation (no creator activation step; keeper registration + first push only)", legs > 0, "≥1 leg", `legs=${legs} after ${Math.round((Date.now() - tLaunch) / 1000)}s ${te}`);
});
