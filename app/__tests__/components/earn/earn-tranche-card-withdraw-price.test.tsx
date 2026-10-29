/**
 * App bug 2026-10-29: during a price catch-up the tranche split's senior and the worse-of withdraw
 * price differ, so the card's "Share value" / "Your Earn balance" could disagree with the page's
 * Value and the withdraw quote. Given the withdraw pricing, the card uses it.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EarnTrancheCardView } from "@/components/limits/EarnTrancheCard";
import { earnPanelPricing, earnViewFromLimits } from "@/lib/limits/earn";
import { previewWithdrawAtoms } from "@/lib/limits/earn-withdraw";
import { marketLimits } from "../../lib/limits/fixtures";

const S = 1_000_000_000n;
const HELD = 100_000_000n;

describe("Earn tranche card prices like a withdrawal", () => {
  // A SHORT vault LP facing a pending +$0.10 move, pots below the claim: the exit is priced at target.
  const base = marketLimits();
  const limits = marketLimits({
    lp: { ...base.lp!, legs: [{ slot: 0, assetIndex: 0, side: 1, basisPosQ: -400_000_000n }] } as never,
    engine: { ...base.engine!, targetPriceE6: 1_100_000n } as never,
  });
  const backing = 900_000_000n;
  const view = earnViewFromLimits(limits, backing, HELD)!;
  const pricing = earnPanelPricing(limits, backing)!;

  it("the fixture is a catch-up where the two differ (sanity)", () => {
    expect(pricing.withdrawSeniorValue).not.toBeNull();
    expect(pricing.withdrawSeniorValue).not.toBe(view.senior);
  });

  it("Share value and Your Earn balance = the withdraw price", () => {
    render(<EarnTrancheCardView limits={limits} view={view} slab="x" withdrawShares={HELD} decimals={6} collateralSymbol="USDC" pricing={pricing} />);
    expect(screen.getByTestId("limits-share-price").getAttribute("data-price-e6")).toBe(((pricing.withdrawSeniorValue! * 1_000_000n) / S).toString());
    const yours = previewWithdrawAtoms(HELD, S, pricing.withdrawSeniorValue)!;
    expect(screen.getByTestId("earn-your-balance").textContent).toContain(`$${(Number(yours / 10_000n) / 100).toFixed(2)}`);
  });

  it("CONTROL: without pricing the card keeps the tranche split", () => {
    render(<EarnTrancheCardView limits={limits} view={view} slab="x" withdrawShares={HELD} decimals={6} collateralSymbol="USDC" />);
    expect(screen.getByTestId("limits-share-price").getAttribute("data-price-e6")).toBe(view.sharePriceE6!.toString());
  });
});
