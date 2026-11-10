/** Council r4 N7 / R3-13 on the real confirm dialog: both leverage figures explain themselves; no "cannot be undone"; a covered liq price reads in words. */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
vi.mock("@/hooks/useLockBodyScroll", () => ({ useLockBodyScroll: () => {} }));
vi.mock("gsap", () => ({ default: { set: () => {}, to: () => {}, fromTo: () => {}, killTweensOf: () => {} } }));

import { TradeConfirmationModal } from "@/components/trade/TradeConfirmationModal";
import { ORDER_LEVERAGE_TITLE, RISK_LEVERAGE_TITLE } from "@/lib/leverage-display";
import { liqPricePlainText } from "@/lib/liq-price-display";

const props = {
  direction: "long", positionSize: 1_000_000n, margin: 100_000_000n, leverage: 2, riskLeverage: 1.8,
  estimatedLiqPrice: 0n, tradingFee: 0n, worstFillPriceE6: 0n, accountEquity: 10_000_000n,
  symbol: "SOL", collateralSymbol: "USDC", decimals: 6, onConfirm: () => {}, onCancel: () => {},
} as unknown as Parameters<typeof TradeConfirmationModal>[0];

describe("confirm dialog copy", () => {
  it("does not say the trade cannot be undone", () => {
    render(<TradeConfirmationModal {...props} />);
    expect(document.body.textContent).not.toMatch(/cannot be undone/i);
    expect(document.body.textContent).toMatch(/close the position later/);
  });
  it("the two leverage tooltips say what each measures and why they differ", () => {
    expect(ORDER_LEVERAGE_TITLE).toMatch(/picked/);
    expect(RISK_LEVERAGE_TITLE).toMatch(/ALL the collateral/);
    expect(RISK_LEVERAGE_TITLE).toMatch(/differs from order leverage/);
  });
  it("a covered liq price reads in words, a real price is unchanged", () => {
    expect(liqPricePlainText({ kind: "covered", text: "110% mgn" })).toBe("None (fully covered)");
    expect(liqPricePlainText({ kind: "price", text: "$58.01" })).toBe("$58.01");
  });
});
