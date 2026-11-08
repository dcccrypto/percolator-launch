/** M7: the close dialog carries its own "Spread / price impact" line and the balance preview pays for it. */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "@testing-library/jest-dom";
import { ClosePositionForm } from "@/components/trade/ClosePositionForm";

const USDC = 1_000_000n;
// 40 units at $1.00: entry = mark, so PnL is 0 and the balance moves by fee + spread only.
const props = {
  positionSize: 40n * USDC,
  entryPrice: 1_000_000n,
  currentPrice: 1_000_000n,
  capital: 44n * USDC,
  symbol: "TEST",
  collateralSymbol: "USDC",
  decimals: 6,
  priceUsd: 1,
  isLong: true,
  loading: false,
  tradingFeeBps: 30n,
  onConfirm: () => {},
};

describe("ClosePositionForm spread line (M7)", () => {
  it("CONTROL: with no estimate the row says it is unavailable (never 0%) and the balance is capital - fee", () => {
    render(<ClosePositionForm {...props} />);
    expect(screen.getByTestId("close-spread")).toHaveTextContent(/not available before the trade/i);
    expect(screen.getByTestId("close-spread").textContent).not.toMatch(/0\.00%/);
    expect(screen.getByText(/43\.88/)).toBeInTheDocument(); // 44 - 0.12
  });
  it("with a 23 bps estimate: the row shows it and Est. Account Balance After is lower by that cost", () => {
    const asked: Array<[bigint, boolean]> = [];
    render(<ClosePositionForm {...props} spreadEstimateFor={(q, buys) => { asked.push([q, buys]); return { kind: "quote", bps: 23, execPriceE6: null }; }} />);
    expect(screen.getByTestId("close-spread")).toHaveTextContent("Spread / price impact:");
    expect(screen.getByTestId("close-spread")).toHaveTextContent("~0.23% (est.)");
    expect(screen.getByTestId("close-spread")).toHaveTextContent("−0.092 USDC");
    expect(screen.getByText(/43\.788/)).toBeInTheDocument(); // 44 - 0.12 - 0.092
    // Closing a LONG sells: the taker does not buy.
    expect(asked.every(([, buys]) => buys === false)).toBe(true);
    expect(asked.some(([q]) => q === 40n * USDC)).toBe(true);
  });
  it("closing a SHORT asks for a buy", () => {
    const asked: boolean[] = [];
    render(<ClosePositionForm {...props} positionSize={-40n * USDC} isLong={false} spreadEstimateFor={(_q, buys) => { asked.push(buys); return null; }} />);
    expect(asked.every((b) => b === true)).toBe(true);
  });
});
