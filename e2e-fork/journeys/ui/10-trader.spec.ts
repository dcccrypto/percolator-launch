/**
 * U1 — UI trader journey, both sides, two markets:
 *   faucet (UI) → Start Trading (account + deposit) → Long|Short → partial close → full close → withdraw.
 * After every UI action the spec asserts ON-CHAIN state (wallet/vault balances, portfolio
 * capital + legs, fee counters, engine clock) — UI text is never the evidence.
 */
import { test, expect, type Page } from "@playwright/test";
import { installTestWallet, type SignLogEntry } from "../../wallet/inject.ts";
import * as P from "../../lib/perc.ts";
import { check, record } from "../../lib/results.ts";

async function waitChain<T>(fn: () => Promise<T | null | undefined | false>, ms = 60_000): Promise<T | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn().catch(() => null); if (v) return v as T; await P.sleep(1500); }
  return null;
}
async function shot(page: Page, name: string) { await page.screenshot({ path: `.run/shots/${name}.png`, fullPage: true }).catch(() => undefined); }
const lastSig = (log: SignLogEntry[]) => log.filter((e) => e.kind === "tx").at(-1)?.sig;

for (const [sym, side] of [["PENGU", "long"], ["BURNIE", "short"]] as const) {
  test(`U1 ${sym} ${side}: faucet → deposit → ${side} → partial → full close → withdraw`, async ({ page }) => {
    const J = "U1-ui-trader"; const tag = `${sym}:${side}`;
    const m = P.markets()[sym];
    const kp = await P.newWallet({ sol: 5 });
    const log = await installTestWallet(page, kp);

    // ── faucet (UI) ──
    await page.goto("/faucet");
    await page.getByRole("button", { name: /(get|claim|request|mint).*(usdc|test)|faucet/i }).first().click();
    const got = await waitChain(async () => ((await P.usdcBalance(kp.publicKey)) > 0n ? P.usdcBalance(kp.publicKey) : null), 60_000);
    await shot(page, `U1-${sym}-faucet`);
    check(J, tag, "faucet (UI): Sim-USDC landed in wallet", !!got && got > 0n, "> 0", `${got}`);
    if (!got) return;

    // ── deposit via Start Trading (testids: deposit-amount-input / deposit-submit) ──
    await page.goto(`/trade/${m.slab}`);
    const dep = 1000;
    await page.getByTestId("deposit-amount-input").first().fill(String(dep));
    await page.getByTestId("deposit-submit").first().click();
    const port = await waitChain(async () => (await P.findPortfolios(kp.publicKey, m))[0], 90_000);
    const p1 = port ? await waitChain(async () => { const p = await P.readPortfolio(port); return p.capital > 0n ? p : null; }, 60_000) : null;
    await shot(page, `U1-${sym}-deposit`);
    check(J, tag, "Start Trading (UI): portfolio created with deposited capital", !!p1 && p1.capital === BigInt(dep) * 1_000_000n, `${dep}e6`, `${p1?.capital}`, [lastSig(log) ?? ""]);
    if (!port || !p1) return;

    // ── open (trade-side-*, trade-size-input, trade-submit, trade-confirm) ──
    const s0 = await P.readMarket(m);
    await page.locator('[data-testid="trade-mode-tab"][data-mode="open"]').click().catch(() => undefined);
    await page.getByTestId(side === "long" ? "trade-side-long" : "trade-side-short").click();
    await page.getByTestId("trade-size-input").fill("200");
    await page.getByTestId("trade-submit").click();
    if (await page.getByTestId("trade-confirm").isVisible({ timeout: 5000 }).catch(() => false)) await page.getByTestId("trade-confirm").click();
    const p2 = await waitChain(async () => { const p = await P.readPortfolio(port); return p.legs.length ? p : null; }, 90_000);
    await shot(page, `U1-${sym}-open`);
    const s1 = await P.readMarket(m);
    const signOk = p2 && (side === "long" ? p2.legs[0].basisPosQ > 0n : p2.legs[0].basisPosQ < 0n);
    const notional = p2 ? Number(p2.legs[0].basisPosQ < 0n ? -p2.legs[0].basisPosQ : p2.legs[0].basisPosQ) * Number(s1.markE6) / 1e12 : 0;
    check(J, tag, `${side} (UI): one leg with correct sign, ~$200 notional`, !!signOk && notional > 150 && notional < 250, `${side}, ≈$200`, `${p2?.legs[0]?.basisPosQ} ≈ $${notional.toFixed(2)}`, [lastSig(log) ?? ""]);
    check(J, tag, `${side} (UI): fee counters moved (protocol/LP/insurance/creator)`,
      s1.fees.protocolAccrued > s0.fees.protocolAccrued && s1.fees.lpAccrued > s0.fees.lpAccrued && s1.fees.insReserveAccrued > s0.fees.insReserveAccrued && s1.fees.creatorClaimable > s0.fees.creatorClaimable,
      "all four +", `Δprot=${s1.fees.protocolAccrued - s0.fees.protocolAccrued} Δlp=${s1.fees.lpAccrued - s0.fees.lpAccrued} Δins=${s1.fees.insReserveAccrued - s0.fees.insReserveAccrued} Δcre=${s1.fees.creatorClaimable - s0.fees.creatorClaimable}`);
    check(J, tag, "engine clock tracks chain", s1.lag < 150n, "< 150", `${s1.lag}`);
    if (!p2) return;

    // ── partial close 50% (position-close → close-percent-chip[50] → close-confirm) ──
    await page.getByTestId("position-close").first().click();
    await page.locator('[data-testid="close-percent-chip"][data-percent="50"]').first().click();
    await page.getByTestId("close-confirm").click();
    const p3 = await waitChain(async () => { const p = await P.readPortfolio(port); return p.legs.length && p.legs[0].basisPosQ !== p2.legs[0].basisPosQ ? p : null; }, 90_000);
    await shot(page, `U1-${sym}-partial`);
    const half = p3 ? Number(p3.legs[0].basisPosQ) / Number(p2.legs[0].basisPosQ) : 0;
    check(J, tag, "partial close (UI, 50%): position ≈ halved", !!p3 && half > 0.45 && half < 0.55, "≈0.5", `${half.toFixed(3)} (${p3?.legs[0]?.basisPosQ})`, [lastSig(log) ?? ""]);

    // ── full close 100% ──
    await page.getByTestId("position-close").first().click();
    await page.locator('[data-testid="close-percent-chip"][data-percent="100"]').first().click();
    await page.getByTestId("close-confirm").click();
    const p4 = await waitChain(async () => { const p = await P.readPortfolio(port); return p.legs.length === 0 ? p : null; }, 90_000);
    await shot(page, `U1-${sym}-full-close`);
    check(J, tag, "full close (UI): 0 legs", !!p4, "0 legs", `${(await P.readPortfolio(port)).legs.length}`, [lastSig(log) ?? ""]);
    if (!p4) return;

    // ── withdraw everything (withdraw-toggle|withdraw-tab → withdraw-amount-input → withdraw-submit) ──
    const w0 = await P.usdcBalance(kp.publicKey);
    const wt = page.locator('[data-testid="withdraw-toggle"]:visible, [data-testid="withdraw-tab"]:visible').first();
    await wt.click();
    await page.locator('[data-testid="withdraw-amount-input"]:visible').first().fill((Number(p4.capital) / 1e6).toFixed(6));
    await page.locator('[data-testid="withdraw-submit"]:visible').first().click();
    const w1 = await waitChain(async () => { const w = await P.usdcBalance(kp.publicKey); return w > w0 ? w : null; }, 90_000);
    const p5 = await P.readPortfolio(port);
    await shot(page, `U1-${sym}-withdraw`);
    check(J, tag, "withdraw (UI): wallet credited with the full capital", !!w1 && w1 - w0 === p4.capital && p5.capital === 0n, `+${p4.capital}, capital 0`, `+${(w1 ?? w0) - w0}, capital ${p5.capital}`, [lastSig(log) ?? ""]);
    record({ journey: J, market: tag, step: "wallet signatures", ok: true, actual: `${log.filter((e) => e.kind === "tx").length} txs signed` });
    expect(p5.capital).toBe(0n);
  });
}
