/**
 * U2 Earn (UI): deposit → fees accrue (chain churn) → keeper tag 78 → withdraw request → execute (claim)
 * U3 Stake (UI): deposit → fees → keeper tag 87 + AccrueFees → withdraw
 * U4 Creator fee claim (UI): creator-claim-button, as the market's creator (sandbox throwaway key)
 * Every step asserts on-chain state.
 */
import { test, type Page } from "@playwright/test";
import { installTestWallet, type SignLogEntry } from "../../wallet/inject.ts";
import * as P from "../../lib/perc.ts";
import { check, record } from "../../lib/results.ts";
import { churn } from "../chain/products.ts";

async function waitChain<T>(fn: () => Promise<T | null | undefined | false>, ms = 90_000): Promise<T | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn().catch(() => null); if (v) return v as T; await P.sleep(2000); }
  return null;
}
const shot = (page: Page, n: string) => page.screenshot({ path: `.run/shots/${n}.png`, fullPage: true }).catch(() => undefined);
const lastSig = (log: SignLogEntry[]) => log.filter((e) => e.kind === "tx").at(-1)?.sig ?? "";
const vis = (page: Page, id: string) => page.locator(`[data-testid="${id}"]:visible`).first();

test("U2 Earn (UI): deposit → fees → keeper crank → withdraw request → execute", async ({ page }) => {
  const J = "U2-ui-earn"; const sym = "JUP"; const m = P.markets()[sym];
  const kp = await P.newWallet({ usdc: 3_000_000_000n });
  const log = await installTestWallet(page, kp);
  const lpAta = P.getAssociatedTokenAddressSync(P.pk(m.lpVaultMint), kp.publicKey, false, P.TOKEN_PROGRAM_ID);
  const reg0 = await P.readLpVault(m);
  await page.goto(`/earn/${m.slab}`);
  await vis(page, "earn-deposit-input").fill("1000");
  await vis(page, "earn-deposit-submit").click();
  const shares = await waitChain(async () => { const b = await P.tokenBalance(lpAta); return b > 0n ? b : null; });
  const reg1 = await P.readLpVault(m);
  await shot(page, "U2-earn-deposit");
  check(J, sym, "deposit (UI): LP shares minted, registry +shares", !!shares && reg1.totalLpSharesOutstanding - reg0.totalLpSharesOutstanding === shares, "shares>0", `${shares}`, [lastSig(log)]);
  if (!shares) return;
  await churn(sym, 3000, 2);
  const s0 = await P.readMarket(m);
  const cranked = await waitChain(async () => { const s = await P.readMarket(m); return s.fees.lpWithdrawn >= s0.fees.lpAccrued ? s : null; }, 120_000);
  check(J, sym, "keeper tag 78 credited LP fees into the vault", !!cranked, `lpWithdrawn ≥ ${s0.fees.lpAccrued}`, `${cranked?.fees.lpWithdrawn}`);
  // request
  await page.reload();
  await page.locator('[data-testid="earn-tab"][data-tab="withdraw"]:visible').first().click();
  await vis(page, "earn-withdraw-input").fill((Number(shares) / 1e6).toString());
  await vis(page, "earn-withdraw-request").click();
  const confirmReq = page.getByRole("button", { name: /^Confirm Request$/ });
  if (await confirmReq.isVisible({ timeout: 5000 }).catch(() => false)) await confirmReq.click();
  const escrowed = await waitChain(async () => ((await P.tokenBalance(lpAta)) === 0n ? true : null));
  await shot(page, "U2-earn-request");
  check(J, sym, "withdraw request (UI): shares escrowed (tag 76)", !!escrowed, "wallet LP 0", `${await P.tokenBalance(lpAta)}`, [lastSig(log)]);
  // execute after cooldown
  await P.advanceSlots(Number(reg1.redemptionCooldownSlots) + 3);
  const w0 = await P.usdcBalance(kp.publicKey);
  await page.reload();
  await page.locator('[data-testid="earn-tab"][data-tab="withdraw"]:visible').first().click().catch(() => undefined);
  await vis(page, "earn-withdraw-execute").click();
  const w1 = await waitChain(async () => { const w = await P.usdcBalance(kp.publicKey); return w > w0 ? w : null; }, 120_000);
  await shot(page, "U2-earn-execute");
  const errTxt = await page.locator('[data-testid="earn-error"]:visible').first().innerText({ timeout: 2000 }).catch(() => "");
  check(J, sym, "execute (UI, tag 77): paid principal + fee share", !!w1 && w1 - w0 > 1_000_000_000n, "> 1000 USDC", `+${(w1 ?? w0) - w0} ${errTxt}`, [lastSig(log)]);
});

test("U3 Stake (UI): deposit → fees → keeper 87 + AccrueFees → withdraw", async ({ page }) => {
  const J = "U3-ui-stake"; const sym = "SOL"; const m = P.markets()[sym];
  const kp = await P.newWallet({ usdc: 3_000_000_000n });
  const log = await installTestWallet(page, kp);
  const lpAta = P.getAssociatedTokenAddressSync(P.pk(m.stakeLpMint), kp.publicKey, false, P.TOKEN_PROGRAM_ID);
  await page.goto("/stake");
  await page.getByRole("button", { name: /^SOL-PERP/ }).first().click();
  await vis(page, "stake-tab-deposit").click().catch(() => undefined);
  await vis(page, "stake-deposit-input").fill("1000");
  await vis(page, "stake-deposit-submit").click();
  const lp = await waitChain(async () => { const b = await P.tokenBalance(lpAta); return b > 0n ? b : null; });
  await shot(page, "U3-stake-deposit");
  check(J, sym, "deposit (UI): stake LP minted", !!lp, "> 0", `${lp}`, [lastSig(log)]);
  if (!lp) return;
  const pool1 = await P.readStakePool(m);
  await churn(sym, 3000, 2);
  const mk0 = await P.readMarket(m);
  const pushed = await waitChain(async () => {
    const [mk, pl] = await Promise.all([P.readMarket(m), P.readStakePool(m)]);
    return mk.fees.insReserveWithdrawn >= mk0.fees.insReserveAccrued && pl.totalFeesEarned > pool1.totalFeesEarned ? pl : null;
  }, 150_000);
  check(J, sym, "keeper 87 + stake AccrueFees booked the staker leg", !!pushed, `> ${pool1.totalFeesEarned}`, `${pushed?.totalFeesEarned}`);
  await page.reload();
  await page.getByRole("button", { name: /^SOL-PERP/ }).first().click();
  await vis(page, "stake-tab-withdraw").click();
  await vis(page, "stake-withdraw-input").fill((Number(lp) / 1e6).toString());
  const w0 = await P.usdcBalance(kp.publicKey);
  await vis(page, "stake-withdraw-submit").click();
  const w1 = await waitChain(async () => { const w = await P.usdcBalance(kp.publicKey); return w > w0 ? w : null; }, 90_000);
  await shot(page, "U3-stake-withdraw");
  const errTxt = await page.locator('[data-testid="stake-error"]:visible').first().innerText({ timeout: 2000 }).catch(() => "");
  check(J, sym, "withdraw (UI): principal + staker fee share", !!w1 && w1 - w0 > 1_000_000_000n - 2_000n, "≥ ~1000 USDC", `+${(w1 ?? w0) - w0} ${errTxt}`, [lastSig(log)]);
});

test("U4 creator fee claim (UI)", async ({ page }) => {
  const J = "U4-ui-creator-fee"; const sym = "TRUMP"; const m = P.markets()[sym];
  await churn(sym, 2000, 1);
  const before = (await P.readMarket(m)).fees.creatorClaimable;
  const log = await installTestWallet(page, P.admin); // the sandbox creator/asset_admin (throwaway)
  const dest = P.getAssociatedTokenAddressSync(P.USDC, P.admin.publicKey, false, P.TOKEN_PROGRAM_ID);
  const b0 = await P.tokenBalance(dest);
  const seenOn: string[] = [];
  for (const url of ["/my-markets", `/analytics/${m.slab}`]) {
    await page.goto(url);
    const ok = await page.locator('[data-testid="creator-claim-button"]:visible').first().waitFor({ state: "visible", timeout: 30_000 }).then(() => true).catch(() => false);
    await shot(page, `U4-creator-${url.split("/")[1]}`);
    record({ journey: J, market: sym, step: `creator-claim-button on ${url.replace(m.slab, "<slab>")}`, ok: true, actual: ok ? "visible" : "absent" });
    if (ok) { seenOn.push(url); break; }
  }
  await shot(page, "U4-creator-before");
  const btn = page.locator('[data-testid="creator-claim-button"]:visible').first();
  if (!(await btn.isVisible().catch(() => false))) { record({ journey: J, market: sym, step: "creator-claim-button visible to the creator", ok: false, actual: `not found on /my-markets or /trade (claimable ${before})` }); return; }
  await btn.click();
  const b1 = await waitChain(async () => { const b = await P.tokenBalance(dest); return b > b0 ? b : null; });
  const after = (await P.readMarket(m)).fees.creatorClaimable;
  await shot(page, "U4-creator-after");
  check(J, sym, "claim (UI, tag 90): creator ATA +claimable, counter → 0", !!b1 && b1 - b0 >= before && after === 0n, `+${before}, 0`, `+${(b1 ?? b0) - b0}, ${after}`, [lastSig(log)]);
});
