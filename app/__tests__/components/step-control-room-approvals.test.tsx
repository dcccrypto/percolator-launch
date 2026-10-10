/**
 * #67: the launch pre-flight said "Approvals: 1" while resuming. A fresh launch signs its batch in
 * one approval, but a resume always runs the remaining steps one by one (useCreateMarket: the
 * batch is "never a resume/retry").
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { StepControlRoom } from "@/components/create/StepControlRoom";

function renderStep(over: Record<string, unknown> = {}) {
  const props = {
    symbol: "TEST",
    oracleLabel: "Keeper (Pump.fun)",
    startPrice: "$0.004869",
    slabBytes: 26508,
    rentSol: 0.185,
    initialMarginBps: 2000,
    tradingFeeBps: 30,
    lpCollateral: "1000",
    insuranceAmount: "100",
    collateralSymbol: "USDC",
    seedTotal: 3100,
    seedBacking: 2000,
    onMarginBpsChange: vi.fn(),
    onLpCollateralChange: vi.fn(),
    onInsuranceChange: vi.fn(),
    onLaunch: vi.fn(),
    onBack: vi.fn(),
    ...over,
  };
  render(<StepControlRoom {...(props as never)} />);
}
const approvals = () => screen.getByText("Approvals").nextElementSibling?.textContent;

describe("pre-flight approvals", () => {
  it("a resume says one per transaction, not 1", () => {
    renderStep({ resuming: true });
    expect(approvals()).toBe("One per transaction");
  });

  it("CONTROL: a fresh launch still says 1", () => {
    renderStep();
    expect(approvals()).toBe("1");
  });
});
