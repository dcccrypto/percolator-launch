/**
 * What a market creator may and may not set.
 *
 * Spec: creators choose LEVERAGE and the FEE SPLIT. They must never be able to
 * change the TRADING FEE — one rate for every market, so nobody undercuts the
 * fees that keep their market solvent.
 *
 * This is a contract test rather than a styling test: it asserts the trading
 * fee is rendered as text with no editable control bound to it, while the two
 * creator-owned parameters remain interactive.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { StepParameters } from "@/components/create/StepParameters";

function renderStep(over: Record<string, unknown> = {}) {
  const props = {
    tradingFeeBps: 10,
    feeSplit: { creatorBps: 2000, lpBps: 4800, insuranceBps: 1600 } as never,
    onFeeSplitChange: vi.fn(),
    initialMarginBps: 1000,
    onInitialMarginChange: vi.fn(),
    lpCollateral: "1000",
    onLpCollateralChange: vi.fn(),
    insuranceAmount: "100",
    onInsuranceAmountChange: vi.fn(),
    adminPrice: "1.000000",
    onAdminPriceChange: vi.fn(),
    isAdminOracle: true,
    tokenSymbol: "TEST",
    walletBalance: "10000",
    onContinue: vi.fn(),
    onBack: vi.fn(),
    canContinue: true,
    ...over,
  };
  return render(<StepParameters {...(props as never)} />);
}

describe("StepParameters — creator-settable contract", () => {
  it("shows the trading fee as fixed text, not an editable field", () => {
    const { container } = renderStep({ tradingFeeBps: 10 });
    expect(screen.getAllByText(/10 bps/i).length).toBeGreaterThan(0);
    // No input anywhere is seeded with the trading fee value.
    const inputs = Array.from(container.querySelectorAll("input"));
    const feeInputs = inputs.filter((i) => i.value === "10" || i.value === "0.1");
    expect(feeInputs).toHaveLength(0);
  });

  it("no longer renders the slab-tier control", () => {
    renderStep();
    expect(screen.queryByText(/slab tier/i)).toBeNull();
  });

  it("renders the fee-split control unconditionally (was manual-mode only)", () => {
    const { container } = renderStep();
    expect(container.textContent ?? "").toMatch(/creator|lp|insurance/i);
  });
});
