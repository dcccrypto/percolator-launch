/**
 * r8 Council: the close dialogs lead with the NET result (mark-to-market PnL from the fill entry, less the closing fee incl. spread). The gross
 * line is secondary. "Profit becomes withdrawable" shows only for a positive net; the loading fee estimate shows no optimistic number.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "@testing-library/jest-dom";
import { ClosePositionForm } from "@/components/trade/ClosePositionForm";
import type { SpreadEstimate } from "@/lib/v22/spread-estimate";

const USDC = 1_000_000n;
const props = {
  positionSize: 1_000n * USDC, // 1,000 units
  entryPrice: 1_000_000n,
  currentPrice: 1_000_000n,
  capital: 500n * USDC,
  symbol: "TEST",
  collateralSymbol: "USDC",
  decimals: 6,
  priceUsd: 1,
  isLong: true,
  loading: false,
  tradingFeeBps: 30n,
  onConfirm: () => {},
};
const loaded = (): SpreadEstimate => ({ kind: "quote", bps: 70, execPriceE6: null, inFee: true });

describe("close dialog: net result after closing fees", () => {
  it("a long whose mark is just above the entry but whose closing fee exceeds the gain: negative net, red, no profit line", () => {
    // gross +1.00 (1,000 x +0.1%), fee 100 bps of 1,001 = 10.01 -> net -9.01
    render(<ClosePositionForm {...props} currentPrice={1_001_000n} spreadEstimateFor={loaded} closeFeeBpsFor={() => 100n} />);
    const net = screen.getByTestId("close-net-result");
    expect(net).toHaveAttribute("data-sign", "negative");
    expect(net.textContent).toMatch(/^-9\.0\d+ USDC/);
    expect(net.className).toContain("--short");
    expect(screen.getByText("Est. result if closed now:")).toBeInTheDocument();
    expect(screen.getByText("Est. PnL (before closing fees):")).toBeInTheDocument();
    expect(screen.getByTestId("close-gross-pnl").textContent).toMatch(/^\+1 USDC/);
    expect(screen.getByTestId("close-gross-pnl").className).not.toContain("--long");
    expect(screen.queryByTestId("close-profit-settles")).toBeNull();
  });

  it("a clear winner: positive net, green, with the profit line", () => {
    // gross +100, fee (30 base + 70 spread) bps of 1,100 = 11 -> net +89
    render(<ClosePositionForm {...props} currentPrice={1_100_000n} spreadEstimateFor={loaded} />);
    const net = screen.getByTestId("close-net-result");
    expect(net).toHaveAttribute("data-sign", "positive");
    expect(net.textContent).toMatch(/^\+89 USDC/);
    expect(net.className).toContain("--long");
    expect(screen.getByTestId("close-profit-settles")).toBeInTheDocument();
  });

  it("loading: the fee estimate has not answered, so no net figure (and no profit line) is shown", () => {
    render(<ClosePositionForm {...props} currentPrice={1_100_000n} spreadEstimateFor={() => null} />);
    expect(screen.queryByTestId("close-net-result")).toBeNull();
    expect(screen.getByTestId("close-net-loading").textContent).toBe("--");
    expect(screen.queryByTestId("close-profit-settles")).toBeNull();
  });

  it("an unknown entry shows no net figure", () => {
    render(<ClosePositionForm {...props} entryPrice={0n} spreadEstimateFor={loaded} />);
    expect(screen.queryByTestId("close-net-result")).toBeNull();
    expect(screen.getByTestId("close-net-unknown")).toBeInTheDocument();
  });
});
