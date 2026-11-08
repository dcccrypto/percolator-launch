/** M7: the confirm dialog carries its own "Spread / price impact" line; it never shows a zero spread as a fact. */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { TradeConfirmationModal } from "@/components/trade/TradeConfirmationModal";

vi.mock("gsap", () => ({ default: { fromTo: vi.fn() } }));

const base = {
  direction: "long" as const,
  positionSize: 223_463n,
  margin: 4_000_000n,
  leverage: 10,
  estimatedLiqPrice: 80_000_000n,
  tradingFee: 120_000n,
  symbol: "SOL",
  collateralSymbol: "USDC",
  decimals: 6,
  onConfirm: () => {},
  onCancel: () => {},
};

describe("TradeConfirmationModal spread line (M7)", () => {
  it("channel OFF (N-2): the estimate is information only: the fill books at the mark, so no extra cost is shown", () => {
    render(<TradeConfirmationModal {...base} spreadEstimate={{ kind: "quote", bps: 23, execPriceE6: 89_741_672n }} />);
    const row = screen.getByTestId("confirm-spread");
    expect(row).toHaveTextContent("Spread / price impact:");
    expect(row).toHaveTextContent("~0.23% (est., not charged on this market: fills settle at the mark)");
    expect(row.textContent).not.toMatch(/USDC/);
  });
  it("a range is shown as a range, with no cost either", () => {
    render(<TradeConfirmationModal {...base} spreadEstimate={{ kind: "range", minBps: 20, maxBps: 80 }} />);
    expect(screen.getByTestId("confirm-spread")).toHaveTextContent("0.20% to 0.80% (est. range, not charged on this market: fills settle at the mark)");
    expect(screen.getByTestId("confirm-spread").textContent).not.toMatch(/USDC|at least/);
  });
  it("NEGATIVE: with no estimate the row still exists and says so; it never shows 0.00%", () => {
    render(<TradeConfirmationModal {...base} />);
    const row = screen.getByTestId("confirm-spread");
    expect(row).toHaveTextContent(/not available before the trade/i);
    expect(row.textContent).not.toMatch(/0\.00%/);
  });
  it("M-3: on a fee-channel market the spread is said to be inside the Trading Fee and no second cost is shown", () => {
    render(<TradeConfirmationModal {...base} spreadEstimate={{ kind: "quote", bps: 23, execPriceE6: null, inFee: true }} />);
    const row = screen.getByTestId("confirm-spread");
    expect(row).toHaveTextContent("~0.23% (est., included in the trading fee)");
    expect(row.textContent).not.toMatch(/USDC/);
  });

  it("F1: channel ON but the ticket's fee estimate is base-only (P2 flag off): the fee row adds the requested bps (30 + 23 = 53 bps of the 40 USDC notional = 0.212), 'est.'", () => {
    render(<TradeConfirmationModal {...base} tradingFee={120_000n} tradingFeeEstimated={false} spreadEstimate={{ kind: "quote", bps: 23, execPriceE6: null, inFee: true }} />);
    expect(screen.getByText("Trading Fee (est.):")).toBeInTheDocument();
    expect(screen.getByText(/0\.212 USDC/)).toBeInTheDocument();
  });
  it("F1 CONTROL: the ticket's estimate already includes the extras: not added a second time", () => {
    render(<TradeConfirmationModal {...base} tradingFee={212_000n} tradingFeeEstimated spreadEstimate={{ kind: "quote", bps: 23, execPriceE6: null, inFee: true }} />);
    expect(screen.getByText(/0\.212 USDC/)).toBeInTheDocument();
    expect(screen.queryByText(/0\.304/)).toBeNull();
  });
});
