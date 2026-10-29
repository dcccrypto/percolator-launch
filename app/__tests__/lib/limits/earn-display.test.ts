// @vitest-environment node
/**
 * App bug 2026-10-29 (product review finding 3, R1): on a BOUND vault (every leverage market) the
 * Earn "Value", "Earned", TVL and "Share value" were registry shares + distributed fees, so they
 * never went down after a loss, while the withdraw quote used the program's real senior price.
 * Every displayed figure now comes from the withdraw pricing (earnPanelPricing -> tags 75/77), so
 * Value always equals what withdrawing everything would pay.
 */
import { describe, expect, it } from "vitest";
import { earnPanelPricing } from "@/lib/limits/earn";
import { previewWithdrawAtoms } from "@/lib/limits/earn-withdraw";
import { earnDisplayFigures } from "@/lib/limits/earn-display";
import { computeLpEarnedForVault, type LpCostBasis } from "@/lib/lp-earned";
import { marketLimits } from "./fixtures";

const S = 1_000_000_000n; // registry shares (fixture)
const HELD = 100_000_000n; // the wallet's shares: 10% of the vault
// Shares + distributed fees: the old proxy (1,000 shares + 5 USDC of fees => 1.005 a share).
const proxyState = (over: Record<string, unknown> = {}) => ({
  bound: true,
  userLpBalance: HELD,
  pendingRedemptionShares: 0n,
  lpSupply: S,
  vaultTotalAtoms: S + 5_000_000n,
  vaultSharePriceE6: 1_005_000n,
  userVaultValueAtoms: (HELD * (S + 5_000_000n)) / S,
  splitPot: null,
  ...over,
});
const basis = (cost: bigint): LpCostBasis => ({ basisKnown: true, lpShares: HELD, costBasisAtoms: cost, realizedPnlAtoms: 0n });

describe("bound vault after a loss: every figure is the withdraw price", () => {
  // Backing pots down to 700 USDC against a 1,000 USDC senior claim: Earn has lost money.
  const pricing = earnPanelPricing(marketLimits(), 700_000_000n)!;

  it("the fixture really is a loss (sanity)", () => {
    expect(pricing.withdrawSeniorValue).not.toBeNull();
    expect(pricing.withdrawSeniorValue!).toBeLessThan(S);
  });

  it("Value == the withdraw preview for the whole position, and is below what the old proxy showed", () => {
    const d = earnDisplayFigures(proxyState(), pricing);
    const quote = previewWithdrawAtoms(HELD, pricing.totalShares, pricing.withdrawSeniorValue);
    expect(d.userValueAtoms).toBe(quote);
    expect(d.userValueAtoms!).toBeLessThan(HELD); // went down
    expect(d.userValueAtoms!).toBeLessThan(proxyState().userVaultValueAtoms as bigint);
  });

  it("Share value and TVL go down too (senior value over registry shares)", () => {
    const d = earnDisplayFigures(proxyState(), pricing);
    expect(d.tvlAtoms).toBe(pricing.withdrawSeniorValue);
    expect(d.sharePriceE6).toBe((pricing.withdrawSeniorValue! * 1_000_000n) / S);
    expect(d.sharePriceE6!).toBeLessThan(1_000_000n);
    expect(d.totalShares).toBe(S);
  });

  it("escrowed (pending-withdrawal) shares are still valued at the same price", () => {
    const d = earnDisplayFigures(proxyState({ userLpBalance: 60_000_000n, pendingRedemptionShares: 40_000_000n }), pricing);
    expect(d.userValueAtoms).toBe(previewWithdrawAtoms(HELD, S, pricing.withdrawSeniorValue));
  });

  it("Earned is negative after the loss, and is Value minus cost basis", () => {
    const e = computeLpEarnedForVault(basis(HELD), proxyState(), pricing);
    expect(e.kind).toBe("exact");
    if (e.kind !== "exact") return;
    const value = previewWithdrawAtoms(HELD, S, pricing.withdrawSeniorValue)!;
    expect(e.earnedAtoms).toBe(value - HELD);
    expect(e.earnedAtoms).toBeLessThan(0n);
  });
});

describe("bound vault in profit: figures go up with the senior value", () => {
  it("a junior surplus + fees keeps Earn whole; Value tracks the senior claim, not shares + fees", () => {
    const pricing = earnPanelPricing(marketLimits(), 1_500_000_000n)!;
    const d = earnDisplayFigures(proxyState(), pricing);
    expect(d.userValueAtoms).toBe(previewWithdrawAtoms(HELD, S, pricing.withdrawSeniorValue));
    expect(d.userValueAtoms!).toBeGreaterThanOrEqual(HELD);
  });
});

describe("bound vault with no program price: unknown, never the shares + fees proxy", () => {
  it("pricing null (limits not read yet) => every figure null", () => {
    const d = earnDisplayFigures(proxyState(), null);
    expect(d).toMatchObject({ tvlAtoms: null, sharePriceE6: null, userValueAtoms: null });
  });

  it("withdraw price null (stale certificate, no simulation yet) => every figure null; Earned unavailable", () => {
    const pricing = { totalShares: S, depositSeniorValue: null, withdrawSeniorValue: null, maxNowAtoms: null };
    expect(earnDisplayFigures(proxyState(), pricing)).toMatchObject({ tvlAtoms: null, sharePriceE6: null, userValueAtoms: null });
    expect(computeLpEarnedForVault(basis(HELD), proxyState(), pricing)).toEqual({ kind: "unavailable", reason: "unpriced" });
  });

  it("no shares held => Value is 0 (known), not unknown", () => {
    const pricing = earnPanelPricing(marketLimits(), 700_000_000n)!;
    expect(earnDisplayFigures(proxyState({ userLpBalance: 0n }), pricing).userValueAtoms).toBe(0n);
  });
});

describe("settled (resolved) bound market", () => {
  it("figures follow the resolved payout (the tranche split), and still equal the withdraw preview", () => {
    const base = marketLimits();
    const resolved = marketLimits({ engine: { ...base.engine!, mode: 1 } });
    const pricing = earnPanelPricing(resolved, 700_000_000n)!;
    expect(pricing.withdrawSeniorValue).not.toBeNull();
    const d = earnDisplayFigures(proxyState(), pricing);
    expect(d.userValueAtoms).toBe(previewWithdrawAtoms(HELD, S, pricing.withdrawSeniorValue));
    expect(d.userValueAtoms!).toBeLessThan(HELD);
    expect(d.tvlAtoms).toBe(pricing.withdrawSeniorValue);
  });
});

describe("non-bound vaults are unchanged", () => {
  it("two-pot vault: its NAV figures pass through (already the program's price)", () => {
    const st = proxyState({ bound: false, vaultTotalAtoms: 487_740_000n, vaultSharePriceE6: 243_870n, userVaultValueAtoms: 24_387_000n, splitPot: { totalShares: 2_000_000_000n } });
    expect(earnDisplayFigures(st, null)).toEqual({ totalShares: 2_000_000_000n, tvlAtoms: 487_740_000n, sharePriceE6: 243_870n, userValueAtoms: 24_387_000n });
  });

  it("legacy registry (not bound, no pots): shares + fees, as before", () => {
    const st = proxyState({ bound: false });
    expect(earnDisplayFigures(st, null)).toEqual({ totalShares: S, tvlAtoms: S + 5_000_000n, sharePriceE6: 1_005_000n, userValueAtoms: st.userVaultValueAtoms });
    const e = computeLpEarnedForVault(basis(HELD), st);
    expect(e.kind === "exact" && e.earnedAtoms).toBe(500_000n);
  });
});
